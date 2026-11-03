// Runs each adapter on a single-flight timer chain, hands its batches to core and reports
// the state of its source: the last complete observation, blindness and gone entities.
import {
  AdapterError,
  batchSchema,
  type Adapter,
  type Batch,
  type Config,
  type EntityRef,
  type PollContext,
} from '@spur-board/contracts';
import {
  applyEntityOutcomes,
  nextDelay,
  staleDeadline,
  staleHardBound,
  type GoneRef,
  type PollOutcome,
} from './policy.ts';

/** What the runner needs from core. */
export interface AdapterCore {
  /** What the next poll of `source` should observe, and the cursor to continue from. */
  context(source: string): Promise<Omit<PollContext, 'signal'>>;
  /** Takes a validated batch; `observedAt` is the poll start. */
  observe(source: string, batch: Batch): Promise<void>;
  /** Takes the state of a source whenever it changes. */
  reportSourceState(source: string, state: SourceState): Promise<void>;
}

export interface SourceState {
  /** ISO time: `observedAt` of the last effectively complete batch. */
  lastCompleteAt?: string;
  blind?: { reason: 'auth' | 'config' | 'stale'; message: string };
  /** PR and ticket refs only. */
  gone: readonly EntityRef[];
}

interface RunnerEntry {
  adapter: Adapter;
  /** Pause the source while its reported budget is below this. */
  reserveRemaining?: number | undefined;
}

export interface AdapterRunner {
  /** Aborts the in-flight polls, clears every timer and waits for pending reports. */
  stop(): Promise<void>;
}

export interface RunnerOptions {
  entries: readonly RunnerEntry[];
  core: AdapterCore;
  config: Pick<Config, 'sources' | 'thresholds'>;
}

export function startRunner(options: RunnerOptions): AdapterRunner {
  const startedAt = Date.now();
  const sources = options.entries.map((entry) => runSource(entry, options, startedAt));
  return {
    async stop() {
      await Promise.all(sources.map((source) => source.stop()));
    },
  };
}

type Blind = NonNullable<SourceState['blind']>;
type Timer = ReturnType<typeof setTimeout>;

function runSource(entry: RunnerEntry, options: RunnerOptions, runnerStartMs: number) {
  const { adapter, reserveRemaining } = entry;
  const { core, config } = options;
  const source = adapter.id;
  const { intervalMs } = adapter;
  const { staleMultiplier } = config.thresholds;
  const staleBlind: Blind = {
    reason: 'stale',
    message: `No complete observation in ${String(staleMultiplier)} poll intervals`,
  };

  let stopping = false;
  let failures = 0;
  let lastCompleteMs: number | undefined;
  let errorBlind: Blind | undefined;
  let counts: ReadonlyMap<string, number> = new Map();
  let gone: readonly GoneRef[] = [];
  let polling = false;
  let controller: AbortController | undefined;
  let current: Promise<void> = Promise.resolve();
  let pollTimer: Timer | undefined;
  let deadlineTimer: Timer | undefined;
  let hardBoundTimer: Timer | undefined;
  let reports: Promise<void> = Promise.resolve();
  let lastReported: string | undefined;

  function state(now: number): SourceState {
    const deadline = staleDeadline(lastCompleteMs, runnerStartMs, staleMultiplier, intervalMs);
    const blind = errorBlind ?? (now > deadline ? staleBlind : undefined);
    return {
      ...(lastCompleteMs === undefined ? {} : { lastCompleteAt: iso(lastCompleteMs) }),
      ...(blind === undefined ? {} : { blind }),
      gone,
    };
  }

  /** Appends the current state to the serial report chain; resolves when its step is done. */
  function report(): Promise<void> {
    if (stopping) return reports;
    const next = state(Date.now());
    reports = reports.then(async () => {
      const json = JSON.stringify(next);
      if (json === lastReported) return;
      try {
        await core.reportSourceState(source, next);
        lastReported = json;
      } catch {
        // Not accepted: the next outcome reports again.
      }
    });
    return reports;
  }

  function armDeadline(): void {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    const deadline = staleDeadline(lastCompleteMs, runnerStartMs, staleMultiplier, intervalMs);
    const delay = deadline + 1 - Date.now();
    if (delay > 0) deadlineTimer = setTimeout(onDeadline, delay);
  }

  function onDeadline(): void {
    deadlineTimer = undefined;
    if (!polling) {
      void report();
      return;
    }
    // The poll in flight may still complete: decide when it settles, or at the hard bound.
    const firedAt = Date.now();
    hardBoundTimer = setTimeout(
      onHardBound,
      staleHardBound(firedAt, staleMultiplier, intervalMs) - firedAt,
    );
  }

  function onHardBound(): void {
    hardBoundTimer = undefined;
    void report();
  }

  function schedule(delayMs: number): void {
    if (stopping) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      current = poll();
    }, delayMs);
  }

  async function poll(): Promise<void> {
    polling = true;
    const abort = new AbortController();
    // A function, so each check reads the signal anew after an await.
    const aborted = () => abort.signal.aborted;
    controller = abort;
    const startMs = Date.now();
    let outcome: PollOutcome;
    try {
      const context = await core.context(source);
      if (aborted()) return;
      const requested: GoneRef[] = [...context.observe.prs, ...context.observe.tickets];
      const batch = await adapter.poll({ ...context, signal: abort.signal });
      if (aborted()) return;
      const parsed = batchSchema.safeParse({ ...batch, observedAt: iso(startMs) });
      if (!parsed.success || parsed.data.source !== source) {
        outcome = { kind: 'failed', error: new AdapterError('transient', 'Invalid batch') };
      } else {
        await core.observe(source, parsed.data);
        if (aborted()) return;
        const outcomes = applyEntityOutcomes({
          counts,
          requested,
          batch: parsed.data,
          goneAfterPolls: config.sources.goneAfterPolls,
        });
        counts = outcomes.counts;
        gone = outcomes.gone;
        if (outcomes.complete) lastCompleteMs = startMs;
        errorBlind = undefined;
        outcome = { kind: 'delivered', budget: parsed.data.budget };
      }
    } catch (error) {
      if (aborted()) return;
      outcome = { kind: 'failed', error };
    }
    polling = false;
    controller = undefined;
    clearTimeout(hardBoundTimer);
    hardBoundTimer = undefined;
    if (
      outcome.kind === 'failed' &&
      outcome.error instanceof AdapterError &&
      (outcome.error.kind === 'auth' || outcome.error.kind === 'config')
    ) {
      errorBlind = { reason: outcome.error.kind, message: outcome.error.message };
    }
    const delay = nextDelay({
      outcome,
      intervalMs,
      failures,
      authRetryMs: config.sources.authRetryMs,
      reserveRemaining,
      now: Date.now(),
    });
    failures = delay.failures;
    armDeadline();
    await report();
    schedule(delay.delayMs);
  }

  armDeadline();
  current = poll();

  return {
    async stop(): Promise<void> {
      stopping = true;
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(hardBoundTimer);
      pollTimer = deadlineTimer = hardBoundTimer = undefined;
      controller?.abort();
      await current;
      await reports;
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
