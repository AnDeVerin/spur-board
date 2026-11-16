import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusOutputSchema } from '@spur-board/contracts/browser';
import type { LogFn } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostProbe, createHostSampler } from '../src/host-metrics.ts';
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
    const disk = { totalBytes: 4_096_000, availableBytes: 1_024_000, usedPercent: 73.7 };
    expect(hostSchema.parse(sampler.read())).toEqual({
      sampledAt: new Date(START).toISOString(),
      cpuPercent: null,
      memory,
      disk,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hostSchema.parse(sampler.read())).toEqual({
      sampledAt: new Date(START + 30_000).toISOString(),
      cpuPercent: 50,
      memory,
      disk,
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
      const probe = countingHostProbe(CPU);
      probe.disk = () => new Promise(() => undefined);
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
      const probe = countingHostProbe(CPU);
      let fail: (err: Error) => void = () => undefined;
      probe.disk = () =>
        new Promise((_, reject) => {
          fail = reject;
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
    const disk = await probe.disk();
    const expected = statfsSync(dir);
    expect(disk.blocks).toBe(expected.blocks);
    expect(disk.bsize).toBe(expected.bsize);
    expect(disk.bavail).toBeGreaterThanOrEqual(0);
    expect(disk.bavail).toBeLessThanOrEqual(disk.bfree);
    expect(disk.bfree).toBeLessThanOrEqual(disk.blocks);
    await expect(createHostProbe(join(dir, 'missing')).disk()).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(createHostProbe(undefined).disk()).rejects.toThrow();
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
