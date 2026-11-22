import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { tickBoard, type Store } from '@spur-board/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, startInProcessDaemon, type InProcessDaemon } from '../src/in-process.ts';
import { countingHostProbe } from './in-process-web.ts';

const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'example/repo' },
      repos: ['example/repo'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  http: { port: 0 },
});

/** A probe whose one volume `/` is 95 % used. */
function fullDisk() {
  const probe = countingHostProbe();
  probe.volume = () =>
    Promise.resolve({ dev: 1, mount: '/', blocks: 1000, bfree: 50, bavail: 50, bsize: 4096 });
  return probe;
}

let home: string;
let daemon: InProcessDaemon | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'host-disk-'));
});

afterEach(async () => {
  await daemon?.stop();
  await daemon?.teardown;
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

function start(): Promise<InProcessDaemon> {
  return startInProcessDaemon({
    paths: {
      configFile: join(home, 'config.yaml'),
      secretsFile: join(home, 'secrets.env'),
      dbFile: join(home, 'board.sqlite'),
      lockFile: join(home, 'board.lock'),
    },
    loadConfig: () => ({ config, secrets: {} }),
    acquireLock,
    clock: { now: () => Date.now() },
    stdout: { write() {} },
    writeErr(text) {
      throw new Error(text);
    },
    ports: {
      tick: tickBoard,
      startAdapters: () => ({ stop: () => Promise.resolve() }),
      hostProbe: fullDisk(),
    },
  });
}

async function streak(store: Store): Promise<number | undefined> {
  const row = await store.db
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'host_disk')
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return (JSON.parse(row.value) as Record<string, { streak: number }>)['/']?.streak;
}

describe('host disk through the daemon', () => {
  it('counts samples across a restart and raises the item with its feed line', async () => {
    daemon = await start();
    const first = daemon;
    await vi.waitFor(async () => {
      expect(await streak(first.store)).toBe(1);
    });
    expect(await first.stop()).toBe(0);
    await first.teardown;

    daemon = await start();
    const second = daemon;
    await vi.waitFor(async () => {
      expect(await streak(second.store)).toBe(2);
    });
    await second.tick();
    const item = await second.store.db
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', '=', 'host-disk:/')
      .executeTakeFirstOrThrow();
    expect(item).toMatchObject({ kind: 'board_observation', task_id: null, cleared_at: null });
    expect(item.text).toMatch(/^host disk \/: 95% used, \d+\.\d GiB free$/);
    expect(item.line_outbox_id).not.toBeNull();
    const line = await second.store.db
      .selectFrom('outbox')
      .select('kind')
      .where('id', '=', item.line_outbox_id ?? -1)
      .executeTakeFirstOrThrow();
    expect(line.kind).toBe('feed.line');
  });
});
