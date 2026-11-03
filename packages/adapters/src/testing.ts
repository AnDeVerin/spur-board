// Test fakes for the adapter runner: a recording core and a recording adapter. No test
// framework import, so any harness can use them.
import type { Adapter, Batch, PollContext } from '@spur-board/contracts';
import type { AdapterCore, SourceState } from './runner/runner.ts';

type Context = Omit<PollContext, 'signal'>;

export interface FakeCoreOptions {
  /** What `context` returns; defaults to nothing to observe and no cursor. */
  context?: (source: string) => Context | Promise<Context>;
  /** Runs after `observe` records its call; a rejection rejects the call. */
  observe?: (source: string, batch: Batch) => void | Promise<void>;
  /** Runs after `reportSourceState` records its call; a rejection rejects the call. */
  reportSourceState?: (source: string, state: SourceState) => void | Promise<void>;
}

export interface FakeCore extends AdapterCore {
  readonly observed: { source: string; batch: Batch }[];
  /** Every `reportSourceState` call in call order. */
  readonly states: { source: string; state: SourceState }[];
  /** The most `reportSourceState` calls that were unsettled at once. */
  readonly maxReportsInFlight: number;
  /** Held `reportSourceState` calls not yet released. */
  readonly heldReports: number;
  /** From now on each `reportSourceState` waits until `releaseReport` is called. */
  holdReports(): void;
  /** Resolves the oldest held report. */
  releaseReport(): void;
}

export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const observed: FakeCore['observed'] = [];
  const states: FakeCore['states'] = [];
  const held: (() => void)[] = [];
  let holding = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const empty: Context = { observe: { prs: [], tickets: [], sessions: [] } };

  return {
    observed,
    states,
    get maxReportsInFlight() {
      return maxInFlight;
    },
    get heldReports() {
      return held.length;
    },
    holdReports() {
      holding = true;
    },
    releaseReport() {
      const release = held.shift();
      if (release === undefined) throw new Error('No held report to release');
      release();
    },
    async context(source) {
      return options.context ? await options.context(source) : empty;
    },
    async observe(source, batch) {
      observed.push({ source, batch });
      await options.observe?.(source, batch);
    },
    async reportSourceState(source, state) {
      states.push({ source, state });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        await options.reportSourceState?.(source, state);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

export interface FakeAdapter extends Adapter {
  /** Every context `poll` was called with, in order. */
  readonly contexts: PollContext[];
}

export function createFakeAdapter(options: {
  id: string;
  intervalMs: number;
  poll: (ctx: PollContext) => Promise<Batch>;
}): FakeAdapter {
  const contexts: PollContext[] = [];
  return {
    id: options.id,
    intervalMs: options.intervalMs,
    contexts,
    poll(ctx) {
      contexts.push(ctx);
      return options.poll(ctx);
    },
  };
}
