import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { configSchema, userIdSchema } from '@spur-board/contracts';
import {
  commandRetention,
  createObservationCore,
  createOperationRegistry,
  openStore,
  type Store,
} from '@spur-board/core';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { runCli, type CliIo } from '../../cli/src/cli.ts';
import { createBoardModules } from '../src/board-modules.ts';
import { createHttpModule } from '../src/http-module.ts';
import { createInboundModule } from '../src/inbound-module.ts';
import { runDaemon, type ModuleEntry, type ProcessPort } from '../src/lifecycle.ts';
import { createOutboxModule } from '../src/outbox-module.ts';

const START = Date.parse('2026-11-04T08:00:00.000Z');
const TASK_KEY = 'PROJ-123';
const SESSION = 'worker-session';
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'example/repo', milestone: 'M1' },
      repos: ['example/repo'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  http: { port: 0 },
});

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function createE2eHarness() {
  const home = mkdtempSync(join(tmpdir(), 'board-e2e-'));
  const paths = {
    configFile: join(home, 'config.yaml'),
    secretsFile: join(home, 'secrets.env'),
    dbFile: join(home, 'board.sqlite'),
    lockFile: join(home, 'board.lock'),
  };
  const gateway = createFakeGateway({ profile: 'slack-like', start: new Date(START) });
  const clock = { now: () => gateway.platform.now().getTime() };
  const sends: { session: string; text: string }[] = [];
  const seeded = openStore(paths.dbFile);
  try {
    await seeded.transaction(async (trx) => {
      const at = new Date(START).toISOString();
      await trx
        .insertInto('task')
        .values({
          project: 'proj',
          tracker_kind: 'github-issues',
          tracker_id: '123',
          key: TASK_KEY,
          membership: 'active',
          archive_reason: null,
          column: 'dev',
          shadow_column: null,
          created_at: at,
          last_change_at: null,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
      await trx
        .insertInto('session_snapshot')
        .values({
          id: SESSION,
          spur_project: 'worker',
          branch: 'work',
          pr: null,
          raw_state: 'running',
          state: 'running',
          first_seen: at,
          last_seen: at,
          ended_at: null,
          end_reason: null,
          detail: '{}',
          source: 'spur',
          observed_at: at,
        })
        .execute();
      await trx
        .insertInto('link')
        .values({
          task_id: 1,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: SESSION,
          role: 'worker',
          source: 'manual',
          created_at: at,
        })
        .execute();
    });
  } finally {
    await seeded.close();
  }

  let store: Store | undefined;
  let outbox: ReturnType<typeof createOutboxModule> | undefined;
  let address: string | undefined;
  let signal: ((name: string) => void) | undefined;
  let exited: Promise<number> | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  let crashNext = false;

  async function start(): Promise<void> {
    exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const port: ProcessPort = {
      onSignal(handler) {
        signal = handler;
      },
      onFatal() {},
      exit(code) {
        resolveExit?.(code);
      },
      writeErr(text) {
        throw new Error(text);
      },
    };
    await runDaemon<Store>({
      paths,
      acquireLock: () => ({ release() {} }),
      loadConfig: () => ({ config, secrets: {} }),
      openStore: (file) => {
        store = openStore(file);
        return store;
      },
      modules: (ctxFor) => {
        const board = ctxFor('board-core');
        const core = createObservationCore({
          store: board.store,
          config: board.config,
          clock: board.clock,
        });
        const registry = createOperationRegistry({
          config: board.config,
          clock: board.clock,
          completeSince: core.completeSince,
        });
        const commands = ctxFor('commands');
        const entries: ModuleEntry[] = [
          {
            name: 'commands',
            stopStage: 'final',
            module: commandRetention({
              store: commands.store,
              clock: commands.clock,
              retentionDays: commands.config.commands.retentionDays,
              onError: (err) => {
                commands.log.error({ err }, 'command purge failed');
              },
            }),
          },
        ];
        entries.push(
          ...createBoardModules(ctxFor, {
            core,
            tick: () => Promise.resolve(),
            startAdapters: () => ({ stop: () => Promise.resolve() }),
          }),
        );
        const inbound = createInboundModule(ctxFor('inbound'), gateway, registry);
        entries.push({
          name: 'gateway-slack',
          stopStage: 'final',
          module: {
            start: () => gateway.start((event) => inbound.sink(event)),
            async stop() {
              try {
                await gateway.stop();
              } finally {
                await inbound.stop();
              }
            },
          },
        });
        entries.push({ name: 'inbound', stopStage: 'pollers', module: inbound });
        outbox = createOutboxModule(ctxFor('outbox'), gateway, {
          spur: {
            send(session, text) {
              sends.push({ session, text });
              return Promise.resolve();
            },
          },
        });
        entries.push({ name: 'outbox', stopStage: 'outbox', module: outbox });
        entries.push({
          name: 'http',
          stopStage: 'final',
          module: createHttpModule(ctxFor('http'), {
            registry,
            fetcher: () => Promise.reject(new Error('unexpected live session lookup')),
            onListening: (bound) => {
              address = bound;
            },
            afterOperation: (response: ServerResponse) => {
              if (crashNext) {
                crashNext = false;
                response.destroy();
              }
            },
          }),
        });
        return entries;
      },
      port,
      stdout: { write() {} },
      clock,
      shutdownTimeoutMs: 5_000,
    });
    if (address === undefined) throw new Error('Daemon did not bind HTTP');
  }

  async function stop(): Promise<void> {
    if (signal === undefined || exited === undefined) return;
    signal('SIGTERM');
    const code = await exited;
    if (code !== 0) throw new Error(`Daemon stopped with code ${String(code)}`);
    signal = undefined;
    outbox = undefined;
  }

  async function cli(args: string[]): Promise<CliResult> {
    if (address === undefined) throw new Error('Daemon has not bound HTTP');
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      isTTY: false,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };
    const code = await runCli(args, {
      env: { SPUR_SESSION: SESSION },
      io,
      clientConfig: {
        address: new URL(address),
        session: SESSION,
        token: undefined,
        connectTimeoutMs: 200,
        responseTimeoutMs: 200,
      },
    });
    return { code, stdout, stderr };
  }

  async function pulse(): Promise<void> {
    if (outbox === undefined) throw new Error('Outbox is not running');
    await outbox.pulse();
  }

  async function dispose(): Promise<void> {
    await stop();
    rmSync(home, { recursive: true, force: true });
  }

  return {
    start,
    stop,
    dispose,
    cli,
    pulse,
    gateway,
    sends,
    advance: (ms: number) => {
      gateway.platform.advance(ms);
    },
    dropNextResponse: () => {
      crashNext = true;
    },
    get store(): Store {
      if (store === undefined) throw new Error('Store is not open');
      return store;
    },
    get address(): string {
      if (address === undefined) throw new Error('Address is not known');
      return address;
    },
    taskKey: TASK_KEY,
    session: SESSION,
    operator: userIdSchema.parse('operator'),
  };
}
