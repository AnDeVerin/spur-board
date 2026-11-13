// Runs each adapter on a single-flight timer chain, hands its batches to core and reports
// the state of its source: the last complete observation, blindness and gone entities.
import {
  AdapterError,
  batchSchema,
  err,
  ok,
  type Adapter,
  type AdapterCore,
  type AdapterErrorKind,
  type Batch,
  type Config,
  type PollPrError,
  type PollPrResult,
  type PollPrValue,
  type PrEntityRef,
  type PrPoller,
  type SourceState,
} from '@spur-board/contracts';
import {
  answersRequest,
  applyEntityOutcomes,
  entityKey,
  nextDelay,
  staleDeadline,
  staleHardBound,
  throttledRetryAt,
  type GoneRef,
  type PollOutcome,
} from './policy.ts';

/** The setTimeout limit: a longer delay would otherwise fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

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
  /**
   * Polls one PR out of turn on its source's single-flight chain and commits it through core;
   * always set by `startRunner`.
   */
  pollPr?: PrPoller['pollPr'] | undefined;
  /**
   * Aborts the in-flight polls, resolves pending on-demand requests as `stopped`, clears every
   * timer and waits for pending reports.
   */
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
  now: () => number;
  oneShot?: boolean;
  /** Called for every failed poll step and rejected report; an abort is not one. A throw is ignored. */
  onFailure?: ((failure: PollFailure) => void) | undefined;
}

export function startRunner(options: RunnerOptions): AdapterRunner {
  const startedAt = options.now();
  const sources = options.entries.map((entry) => runSource(entry, options, startedAt));
  const byId = new Map(sources.map((source) => [source.id, source]));
  return {
    firstAttempts: Promise.all(
      sources.map(async (source) => ({
        source: source.id,
        outcome: await source.firstAttempt,
      })),
    ),
    pollPr(source, ref, { timeoutMs }) {
      const found = byId.get(source);
      if (found === undefined) {
        return Promise.resolve(
          err({ kind: 'unknown_source', message: `No source with id ${source}` }),
        );
      }
      return found.pollPr(ref, timeoutMs);
    },
    async stop() {
      await Promise.all(sources.map((source) => source.stop()));
    },
  };
}

type Blind = NonNullable<SourceState['blind']>;
type Timer = ReturnType<typeof setTimeout>;

const noop = () => undefined;
const stoppedError: PollPrError = { kind: 'stopped', message: 'The adapter runner is stopping' };

function runSource(entry: RunnerEntry, options: RunnerOptions, runnerStartMs: number) {
  const { adapter, reserveRemaining } = entry;
  const { core, config } = options;
  const { now } = options;
  const source = adapter.id;
  const { intervalMs } = adapter;
  const { staleMultiplier } = config.thresholds;
  const staleBlind: Blind = {
    reason: 'stale',
    message: `No complete observation in ${String(staleMultiplier)} poll intervals`,
  };

  function fail(step: PollFailure['step'], error: unknown, issues?: PollFailure['issues']) {
    const kind = error instanceof AdapterError ? error.kind : 'unexpected';
    try {
      options.onFailure?.({
        source,
        step,
        kind,
        error,
        ...(issues === undefined ? {} : { issues }),
      });
    } catch {
      // The callback is the log sink, so nothing is left to report to: a throw must not end the
      // poll loop, poison the report chain or reject stop().
    }
  }

  let stopping = false;
  let failures = 0;
  let lastCompleteMs: number | undefined;
  let errorBlind: Blind | undefined;
  let counts: ReadonlyMap<string, number> = new Map();
  let hydrated = false;
  let gone: readonly GoneRef[] = [];
  /** Set while a regular poll is in flight. */
  let controller: AbortController | undefined;
  /** Unsettled on-demand requests; each entry resolves its request as stopped unless observing. */
  const pending = new Set<() => void>();
  /** Until when a regular throttled failure forbids calling the source. */
  let throttledUntilMs: number | undefined;
  /** Tail of the single-flight chain: regular polls and on-demand requests, one at a time. */
  let chain: Promise<void> = Promise.resolve();
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

  /** Runs `task` after every task queued before it has settled. */
  function run<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task);
    chain = result.then(noop, noop);
    return result;
  }

  function schedule(delayMs: number): void {
    if (stopping) return;
    pollTimer = setTimeout(
      () => {
        pollTimer = undefined;
        void run(poll);
      },
      Math.min(delayMs, MAX_TIMER_MS),
    );
  }

  async function poll(): Promise<PollOutcome | undefined> {
    if (stopping) return;
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
    throttledUntilMs = outcome.kind === 'failed' ? throttledRetryAt(outcome.error) : undefined;
    if (!options.oneShot) armDeadline();
    await report();
    if (!options.oneShot) schedule(delay.delayMs);
    return outcome;
  }

  /** One on-demand request at its turn on the chain; `live` is false once its caller left. */
  async function demandTurn(
    ref: PrEntityRef,
    abort: AbortController,
    live: () => boolean,
    observing: () => void,
  ): Promise<PollPrResult | undefined> {
    if (stopping) return err(stoppedError);
    if (!live()) return;
    const startMs = now();
    const blind = state().blind;
    if (blind !== undefined) {
      return err({ kind: 'blind', reason: blind.reason, message: blind.message });
    }
    if (adapter.pollPr === undefined) {
      return err({ kind: 'unsupported', message: 'The source does not poll one PR on demand' });
    }
    if (throttledUntilMs !== undefined && startMs < throttledUntilMs) {
      return err({
        kind: 'failed',
        adapterKind: 'throttled',
        retryAt: iso(throttledUntilMs),
        message: 'The source is throttled until retryAt',
      });
    }
    const aborted = () => abort.signal.aborted;
    let step: PollFailure['step'] = 'context';
    try {
      // Only this ref's feedback cursor and held history; the adapter merges but never states it.
      const received = await untilAborted(core.context(source), abort.signal);
      if (aborted() || received === undefined) return err(stoppedError);
      const own = ({ ref: held }: { ref: PrEntityRef }): boolean =>
        held.number === ref.number && held.repo.toLowerCase() === ref.repo.toLowerCase();
      const feedbackCursors = received.feedbackCursors?.filter(own) ?? [];
      const continuations = received.continuations?.filter(own) ?? [];
      step = 'poll';
      const batch = await untilAborted(
        adapter.pollPr(ref, {
          signal: abort.signal,
          ...(feedbackCursors.length === 0 ? {} : { feedbackCursors }),
          ...(continuations.length === 0 ? {} : { continuations }),
        }),
        abort.signal,
      );
      // Aborted by stop() or by the timeout; after a timeout the caller already has its answer.
      if (aborted()) return err(stoppedError);
      step = 'batch';
      const observedAt = iso(startMs);
      const parsed = batchSchema.safeParse({ ...batch, observedAt });
      const value = parsed.success ? demandValue(parsed.data, observedAt) : undefined;
      const invalid = !parsed.success
        ? undefined
        : parsed.data.source !== source
          ? 'names another source'
          : !answersRequest({ prs: [ref], tickets: [], sessions: [] }, parsed.data.entities)
            ? 'does not answer the request'
            : parsed.data.complete
              ? 'is marked complete'
              : parsed.data.cursor !== undefined
                ? 'carries a cursor'
                : parsed.data.items.some(
                      (item) => item.kind === 'pr' && item.continuation !== undefined,
                    )
                  ? 'carries a continuation'
                  : value === undefined
                    ? 'carries another item'
                    : undefined;
      if (!parsed.success || invalid !== undefined || value === undefined) {
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
        return err({ kind: 'failed', adapterKind: 'transient', message: error.message });
      }
      step = 'observe';
      // The timeout and stop() stay armed until this request's turn on the report chain.
      const accepted = reports.then(async (): Promise<PollPrResult | undefined> => {
        if (!live()) return;
        if (stopping) return err(stoppedError);
        observing();
        const committed = state();
        await core.observe(source, {
          batch: parsed.data,
          effectiveComplete: false,
          state: committed,
          outcomes: [],
        });
        lastReported = JSON.stringify(committed);
        return ok(value);
      });
      reports = accepted.then(noop, noop);
      return await accepted;
    } catch (error) {
      if (aborted()) return err(stoppedError);
      fail(step, error);
      const retryAt = throttledRetryAt(error);
      return err({
        kind: 'failed',
        adapterKind: error instanceof AdapterError ? error.kind : 'unexpected',
        ...(retryAt === undefined ? {} : { retryAt: iso(retryAt) }),
        message: error instanceof AdapterError ? error.message : `The ${step} step failed`,
      });
    }
  }

  function pollPr(ref: PrEntityRef, timeoutMs: number): Promise<PollPrResult> {
    if (entry.repo !== undefined && ref.repo.toLowerCase() !== entry.repo.toLowerCase()) {
      return Promise.resolve(
        err({ kind: 'unknown_source', message: `The source does not own ${ref.repo}` }),
      );
    }
    if (stopping) return Promise.resolve(err(stoppedError));
    return new Promise((resolve) => {
      const abort = new AbortController();
      let settled = false;
      let observing = false;
      const settle = (result: PollPrResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        resolve(result);
      };
      // Once core commits, the caller gets the real result.
      const cancel = () => {
        if (observing) return;
        settle(err(stoppedError));
        abort.abort();
      };
      pending.add(cancel);
      const timer = setTimeout(() => {
        // Once core commits, the caller gets the real result.
        if (observing) return;
        settle(err({ kind: 'timeout', message: 'The on-demand poll timed out' }));
        abort.abort();
      }, timeoutMs);
      void run(async () => {
        const result = await demandTurn(
          ref,
          abort,
          () => !settled,
          () => {
            observing = true;
          },
        );
        if (result !== undefined) settle(result);
      });
    });
  }

  if (!options.oneShot) armDeadline();
  const firstAttempt = run(poll);

  return {
    id: source,
    firstAttempt,
    pollPr,
    async stop(): Promise<void> {
      stopping = true;
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(hardBoundTimer);
      pollTimer = deadlineTimer = hardBoundTimer = undefined;
      controller?.abort();
      for (const cancel of [...pending]) cancel();
      await chain;
      await reports;
    },
  };
}

/** The answer of an A9 batch: its one entity and at most that PR's own item; else undefined. */
function demandValue(batch: Batch, observedAt: string): PollPrValue | undefined {
  const [entity] = batch.entities;
  const [item, ...rest] = batch.items;
  if (entity === undefined) return undefined;
  if (entity.status !== 'ok') {
    return item === undefined ? { status: entity.status, observedAt } : undefined;
  }
  return item?.kind === 'pr' && rest.length === 0
    ? { status: 'ok', facts: item.facts, observedAt }
    : undefined;
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
