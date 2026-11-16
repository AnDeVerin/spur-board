import { statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Module } from './lifecycle.ts';
import type { Clock } from './logger.ts';
import { createJob } from './scheduler.ts';

/** The cached sample `status.get` reports as `host`. */
export type HostSample = NonNullable<z.output<typeof statusOutputSchema>['host']>;

/** Raw host readings; the sampler does the maths. */
export interface HostProbe {
  /** CPU times summed over all cores, in milliseconds. */
  cpuTimes(): { idle: number; total: number };
  memory(): { totalBytes: number; availableBytes: number };
  /** `statfs` fields of the volume holding the board data. */
  disk(): Promise<{ blocks: number; bfree: number; bavail: number; bsize: number }>;
}

/** Reads the host through `node:os` and `statfs(dataDir)`; `disk` rejects without `dataDir`. */
export function createHostProbe(dataDir: string | undefined): HostProbe {
  return {
    cpuTimes() {
      let idle = 0;
      let total = 0;
      for (const { times } of cpus()) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
      }
      return { idle, total };
    },
    memory: () => ({ totalBytes: totalmem(), availableBytes: freemem() }),
    async disk() {
      if (dataDir === undefined) throw new Error('No data directory to measure');
      const { blocks, bfree, bavail, bsize } = await statfs(dataDir);
      return { blocks, bfree, bavail, bsize };
    },
  };
}

const HOST_SAMPLE_MS = 30_000;
const ABORTED = Symbol('aborted');
type Metric = 'cpu' | 'memory' | 'disk';

/** One decimal, kept within 0..100. */
function percent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/**
 * Settles with the promise's outcome, or with `ABORTED` once `signal` aborts. It always handles
 * the promise, so an abandoned read that rejects later is no unhandled rejection.
 */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ value: T } | { error: unknown } | typeof ABORTED> {
  return new Promise((resolve) => {
    const onAbort = () => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void promise
      .then(
        (value) => {
          resolve({ value });
        },
        (error: unknown) => {
          resolve({ error });
        },
      )
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

/**
 * Samples the host every `intervalMs` (first run in the background) and keeps the last sample;
 * `read` never samples. A metric whose read fails is null, with one warning per metric. Stop
 * aborts a pending disk read instead of waiting for it, and that run writes nothing.
 */
export function createHostSampler(options: {
  probe: HostProbe;
  clock: Clock;
  log: Pick<Logger, 'warn' | 'error'>;
  intervalMs?: number;
}): { module: Module; read(): HostSample | null } {
  const { probe, clock, log, intervalMs = HOST_SAMPLE_MS } = options;
  let last: HostSample | null = null;
  let previousCpu: { idle: number; total: number } | undefined;
  const warned = new Set<Metric>();
  const failed = (metric: Metric, err: unknown) => {
    if (warned.has(metric)) return;
    warned.add(metric);
    log.warn({ err }, `host ${metric} unreadable`);
  };
  const attempt = <T>(metric: Metric, read: () => T): T | null => {
    try {
      return read();
    } catch (err) {
      failed(metric, err);
      return null;
    }
  };
  const sample = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    const sampledAt = new Date(clock.now()).toISOString();
    const cpu = attempt('cpu', () => probe.cpuTimes());
    const before = previousCpu;
    previousCpu = cpu ?? undefined;
    const cpuPercent =
      cpu === null || before === undefined || cpu.total <= before.total
        ? null
        : percent(100 * (1 - (cpu.idle - before.idle) / (cpu.total - before.total)));
    const mem = attempt('memory', () => probe.memory());
    // The async wrapper turns a probe that throws synchronously into a rejected read.
    const read = await untilAborted((async () => probe.disk())(), signal);
    if (read === ABORTED) return;
    if ('error' in read) failed('disk', read.error);
    const fs = 'value' in read ? read.value : null;
    const used = fs === null ? 0 : (fs.blocks - fs.bfree) * fs.bsize;
    const available = fs === null ? 0 : fs.bavail * fs.bsize;
    last = {
      sampledAt,
      cpuPercent,
      memory:
        mem === null
          ? null
          : {
              totalBytes: mem.totalBytes,
              availableBytes: mem.availableBytes,
              usedPercent:
                mem.totalBytes > 0
                  ? percent((100 * (mem.totalBytes - mem.availableBytes)) / mem.totalBytes)
                  : 0,
            },
      disk:
        fs === null
          ? null
          : {
              totalBytes: fs.blocks * fs.bsize,
              availableBytes: available,
              usedPercent: used + available > 0 ? percent((100 * used) / (used + available)) : 0,
            },
    };
  };
  const own = new AbortController();
  const job = createJob({
    run: (signal) => sample(AbortSignal.any([signal, own.signal])),
    intervalMs,
    first: 'background',
    onError: (err) => {
      log.error({ err }, 'host sample failed');
    },
  });
  return {
    module: {
      start: (signal) => job.start(signal),
      async stop() {
        own.abort();
        await job.stop();
      },
    },
    read: () => last,
  };
}
