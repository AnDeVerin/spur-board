// Test fakes for the adapter runner: a recording core and a recording adapter. No test
// framework import, so any harness can use them.
import type {
  AcceptedObservation,
  Adapter,
  AdapterCore,
  Batch,
  PollContext,
  SourceState,
} from '@spur-board/contracts';

type Context = Omit<PollContext, 'signal'>;

export interface FakeCoreOptions {
  /** What `context` returns; defaults to nothing to observe and no cursor. */
  context?: (source: string) => Context | Promise<Context>;
  /** Runs after `observe` records its call; a rejection rejects the call. */
  observe?: (source: string, observation: AcceptedObservation) => void | Promise<void>;
  /** Runs after `reportSourceState` records its call; a rejection rejects the call. */
  reportSourceState?: (source: string, state: SourceState) => void | Promise<void>;
}

export interface FakeCore extends AdapterCore {
  readonly observed: { source: string; batch: Batch; observation: AcceptedObservation }[];
  /** Accepted source states and separate failure/deadline reports, in call order. */
  readonly states: { source: string; state: SourceState }[];
  /** Only standalone failure/deadline reports. */
  readonly reports: { source: string; state: SourceState }[];
  /** The most `reportSourceState` calls that were unsettled at once. */
  readonly maxReportsInFlight: number;
  /** From now on each `reportSourceState` waits until `releaseReport` is called. */
  holdReports(): void;
  /** Resolves the oldest held report. */
  releaseReport(): void;
}

export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const observed: FakeCore['observed'] = [];
  const states: FakeCore['states'] = [];
  const reports: FakeCore['reports'] = [];
  const held: (() => void)[] = [];
  let holding = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const empty: Context = { observe: { prs: [], tickets: [], sessions: [] } };

  return {
    observed,
    states,
    reports,
    get maxReportsInFlight() {
      return maxInFlight;
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
    async observe(source, observation) {
      observed.push({ source, batch: observation.batch, observation });
      await options.observe?.(source, observation);
      states.push({ source, state: observation.state });
    },
    async reportSourceState(source, state) {
      states.push({ source, state });
      reports.push({ source, state });
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
