// Runs each adapter on a single-flight timer chain, hands its batches to core and reports
// the state of its source: the last complete observation, blindness and gone entities.
import {
  AdapterError,
  batchSchema,
  type Adapter,
  type AdapterCore,
  type AdapterErrorKind,
  type Config,
  type SourceState,
} from '@spur-board/contracts';
import {
  answersRequest,
  applyEntityOutcomes,
  entityKey,
  nextDelay,
  staleDeadline,
  staleHardBound,
  type GoneRef,
  type PollOutcome,
} from './policy.ts';

interface RunnerEntry {
  adapter: Adapter;
  /** Repository owned by a GitHub PR source. */
  repo?: string;
  /** Pause the source while its reported budget is below this. */
  reserveRemaining?: number | undefined;
}

export interface AdapterRunner {
  /** Outcome of the first poll of each source, after its observation or failure report. */
  firstAttempts?:
    Promise<readonly { source: string; outcome: PollOutcome | undefined }[]> | undefined;
  /** Aborts the in-flight polls, clears every timer and waits for pending reports. */
  stop(): Promise<void>;
}

/** One failed step of a poll or a source report, for the warn log. Never carries a value. */
export interface PollFailure {
  source: string;
  /**
   * `context`, `poll` and `observe` reject; `batch` is an invalid batch or one that throws while
   * read; `outcomes` throws while a valid batch becomes entity outcomes and a proposed state;
   * `report` a state report.
   */
  step: 'context' | 'poll' | 'batch' | 'outcomes' | 'observe' | 'report';
  /** The `AdapterError` kind, or `unexpected` for any other error. */
  kind: AdapterErrorKind | 'unexpected';
  error: unknown;
  /** The zod issues of a batch that failed `batchSchema`: path, code and message. */
  issues?: { path: string; code: string; message: string }[] | undefined;
}

export interface RunnerOptions {
  entries: readonly RunnerEntry[];
  core: AdapterCore;
  config: Pick<Config, 'sources' | 'thresholds'>;
  now?: () => number;
  oneShot?: boolean;
  /** Called for every failed poll step and rejected report; an abort is not one. Must not throw. */
  onFailure?: ((failure: PollFailure) => void) | undefined;
}

export function startRunner(options: RunnerOptions): AdapterRunner {
  const startedAt = (options.now ?? Date.now)();
  const sources = options.entries.map((entry) => runSource(entry, options, startedAt));
  return {
    firstAttempts: Promise.all(
      sources.map(async (source) => ({
        source: source.id,
        outcome: await source.firstAttempt,
      })),
    ),
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
  const now = options.now ?? Date.now;
  const source = adapter.id;
  const { intervalMs } = adapter;
  const { staleMultiplier } = config.thresholds;
  const staleBlind: Blind = {
    reason: 'stale',
    message: `No complete observation in ${String(staleMultiplier)} poll intervals`,
  };

  function fail(step: PollFailure['step'], error: unknown, issues?: PollFailure['issues']) {
    const kind = error instanceof AdapterError ? error.kind : 'unexpected';
    options.onFailure?.({ source, step, kind, error, ...(issues === undefined ? {} : { issues }) });
  }

  let stopping = false;
  let failures = 0;
  let lastCompleteMs: number | undefined;
  let errorBlind: Blind | undefined;
  let counts: ReadonlyMap<string, number> = new Map();
  let hydrated = false;
  let gone: readonly GoneRef[] = [];
  /** Set while a poll is in flight. */
  let controller: AbortController | undefined;
  let current: Promise<void> = Promise.resolve();
  let pollTimer: Timer | undefined;
  let deadlineTimer: Timer | undefined;
  let hardBoundTimer: Timer | undefined;
  let reports: Promise<void> = Promise.resolve();
  let lastReported: string | undefined;

  function state(): SourceState {
    const deadline = staleDeadline(lastCompleteMs, runnerStartMs, staleMultiplier, intervalMs);
    const blind = errorBlind ?? (now() > deadline ? staleBlind : undefined);
    return {
      ...(lastCompleteMs === undefined ? {} : { lastCompleteAt: iso(lastCompleteMs) }),
      ...(blind === undefined ? {} : { blind }),
      gone,
    };
  }

  /** Appends the current state to the serial report chain; resolves when its step is done. */
  function report(): Promise<void> {
    if (stopping) return reports;
    reports = reports.then(async () => {
      const next = state();
      const json = JSON.stringify(next);
      if (json === lastReported) return;
      try {
        await core.reportSourceState(source, next);
        lastReported = json;
      } catch (error) {
        // Not accepted: the next outcome reports again.
        fail('report', error);
      }
    });
    return reports;
  }

  function armDeadline(): void {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    const deadline = staleDeadline(lastCompleteMs, runnerStartMs, staleMultiplier, intervalMs);
    const delay = deadline + 1 - now();
    if (delay > 0) deadlineTimer = setTimeout(onDeadline, delay);
  }

  function onDeadline(): void {
    deadlineTimer = undefined;
    if (controller === undefined) {
      void report();
      return;
    }
    // The poll in flight may still complete: decide when it settles, or at the hard bound.
    const firedAt = now();
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
      current = poll().then(() => undefined);
    }, delayMs);
  }

  async function poll(): Promise<PollOutcome | undefined> {
    const abort = new AbortController();
    // A function, so each check reads the signal anew after an await.
    const aborted = () => abort.signal.aborted;
    controller = abort;
    const startMs = now();
    let outcome: PollOutcome;
    let step: PollFailure['step'] = 'context';
    try {
      const received = await core.context(source);
      const context =
        entry.repo === undefined
          ? received
          : {
              ...received,
              observe: {
                prs: received.observe.prs.filter(
                  (ref) => ref.repo.toLowerCase() === entry.repo?.toLowerCase(),
                ),
                tickets: [],
                sessions: [],
              },
            };
      if (aborted()) return;
      if (!hydrated) {
        counts = new Map(context.missCounts?.map(({ ref, count }) => [entityKey(ref), count]));
        hydrated = true;
      }
      const requested: GoneRef[] = [...context.observe.prs, ...context.observe.tickets];
      step = 'poll';
      const batch = await untilAborted(
        adapter.poll({ ...context, signal: abort.signal }),
        abort.signal,
      );
      // Only an abort ends the poll here; a missing or malformed batch fails validation below.
      if (aborted()) return;
      step = 'batch';
      const parsed = batchSchema.safeParse({ ...batch, observedAt: iso(startMs) });
      const invalid = !parsed.success
        ? undefined
        : parsed.data.source !== source
          ? 'names another source'
          : !answersRequest(context.observe, parsed.data.entities)
            ? 'does not answer the request'
            : undefined;
      if (!parsed.success || invalid !== undefined) {
        const reason = invalid ?? 'fails the batch schema';
        const error = new AdapterError('transient', `Invalid batch: ${reason}`);
        fail(
          'batch',
          error,
          parsed.error?.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
            message: issue.message,
          })),
        );
        outcome = { kind: 'failed', error };
      } else {
        step = 'outcomes';
        const outcomes = applyEntityOutcomes({
          counts,
          requested,
          batch: parsed.data,
          goneAfterPolls: config.sources.goneAfterPolls,
        });
        const proposedLastCompleteMs = outcomes.complete ? startMs : lastCompleteMs;
        const proposedBlind =
          now() > staleDeadline(proposedLastCompleteMs, runnerStartMs, staleMultiplier, intervalMs)
            ? staleBlind
            : undefined;
        const proposedState: SourceState = {
          ...(proposedLastCompleteMs === undefined
            ? {}
            : { lastCompleteAt: iso(proposedLastCompleteMs) }),
          ...(proposedBlind === undefined ? {} : { blind: proposedBlind }),
          gone: outcomes.gone,
        };
        const accepted = reports.then(async () => {
          await core.observe(source, {
            batch: parsed.data,
            effectiveComplete: outcomes.complete,
            state: proposedState,
            outcomes: outcomes.outcomes,
          });
          counts = outcomes.counts;
          gone = outcomes.gone;
          lastCompleteMs = proposedLastCompleteMs;
          errorBlind = undefined;
          lastReported = JSON.stringify(proposedState);
        });
        reports = accepted.then(
          () => undefined,
          () => undefined,
        );
        step = 'observe';
        await accepted;
        if (aborted()) return;
        outcome = { kind: 'delivered', budget: parsed.data.budget };
      }
    } catch (error) {
      if (aborted()) return;
      fail(step, error);
      if (error instanceof AdapterError && (error.kind === 'auth' || error.kind === 'config')) {
        errorBlind = { reason: error.kind, message: error.message };
      }
      outcome = { kind: 'failed', error };
    }
    controller = undefined;
    clearTimeout(hardBoundTimer);
    hardBoundTimer = undefined;
    const delay = nextDelay({
      outcome,
      intervalMs,
      failures,
      authRetryMs: config.sources.authRetryMs,
      reserveRemaining,
      now: now(),
    });
    failures = delay.failures;
    if (!options.oneShot) armDeadline();
    await report();
    if (!options.oneShot) schedule(delay.delayMs);
    return outcome;
  }

  if (!options.oneShot) armDeadline();
  const firstAttempt = poll();
  current = firstAttempt.then(() => undefined);

  return {
    id: source,
    firstAttempt,
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

/**
 * Settles with `work`, or with undefined as soon as `signal` aborts, so `stop()` never waits
 * for an adapter that ignores its signal. A late result or rejection is dropped. The abort
 * listener is removed once either side settles, so a retained signal holds nothing.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let settle: (value: undefined) => void = () => undefined;
  const abortion = new Promise<undefined>((resolve) => {
    settle = resolve;
  });
  const onAbort = () => {
    settle(undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([work, abortion]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
