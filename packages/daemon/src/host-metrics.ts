import { realpath, stat, statfs } from 'node:fs/promises';
import { cpus, freemem, tmpdir, totalmem } from 'node:os';
import { dirname } from 'node:path';
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
  /** Paths whose volumes the sampler measures; volumes with the same `dev` count once. */
  diskPaths: readonly string[];
  /** Device id, mount point and `statfs` fields of the volume holding `path`. */
  volume(path: string): Promise<{
    dev: number;
    mount: string;
    blocks: number;
    bfree: number;
    bavail: number;
    bsize: number;
  }>;
}

/**
 * The topmost ancestor of `real` (a resolved path on device `dev`) that is still on `dev`. A bind
 * mount of the same device resolves to its parent mount.
 */
async function mountOf(real: string, dev: number): Promise<string> {
  let mount = real;
  for (;;) {
    const parent = dirname(mount);
    if (parent === mount || (await stat(parent)).dev !== dev) return mount;
    mount = parent;
  }
}

/**
 * Reads the host through `node:os`, `stat` and `statfs`. It measures `/`, `dataDir` when given
 * and `os.tmpdir()`.
 */
export function createHostProbe(dataDir: string | undefined): HostProbe {
  return {
    diskPaths: ['/', ...(dataDir === undefined ? [] : [dataDir]), tmpdir()],
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
    async volume(path) {
      const real = await realpath(path);
      const { dev } = await stat(real);
      const { blocks, bfree, bavail, bsize } = await statfs(real);
      return { dev, mount: await mountOf(real, dev), blocks, bfree, bavail, bsize };
    },
  };
}

const HOST_SAMPLE_MS = 30_000;
const ABORTED = Symbol('aborted');
/** A disk metric is keyed by its path, so each failing path warns once. */
type Metric = 'cpu' | 'memory' | `disk ${string}`;
type Volume = HostSample['volumes'][number];

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
 * `read` never samples. A metric whose read fails is null, with one warning per metric; a disk
 * path whose read fails is left out of `volumes`, with one warning per path. Volumes are deduped
 * by device and listed least free bytes first; `disk` is the first. Stop aborts pending disk
 * reads instead of waiting for them, and that run writes nothing.
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
  const failed = (metric: Metric, err: unknown, path?: string) => {
    if (warned.has(metric)) return;
    warned.add(metric);
    if (path === undefined) log.warn({ err }, `host ${metric} unreadable`);
    else log.warn({ err, path }, 'host disk unreadable');
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
    // The async wrapper turns a probe that throws synchronously into that path's rejected read.
    const paths = probe.diskPaths;
    const read = await untilAborted(
      Promise.allSettled(paths.map(async (path) => probe.volume(path))),
      signal,
    );
    if (read === ABORTED) return;
    const volumes: Volume[] = [];
    const seen = new Set<number>();
    // allSettled never rejects, so a read that is not aborted always carries a value.
    const results = 'value' in read ? read.value : [];
    results.forEach((result, index) => {
      const path = paths[index] ?? '';
      if (result.status === 'rejected') {
        failed(`disk ${path}`, result.reason, path);
        return;
      }
      const fs = result.value;
      if (seen.has(fs.dev)) return;
      seen.add(fs.dev);
      const used = (fs.blocks - fs.bfree) * fs.bsize;
      const available = fs.bavail * fs.bsize;
      volumes.push({
        mount: fs.mount,
        totalBytes: fs.blocks * fs.bsize,
        availableBytes: available,
        usedPercent: used + available > 0 ? percent((100 * used) / (used + available)) : 0,
      });
    });
    volumes.sort((a, b) => a.availableBytes - b.availableBytes);
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
      disk: volumes[0] ?? null,
      volumes,
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
