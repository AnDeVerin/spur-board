import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { startAdapters as realStartAdapters } from '@spur-board/adapters';
import { configSchema, userIdSchema } from '@spur-board/contracts';
import { openStore, type Store } from '@spur-board/core';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { runCli, type CliIo } from '../../cli/src/cli.ts';
import { startInProcessDaemon, type InProcessDaemon } from '../src/in-process.ts';

const START = Date.parse('2026-11-04T08:00:00.000Z');
const TASK_KEY = 'PROJ-123';
const SESSION = 'worker-session';
const OPERATOR_TOKEN = 'e2e-operator-token';
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

export async function createE2eHarness(
  options: {
    /** Replaces the default runner, which polls nothing and has no `pollPr`. */
    startAdapters?: typeof realStartAdapters;
  } = {},
) {
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
          // Valid facts: status.get parses every linked session's detail.
          detail: JSON.stringify({
            id: SESSION,
            spurProject: 'worker',
            branch: 'work',
            pr: null,
            links: {},
            lifecycle: 'running',
            health: 'working',
            healthSince: at,
            lastActivityAt: null,
            endedAt: null,
            endReason: null,
          }),
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
      // An approved operator token whose request item is already cleared, so no feed line waits.
      const item = await trx
        .insertInto('operator_item')
        .values({
          item_key: 'token:e2e',
          raise_no: 1,
          kind: 'token_request',
          text: 'Approve operator token e2e',
          url: '',
          task_id: null,
          block_id: null,
          raised_at: at,
          cleared_at: at,
          line_outbox_id: null,
          fingerprint: null,
          fact_at: null,
          source: null,
          priority: null,
          inbound_event_json: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('operator_token')
        .values({
          name: 'e2e',
          hash: createHash('sha256').update(OPERATOR_TOKEN).digest('hex'),
          folder: 'workspace/e2e',
          host: 'local',
          status: 'approved',
          requested_at: at,
          expires_at: at,
          decided_at: at,
          item_id: item.id,
        })
        .execute();
    });
  } finally {
    await seeded.close();
  }

  let store: Store | undefined;
  let outbox: InProcessDaemon['outbox'] | undefined;
  let inbound: InProcessDaemon['inbound'] | undefined;
  let address: string | undefined;
  let handle: InProcessDaemon | undefined;
  let crashNext = false;

  async function start(): Promise<void> {
    handle = await startInProcessDaemon({
      paths,
      acquireLock: () => ({ release() {} }),
      loadConfig: () => ({ config, secrets: {} }),
      writeErr(text) {
        throw new Error(text);
      },
      ports: {
        gateway,
        spur: {
          send(session, text) {
            sends.push({ session, text });
            return Promise.resolve();
          },
        },
        tick: () => Promise.resolve(),
        startAdapters: options.startAdapters ?? (() => ({ stop: () => Promise.resolve() })),
        sessionFetcher: () => Promise.reject(new Error('unexpected live session lookup')),
        afterOperation: (response: ServerResponse) => {
          if (crashNext) {
            crashNext = false;
            response.destroy();
            void handle?.stop();
          }
        },
      },
      stdout: { write() {} },
      clock,
      shutdownTimeoutMs: 5_000,
    });
    store = handle.store;
    address = handle.address;
    inbound = handle.inbound;
    outbox = handle.outbox;
    await gateway.platform.settle();
    await inbound?.awaitRecovery();
  }

  async function stop(): Promise<void> {
    if (handle === undefined) return;
    const code = await handle.stop();
    if (code !== 0) throw new Error(`Daemon stopped with code ${String(code)}`);
    handle = undefined;
    outbox = undefined;
    inbound = undefined;
  }

  /** Runs as the worker session; `operator` runs with the operator token instead. */
  async function cli(
    args: string[],
    options: { operator?: boolean; tty?: boolean } = {},
  ): Promise<CliResult> {
    if (address === undefined) throw new Error('Daemon has not bound HTTP');
    const operator = options.operator ?? false;
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      isTTY: options.tty ?? false,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };
    const code = await runCli(args, {
      // A session header wins over a token, so operator mode sends none.
      env: operator ? {} : { SPUR_SESSION: SESSION },
      io,
      clientConfig: {
        address: new URL(address),
        session: operator ? undefined : SESSION,
        token: operator ? OPERATOR_TOKEN : undefined,
        connectTimeoutMs: 200,
        // An ask may scan and replay its outbox write before returning under CI load.
        responseTimeoutMs: 2_000,
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
    taskKey: TASK_KEY,
    dbFile: paths.dbFile,
    session: SESSION,
    operator: userIdSchema.parse('operator'),
  };
}
