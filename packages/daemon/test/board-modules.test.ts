import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  configSchema,
  ok,
  userIdSchema,
  type AcceptedObservation,
  type InboundEvent,
} from '@spur-board/contracts';
import {
  startAdapters,
  type AdapterCore,
  type AdapterRunner,
  type StartAdaptersOptions,
} from '@spur-board/adapters';
import { openStore, tickBoard, type Store } from '@spur-board/core';
import { createSlackGateway } from '@spur-board/gateway-slack';
import { afterEach, expect, it, vi } from 'vitest';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';
import { createBoardModules } from '../src/board-modules.ts';
import { runDaemon, type ModuleContext, type ProcessPort } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const source = 'github-issues:board:o/r';
const base = Date.parse('2026-11-04T12:00:00.000Z');
afterEach(() => {
  vi.useRealTimers();
});

it('observes a batch, ticks every 60 seconds, and stops pollers before an active core tick', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(base);
  const file = join(mkdtempSync(join(tmpdir(), 'board-daemon-')), 'board.db');
  const store = openStore(file);
  const events: string[] = [];
  let signalHandler: ((signal: string) => void) | undefined;
  let exitCode: number | undefined;
  const port: ProcessPort = {
    onSignal(handler) {
      signalHandler = handler;
    },
    onFatal() {
      /* The test does not send a fatal error. */
    },
    exit(code) {
      exitCode = code;
      events.push('exit');
    },
    writeErr(text) {
      throw new Error(text);
    },
  };
  const lines: string[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  let observed: Promise<void> = Promise.resolve();
  let onNotice: StartAdaptersOptions['onSpurNotice'];
  let onPollFailure: StartAdaptersOptions['onPollFailure'];
  let releaseTick: () => void = () => undefined;
  let ticks = 0;
  await runDaemon<Store>({
    paths: { configFile: 'config', secretsFile: 'secrets', dbFile: file, lockFile: 'lock' },
    acquireLock: () => ({
      release: () => {
        events.push('lock released');
      },
    }),
    loadConfig: () => ({ config, secrets: {} }),
    openStore: () => store,
    modules: (ctxFor) =>
      createBoardModules(ctxFor, {
        startAdapters: (_config, core, options) => {
          onNotice = options.onSpurNotice;
          onPollFailure = options.onPollFailure;
          observed = core.observe(source, {
            batch: {
              source,
              observedAt: new Date(base).toISOString(),
              complete: true,
              items: [
                {
                  kind: 'ticket',
                  facts: {
                    trackerId: source,
                    id: 'node-9',
                    key: 'o/r#9',
                    title: 'Ticket',
                    status: 'open',
                    assignee: null,
                    sprint: null,
                    labels: ['board'],
                    inFilter: true,
                    url: 'https://github.com/o/r/issues/9',
                    updatedAt: new Date(base).toISOString(),
                  },
                },
              ],
              entities: [],
            },
            effectiveComplete: true,
            state: { lastCompleteAt: new Date(base).toISOString(), gone: [] },
            outcomes: [],
          });
          return {
            async stop() {
              events.push('pollers stopped');
              await observed;
            },
          };
        },
        tick: async (deps) => {
          ticks += 1;
          events.push(`tick ${String(ticks)}`);
          if (ticks === 2)
            await new Promise<void>((resolve) => {
              releaseTick = resolve;
            });
          await tickBoard(deps);
        },
      }).entries,
    port,
    stdout: out,
    clock: { now: () => Date.now() },
    shutdownTimeoutMs: 10_000,
  });
  await observed;
  await onNotice?.({ kind: 'unknown_state', value: 'future-value' });
  await onNotice?.({ kind: 'unknown_state', value: 'future-value' });
  expect(
    await store.db
      .selectFrom('event')
      .select('id')
      .where('kind', '=', 'spur_unknown_state')
      .execute(),
  ).toHaveLength(1);
  onPollFailure?.({
    source: 'spur',
    step: 'batch',
    kind: 'transient',
    error: new Error('Invalid batch: fails the batch schema'),
    issues: [{ path: 'items.0.facts.branch', code: 'too_small', message: 'Too small' }],
  });
  const failures = lines
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.includes('adapter poll failed'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(failures).toMatchObject([
    {
      level: 40,
      module: 'board-adapters',
      source: 'spur',
      step: 'batch',
      kind: 'transient',
      err: { message: 'Invalid batch: fails the batch schema' },
      issues: [{ path: 'items.0.facts.branch', code: 'too_small', message: 'Too small' }],
    },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(await store.db.selectFrom('task').select('key').execute()).toEqual([{ key: 'o/r#9' }]);
  expect(ticks).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ticks).toBe(2);
  signalHandler?.('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toContain('pollers stopped');
  expect(exitCode).toBeUndefined();
  releaseTick();
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCode).toBe(0);
  expect(events.indexOf('pollers stopped')).toBeLessThan(events.indexOf('exit'));
});

it('moves Spur observation times and the Slack recovery window with one shifted clock', async () => {
  // A sub-second clock: the fake Slack API stamps that exact millisecond, not the whole second.
  let t = Date.parse('2031-01-01T00:00:00.500Z');
  const clock = { now: () => t };
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-daemon-')), 'board.db'));
  const log = createLogger(
    {
      write() {
        /* The test reads adapter output, not log lines. */
      },
    },
    {},
  );
  const ctxFor = (name: string): ModuleContext<Store> => ({
    config,
    secrets: {},
    store,
    log: log.child({ module: name }),
    clock,
    logCall: (call, fn) => logCall(log, clock, call, fn),
    state: () => 'ready',
  });
  const observed: { source: string; observation: AcceptedObservation }[] = [];
  const runners: AdapterRunner[] = [];
  const captureCore: AdapterCore = {
    context: () => Promise.resolve({ observe: { prs: [], tickets: [], sessions: [] } }),
    observe(observedSource, observation) {
      observed.push({ source: observedSource, observation });
      return Promise.resolve();
    },
    reportSourceState: () => Promise.resolve(),
  };
  const spurFetch: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== '/sessions') throw new Error(`Unexpected fake URL ${url.pathname}`);
    return Promise.resolve(
      Response.json([{ id: 's1', project: 'p', status: 'running', state: 'working' }]),
    );
  };
  const { entries } = createBoardModules(ctxFor, {
    startAdapters: (adapterConfig, _core, options) => {
      const runner = startAdapters(adapterConfig, captureCore, {
        ...options,
        fetch: spurFetch,
        oneShot: true,
      });
      runners.push(runner);
      return runner;
    },
  });
  const adapters = entries.find((entry) => entry.name === 'board-adapters');
  if (adapters === undefined) throw new Error('No board-adapters entry');

  const fake = await startFakeSlackApi({ now: () => t });
  try {
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
      apiUrl: fake.url,
      requestTimeoutMs: 500,
      now: () => t,
    });
    const opened = await gateway.deliver({
      key: 'clock-root',
      maybeSent: false,
      target: { kind: 'open', space: 'orchestrators', title: 'question' },
      persona: { name: 'test', role: 'board' },
      body: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'question' }] }],
    });
    if (opened.status !== 'delivered' || opened.conversation === undefined) {
      throw new Error('fake conversation failed to open');
    }
    const conversation = opened.conversation;
    const author = userIdSchema.parse('U_OPERATOR');

    async function round(text: string) {
      await adapters?.module.start(new AbortController().signal);
      await runners.at(-1)?.firstAttempts;
      await adapters?.module.stop();
      const reply = await fake.platform.inject({ kind: 'message', conversation, author, text });
      const recovered: InboundEvent[] = [];
      for await (const event of gateway.recover({
        conversations: [{ ref: conversation }],
        since: new Date(t),
      })) {
        recovered.push(event);
      }
      const replies = recovered.filter(
        (event): event is Extract<InboundEvent, { kind: 'message' }> => event.kind === 'message',
      );
      return { reply: reply.message, replies };
    }

    const t1 = t;
    const first = await round('first');
    t += 3_600_000;
    const t2 = t;
    const second = await round('second');

    expect(runners).toHaveLength(2);
    const spur = observed.filter((entry) => entry.source === 'spur');
    expect(spur).toHaveLength(2);
    for (const [index, at] of [t1, t2].entries()) {
      const batch = spur[index]?.observation.batch;
      expect(batch?.observedAt).toBe(new Date(at).toISOString());
      const session = batch?.items.find((item) => item.kind === 'session');
      expect(session?.kind === 'session' ? session.facts.healthSince : undefined).toBe(
        new Date(at).toISOString(),
      );
    }
    expect(first.replies.find((event) => event.message === first.reply)?.at).toBe(
      new Date(t1).toISOString(),
    );
    expect(second.replies.find((event) => event.message === second.reply)?.at).toBe(
      new Date(t2).toISOString(),
    );
    expect(second.replies.some((event) => event.message === first.reply)).toBe(false);
  } finally {
    await fake.close();
    await store.close();
  }
});

it('forwards pollPr to the started runner', async () => {
  const clock = { now: () => base };
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-daemon-')), 'board.db'));
  const log = createLogger(
    {
      write() {
        /* The test reads poll results, not log lines. */
      },
    },
    {},
  );
  const ctxFor = (name: string): ModuleContext<Store> => ({
    config,
    secrets: {},
    store,
    log: log.child({ module: name }),
    clock,
    logCall: (call, fn) => logCall(log, clock, call, fn),
    state: () => 'ready',
  });
  const ref = { kind: 'pr', repo: 'o/r', number: 7 } as const;
  const answer = ok({ status: 'not_found' as const, observedAt: new Date(base).toISOString() });
  const calls: unknown[][] = [];
  let withPollPr = true;
  const { entries, pollPr } = createBoardModules(ctxFor, {
    startAdapters: () => ({
      stop: () => Promise.resolve(),
      ...(withPollPr
        ? {
            pollPr: (...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve(answer);
            },
          }
        : {}),
    }),
  });
  const adapters = entries.find((entry) => entry.name === 'board-adapters');
  if (adapters === undefined) throw new Error('No board-adapters entry');
  try {
    await expect(pollPr('github:board:o/r', ref, { timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'stopped' },
    });

    await adapters.module.start(new AbortController().signal);
    await expect(pollPr('github:board:o/r', ref, { timeoutMs: 10 })).resolves.toBe(answer);
    expect(calls).toEqual([['github:board:o/r', ref, { timeoutMs: 10 }]]);

    await adapters.module.stop();
    await expect(pollPr('github:board:o/r', ref, { timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'stopped' },
    });

    withPollPr = false;
    await adapters.module.start(new AbortController().signal);
    await expect(pollPr('github:board:o/r', ref, { timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unsupported' },
    });
    await adapters.module.stop();
    expect(calls).toHaveLength(1);
  } finally {
    await store.close();
  }
});
