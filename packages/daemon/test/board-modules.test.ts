import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { configSchema } from '@spur-board/contracts';
import type { StartAdaptersOptions } from '@spur-board/adapters';
import { openStore, tickBoard, type Store } from '@spur-board/core';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoardModules } from '../src/board-modules.ts';
import { runDaemon, type ProcessPort } from '../src/lifecycle.ts';

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
  const out = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  let observed: Promise<void> = Promise.resolve();
  let onNotice: StartAdaptersOptions['onSpurNotice'];
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
          onNotice = options?.onSpurNotice;
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
      }),
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
