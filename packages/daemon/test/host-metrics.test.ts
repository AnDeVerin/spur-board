import { mkdtempSync, realpathSync, rmSync, statfsSync, statSync } from 'node:fs';
import { totalmem, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { statusOutputSchema } from '@spur-board/contracts/browser';
import type { LogFn } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostProbe, createHostSampler, type HostProbe } from '../src/host-metrics.ts';
import { countingHostProbe } from './in-process-web.ts';

const START = Date.parse('2026-11-16T10:00:00.000Z');
/** 50 % busy between the first and second sample. */
const CPU = [
  { idle: 100, total: 200 },
  { idle: 150, total: 300 },
];
const hostSchema = statusOutputSchema.shape.host;

afterEach(() => {
  vi.useRealTimers();
});

function logger() {
  return { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

type VolumeRead = Awaited<ReturnType<HostProbe['volume']>>;

/** A counting probe whose disk paths are the keys of `reads`, each read by its own function. */
function volumeProbe(reads: Record<string, () => Promise<VolumeRead>>) {
  const probe = countingHostProbe(CPU);
  probe.diskPaths = Object.keys(reads);
  probe.volume = (path) => {
    const read = reads[path];
    if (read === undefined) throw new Error(`unexpected path ${path}`);
    return read();
  };
  return probe;
}

/** `bsize` 4096 figures of a volume on `dev` mounted at `mount`. */
function figures(dev: number, mount: string, blocks: number, bfree: number, bavail: number) {
  return () => Promise.resolve({ dev, mount, blocks, bfree, bavail, bsize: 4096 });
}

/** Starts a sampler on fake timers, takes `samples` samples and returns the last host. */
async function sampled(probe: HostProbe, log: ReturnType<typeof logger>, samples = 1) {
  vi.useFakeTimers({ now: START });
  const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log });
  await sampler.module.start(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 1; i < samples; i += 1) await vi.advanceTimersByTimeAsync(30_000);
  await sampler.module.stop();
  return hostSchema.parse(sampler.read());
}

describe('host sampler', () => {
  it('samples CPU, memory and disk into the status shape and nulls a failing metric', async () => {
    vi.useFakeTimers({ now: START });
    const probe = countingHostProbe(CPU);
    const log = logger();
    const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log });
    expect(hostSchema.parse(sampler.read())).toBeNull();
    const controller = new AbortController();
    await sampler.module.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const memory = { totalBytes: 8000, availableBytes: 2000, usedPercent: 75 };
    const disk = {
      mount: '/',
      totalBytes: 4_096_000,
      availableBytes: 1_024_000,
      usedPercent: 73.7,
    };
    expect(hostSchema.parse(sampler.read())).toEqual({
      sampledAt: new Date(START).toISOString(),
      cpuPercent: null,
      memory,
      disk,
      volumes: [disk],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hostSchema.parse(sampler.read())).toEqual({
      sampledAt: new Date(START + 30_000).toISOString(),
      cpuPercent: 50,
      memory,
      disk,
      volumes: [disk],
    });

    probe.memory = () => {
      throw new Error('meminfo unreadable');
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hostSchema.parse(sampler.read())).toMatchObject({ memory: null, disk });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hostSchema.parse(sampler.read())).toMatchObject({
      sampledAt: new Date(START + 90_000).toISOString(),
      memory: null,
      disk,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    controller.abort();
    await sampler.module.stop();
  });

  it('never samples on reads and samples again only after 30 s', async () => {
    vi.useFakeTimers({ now: START });
    const probe = countingHostProbe(CPU);
    const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log: logger() });
    const controller = new AbortController();
    await sampler.module.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i += 1) sampler.read();
    expect(probe.calls).toEqual({ cpu: 1, memory: 1, disk: 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    for (let i = 0; i < 50; i += 1) sampler.read();
    expect(probe.calls).toEqual({ cpu: 1, memory: 1, disk: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.calls).toEqual({ cpu: 2, memory: 2, disk: 2 });
    await sampler.module.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(probe.calls).toEqual({ cpu: 2, memory: 2, disk: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls onSample with each sample and keeps it readable when onSample rejects', async () => {
    vi.useFakeTimers({ now: START });
    const log = logger();
    const seen: { sample: unknown; read: unknown }[] = [];
    const sampler = createHostSampler({
      probe: countingHostProbe(CPU),
      clock: { now: () => Date.now() },
      log,
      onSample: (sample) => {
        seen.push({ sample, read: sampler.read() });
        return seen.length === 1 ? Promise.reject(new Error('store busy')) : undefined;
      },
    });
    await sampler.module.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.read).toBe(seen[0]?.sample);
    expect(sampler.read()).toBe(seen[0]?.sample);
    expect(log.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(2);
    expect(hostSchema.parse(sampler.read())).toMatchObject({
      sampledAt: new Date(START + 30_000).toISOString(),
      cpuPercent: 50,
    });
    expect(sampler.read()).toBe(seen[1]?.sample);
    expect(log.error).toHaveBeenCalledTimes(1);
    await sampler.module.stop();
  });

  it('measures each distinct volume once, least available first', async () => {
    // `/home` has less free space but a lower percent than `/`, and `/` comes first by path.
    const small = figures(2, '/home', 1000, 900, 200);
    const big = figures(1, '/', 100_000, 20_000, 15_000);
    const log = logger();
    const host = await sampled(volumeProbe({ '/': big, '/data': small, '/tmp': big }), log);
    const home = {
      mount: '/home',
      totalBytes: 4_096_000,
      availableBytes: 819_200,
      usedPercent: 33.3,
    };
    const root = {
      mount: '/',
      totalBytes: 409_600_000,
      availableBytes: 61_440_000,
      usedPercent: 84.2,
    };
    expect(host?.volumes).toEqual([home, root]);
    expect(host?.disk).toEqual(home);

    const swapped = await sampled(
      volumeProbe({
        '/': figures(1, '/', 1000, 900, 200),
        '/data': figures(2, '/home', 100_000, 20_000, 15_000),
        '/tmp': figures(1, '/', 1000, 900, 200),
      }),
      log,
    );
    expect(swapped?.volumes.map((volume) => volume.mount)).toEqual(['/', '/home']);
    expect(swapped?.disk).toEqual(swapped?.volumes[0]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports one volume when every path is on the same device', async () => {
    const same = figures(1, '/', 1000, 300, 250);
    const host = await sampled(volumeProbe({ '/': same, '/data': same, '/tmp': same }), logger());
    expect(host?.volumes).toHaveLength(1);
    expect(host?.disk?.mount).toBe('/');
    expect(host?.disk).toEqual(host?.volumes[0]);
  });

  it('skips a volume whose read fails and warns once per path', async () => {
    const root = figures(1, '/', 1000, 300, 250);
    const missing = () =>
      Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
    const throws = () => {
      throw new Error('statfs threw');
    };
    const log = logger();
    const host = await sampled(
      volumeProbe({ '/': root, '/data': missing, '/tmp': throws }),
      log,
      2,
    );
    expect(host?.volumes.map((volume) => volume.mount)).toEqual(['/']);
    expect(host?.disk?.mount).toBe('/');
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/data', err: expect.any(Error) as unknown }),
      'host disk unreadable',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp', err: expect.any(Error) as unknown }),
      'host disk unreadable',
    );
    expect(log.error).not.toHaveBeenCalled();

    const none = await sampled(volumeProbe({ '/data': missing, '/tmp': throws }), logger());
    expect(none?.disk).toBeNull();
    expect(none?.volumes).toEqual([]);
    expect(none?.memory).not.toBeNull();
  });

  it('stops without waiting for a disk read that never settles', async () => {
    const guard = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('stop waited for the disk read'));
          }, 1_000).unref();
        }),
      ]);
    for (const abortStartFirst of [false, true]) {
      // `/` resolves, `/data` never settles: stop must not wait on the settled set.
      const probe = volumeProbe({
        '/': figures(1, '/', 1000, 300, 250),
        '/data': () => new Promise(() => undefined),
      });
      const log = logger();
      const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log });
      const controller = new AbortController();
      await sampler.module.start(controller.signal);
      await vi.waitFor(() => {
        expect(probe.calls.memory).toBe(1);
      });
      if (abortStartFirst) controller.abort();
      await guard(sampler.module.stop());
      expect(sampler.read()).toBeNull();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    }

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let fail: (err: Error) => void = () => undefined;
      const probe = volumeProbe({
        '/': figures(1, '/', 1000, 300, 250),
        '/data': () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      });
      const log = logger();
      const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log });
      await sampler.module.start(new AbortController().signal);
      await vi.waitFor(() => {
        expect(probe.calls.memory).toBe(1);
      });
      await guard(sampler.module.stop());
      fail(new Error('stale mount'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(sampler.read()).toBeNull();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('host probe', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('reads raw figures of the given directory volume through createHostProbe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-host-'));
    tmp = dir;
    const probe = createHostProbe(dir);
    const disk = await probe.volume(dir);
    const expected = statfsSync(dir);
    expect(disk.blocks).toBe(expected.blocks);
    expect(disk.bsize).toBe(expected.bsize);
    expect(disk.bavail).toBeGreaterThanOrEqual(0);
    expect(disk.bavail).toBeLessThanOrEqual(disk.bfree);
    expect(disk.bfree).toBeLessThanOrEqual(disk.blocks);
    // The mount is the topmost ancestor of the resolved path on the same device.
    expect(disk.dev).toBe(statSync(dir).dev);
    expect(statSync(disk.mount).dev).toBe(disk.dev);
    expect(disk.mount === '/' || statSync(dirname(disk.mount)).dev !== disk.dev).toBe(true);
    expect(realpathSync(dir).startsWith(disk.mount)).toBe(true);
    expect((await probe.volume('/')).mount).toBe('/');
    await expect(probe.volume(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(probe.diskPaths).toEqual(['/', dir, tmpdir()]);
    expect(createHostProbe(undefined).diskPaths).toEqual(['/', tmpdir()]);
    const memory = probe.memory();
    expect(memory.totalBytes).toBe(totalmem());
    expect(memory.availableBytes).toBeGreaterThan(0);
    expect(memory.availableBytes).toBeLessThanOrEqual(memory.totalBytes);
    const cpu = probe.cpuTimes();
    expect(cpu.idle).toBeGreaterThanOrEqual(0);
    expect(cpu.total).toBeGreaterThanOrEqual(cpu.idle);

    const sampler = createHostSampler({ probe, clock: { now: () => Date.now() }, log: logger() });
    await sampler.module.start(new AbortController().signal);
    await vi.waitFor(() => {
      expect(sampler.read()).not.toBeNull();
    });
    await sampler.module.stop();
    const host = hostSchema.parse(sampler.read());
    expect(host?.memory?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(host?.memory?.usedPercent).toBeLessThanOrEqual(100);
    expect(host?.disk?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(host?.disk?.usedPercent).toBeLessThanOrEqual(100);
  });
});
