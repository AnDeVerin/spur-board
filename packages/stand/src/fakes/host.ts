// A host the stand's daemon samples instead of the machine it runs on, so QA can drive the
// status bar host dot and the host-disk item. Readings last until reset.
import { parseArgs } from 'node:util';
import { err, ok, type Result } from '@spur-board/contracts';
import type { HostProbe } from '@spur-board/daemon/in-process';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';

const GIB = 2 ** 30;
const MEMORY_BYTES = 16 * GIB;
const BLOCK_SIZE = 65_536;
/** Blocks per volume: about 61 GiB at 64 KiB each. */
const BLOCKS = 1_000_000;
/** CPU milliseconds each `cpuTimes` read adds, over all cores. */
const CPU_STEP = 1_000;

const DEFAULTS = { cpu: 10, ram: 50, disk: 50 } as const;
const VERBS = ['cpu', 'ram', 'disk', 'inspect'] as const;

const percent = z.number().min(0).max(100);
const readingArgs = z.strictObject({ percent });
const diskArgs = z.strictObject({ percent, mount: z.string().startsWith('/').optional() });

export interface FakeHost {
  /** The probe the stand passes to its daemon. */
  probe: HostProbe;
  /** Runs one `fake host` verb. */
  control(verb: string, args: unknown): RouteResult;
  /** Back to the defaults: CPU 10 %, RAM 50 %, one volume `/` at 50 %. */
  reset(): void;
}

export function createFakeHost(): FakeHost {
  let cpu: number = DEFAULTS.cpu;
  let ram: number = DEFAULTS.ram;
  let volumes = new Map<string, { dev: number; percent: number }>();
  let times = { idle: 0, total: 0 };
  const reset = () => {
    cpu = DEFAULTS.cpu;
    ram = DEFAULTS.ram;
    volumes = new Map([['/', { dev: 1, percent: DEFAULTS.disk }]]);
    times = { idle: 0, total: 0 };
  };
  reset();
  const inspect = () => ({
    cpu,
    ram,
    volumes: [...volumes].map(([mount, { percent: used }]) => ({ mount, percent: used })),
  });
  const probe: HostProbe = {
    cpuTimes() {
      // Cumulative, as the kernel counts: the sampler reads `cpu` between two calls.
      times = {
        idle: times.idle + (CPU_STEP * (100 - cpu)) / 100,
        total: times.total + CPU_STEP,
      };
      return times;
    },
    memory: () => ({
      totalBytes: MEMORY_BYTES,
      availableBytes: (MEMORY_BYTES * (100 - ram)) / 100,
    }),
    get diskPaths() {
      return [...volumes.keys()];
    },
    volume(path) {
      const volume = volumes.get(path);
      if (volume === undefined) return Promise.reject(new Error(`no fake volume ${path}`));
      const free = Math.round((BLOCKS * (100 - volume.percent)) / 100);
      return Promise.resolve({
        dev: volume.dev,
        mount: path,
        blocks: BLOCKS,
        bfree: free,
        bavail: free,
        bsize: BLOCK_SIZE,
      });
    },
  };
  return {
    probe,
    reset,
    control(verb, args) {
      const bad = (error: string) => ({ status: 400, body: { error, verbs: VERBS } });
      if (verb === 'inspect') return { status: 200, body: inspect() };
      if (verb === 'cpu' || verb === 'ram') {
        const parsed = readingArgs.safeParse(args);
        if (!parsed.success) return bad(z.prettifyError(parsed.error));
        if (verb === 'cpu') cpu = parsed.data.percent;
        else ram = parsed.data.percent;
        return { status: 200, body: inspect() };
      }
      if (verb === 'disk') {
        const parsed = diskArgs.safeParse(args);
        if (!parsed.success) return bad(z.prettifyError(parsed.error));
        const mount = parsed.data.mount ?? '/';
        const dev = volumes.get(mount)?.dev ?? volumes.size + 1;
        volumes.set(mount, { dev, percent: parsed.data.percent });
        return { status: 200, body: inspect() };
      }
      return bad('Unknown fake host verb.');
    },
  };
}

/**
 * Parses the arguments of `stand fake host`: `cpu|ram <percent>`, `disk <percent> [<mount>]` or
 * `inspect`. `home` is the stand's own `--home`, kept out of `args`.
 */
export function parseFakeHostArgs(
  rest: readonly string[],
): Result<{ system: 'host'; verb: string; args: Record<string, unknown>; home?: string }, string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: { home: { type: 'string' } },
    });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
  const [, verb, ...operands] = parsed.positionals;
  const home = parsed.values.home === undefined ? {} : { home: parsed.values.home };
  if (verb === 'inspect') {
    if (operands.length > 0) return err('fake host inspect takes no operand.');
    return ok({ system: 'host', verb, args: {}, ...home });
  }
  if (verb !== 'cpu' && verb !== 'ram' && verb !== 'disk')
    return err(`Unknown fake host verb ${verb ?? '(none)'}; use cpu, ram, disk or inspect.`);
  const [value, mount, ...extra] = operands;
  const most = verb === 'disk' ? 2 : 1;
  if (value === undefined || operands.length > most || extra.length > 0)
    return err(
      verb === 'disk'
        ? 'fake host disk takes a percent and an optional mount.'
        : `fake host ${verb} takes one percent.`,
    );
  const number = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!(number >= 0 && number <= 100))
    return err(`fake host ${verb} needs a percent from 0 to 100, not ${value}.`);
  const args: Record<string, unknown> = { percent: number };
  if (mount !== undefined) {
    if (!mount.startsWith('/')) return err(`fake host disk needs an absolute mount, not ${mount}.`);
    args['mount'] = mount;
  }
  return ok({ system: 'host', verb, args, ...home });
}
