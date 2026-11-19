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
  type PollContext,
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

function answersProbes(context: Omit<PollContext, 'signal'>, batch: Batch): boolean {
  const probes = batch.prProbes ?? [];
  const key = (ref: PrEntityRef) => `${ref.repo.toLowerCase()}#${String(ref.number)}`;
  const allowed = new Set(
    [
      ...(context.prRechecks ?? []),
      ...(context.terminalPrs ?? [])
        .filter((entry) => entry.state === 'closed')
        .map((entry) => entry.ref),
    ].map(key),
  );
  const seen = new Set<string>();
  for (const probe of probes) {
    const identity = key(probe.ref);
    if (!allowed.has(identity) || seen.has(identity)) return false;
    seen.add(identity);
    const item = batch.items.some(
      (item) =>
        item.kind === 'pr' &&
        key({ kind: 'pr', repo: item.facts.repo, number: item.facts.number }) === identity,
    );
    if ((probe.status === 'refreshed') !== item) return false;
  }
  return (context.prRechecks ?? []).every((ref) => seen.has(key(ref)));
}

/** The setTimeout limit: a longer delay would otherwise fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
/** Waits before the second and third attempt of an on-demand poll after a transient failure. */
const DEMAND_RETRY_WAITS_MS = [1_000, 2_000] as const;

interface RunnerEntry {
  adapter: Adapter;
  /** Repository owned by a GitHub PR source. */
  repo?: string;
  /** Pause the source while its reported budget is below this. */
  reserveRemaining?: number | undefined;
}

export interface AdapterRunner {
  /**
   * Sources whose next regular poll this runner has put off for a rate limit: the last regular
   * poll delivered a budget under its reserve or failed as throttled with a retry time, and the
   * paused poll has not started. An
   * on-demand poll never adds or removes one, and `stop` removes every one. `startRunner` owns
   * the set and `startAdapters` passes the same set through (both return a `StartedRunner`, so
   * the compiler rejects a wrapper that drops it); empty in one-shot mode. Optional only for
   * test stand-ins.
   */
  budgetWaits?: ReadonlySet<string> | undefined;
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

/** A runner `startRunner` and `startAdapters` return: its budget waits are always present. */
export type StartedRunner = AdapterRunner & { budgetWaits: ReadonlySet<string> };

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

export function startRunner(options: RunnerOptions): StartedRunner {
  const startedAt = options.now();
  const budgetWaits = new Set<string>();
  const sources = options.entries.map((entry) => runSource(entry, options, startedAt, budgetWaits));
  const byId = new Map(sources.map((source) => [source.id, source]));
  return {
    budgetWaits,
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

function runSource(
  entry: RunnerEntry,
  options: RunnerOptions,
  runnerStartMs: number,
  budgetWaits: Set<string>,
) {
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
  let pendingPoints: number | undefined;
  function report(usage?: Batch['usage'], allowStopped = false): Promise<void> {
    if (usage !== undefined) pendingPoints = (pendingPoints ?? 0) + usage.points;
    if (stopping && !allowStopped) return reports;
    reports = reports.then(async () => {
      const next = state();
      const json = JSON.stringify(next);
      if (json === lastReported && pendingPoints === undefined) return;
      const points = pendingPoints;
      try {
        await core.reportSourceState(source, next, points === undefined ? undefined : { points });
        if (points !== undefined)
          pendingPoints = pendingPoints === points ? undefined : (pendingPoints ?? 0) - points;
        lastReported = json;
      } catch (error) {
        // Not accepted: the next outcome reports again.
        fail('report', error);
      }
    });
    return reports;
  }

  /** Drain synchronously on abort, before the adapter unwinds or stop waits for reports. */
  async function readSource(
    read: () => Promise<Batch>,
    signal: AbortSignal,
  ): Promise<Batch | undefined> {
    const takeUsage = adapter.takeUsage?.bind(adapter);
    if (takeUsage === undefined) return untilAborted(read(), signal);
    const onAbort = () => {
      const usage = takeUsage();
      if (usage !== undefined) void report(usage, true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await untilAborted(read(), signal);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
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

  /** Arms the next regular poll; `budgetWait` marks it as put off for the rate budget. */
  function schedule(delayMs: number, budgetWait: boolean): void {
    if (stopping) return;
    if (budgetWait) budgetWaits.add(source);
    pollTimer = setTimeout(
      () => {
        pollTimer = undefined;
        budgetWaits.delete(source);
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
    let usage: Batch['usage'];
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
      const batch = await readSource(
        () => adapter.poll({ ...context, signal: abort.signal }),
        abort.signal,
      );
      // Only an abort ends the poll here; a missing or malformed batch fails validation below.
      if (aborted()) return;
      usage = batch?.usage;
      step = 'batch';
      const parsed = batchSchema.safeParse({ ...batch, observedAt: iso(startMs) });
      const invalid = !parsed.success
        ? undefined
        : parsed.data.source !== source
          ? 'names another source'
          : !answersProbes(context, parsed.data)
            ? 'does not answer state probes'
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
          usage = undefined;
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
      if (error instanceof AdapterError && error.usage !== undefined) usage = error.usage;
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
    await report(usage);
    if (!options.oneShot) schedule(delay.delayMs, delay.budgetWait);
    return outcome;
  }

  /**
   * One on-demand request at its turn on the chain; `live` is false once its caller left.
   * `retryable` is called before it returns a `transient` failure of the `poll` step.
   */
  async function demandTurn(
    ref: PrEntityRef,
    abort: AbortController,
    live: () => boolean,
    observing: () => void,
    retryable: () => void,
  ): Promise<PollPrResult | undefined> {
    if (stopping) return err(stoppedError);
    if (!live()) return;
    const startMs = now();
    const blind = state().blind;
    if (blind !== undefined) {
      return err({ kind: 'blind', reason: blind.reason, message: blind.message });
    }
    const pollOne = adapter.pollPr?.bind(adapter);
    if (pollOne === undefined) {
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
    let usage: Batch['usage'];
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
      const batch = await readSource(
        () =>
          pollOne(ref, {
            signal: abort.signal,
            ...(feedbackCursors.length === 0 ? {} : { feedbackCursors }),
            ...(continuations.length === 0 ? {} : { continuations }),
          }),
        abort.signal,
      );
      // Aborted by stop() or by the timeout; after a timeout the caller already has its answer.
      if (aborted()) return err(stoppedError);
      usage = batch?.usage;
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
            : (parsed.data.prProbes?.length ?? 0) > 0
              ? 'carries state probes'
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
        await report(usage);
        return err({ kind: 'failed', adapterKind: 'transient', message: error.message });
      }
      step = 'observe';
      // The timeout and stop() stay armed until this request's turn on the report chain.
      const accepted = reports.then(async (): Promise<PollPrResult | undefined> => {
        if (!live()) return;
        if (stopping) return err(stoppedError);
        observing();
        // Full positive demand facts recover this PR just like an ordinary ok outcome.
        // Stage recovery until core accepts it; rejected/expired reads cannot change counts.
        const recoveredKey = value.status === 'ok' ? entityKey(ref).toLowerCase() : undefined;
        const recoveredCounts =
          recoveredKey === undefined
            ? counts
            : new Map([...counts].filter(([key]) => key.toLowerCase() !== recoveredKey));
        const recoveredGone =
          recoveredKey === undefined
            ? gone
            : gone.filter((known) => entityKey(known).toLowerCase() !== recoveredKey);
        const committed = { ...state(), gone: recoveredGone };
        await core.observe(source, {
          batch: parsed.data,
          effectiveComplete: false,
          state: committed,
          outcomes: [],
        });
        usage = undefined;
        counts = recoveredCounts;
        gone = recoveredGone;
        lastReported = JSON.stringify(committed);
        return ok(value);
      });
      reports = accepted.then(noop, noop);
      const result = await accepted;
      // A completed read consumed points even when timeout/stop discarded its queued facts.
      if (usage !== undefined) {
        await report(usage, true);
        usage = undefined;
      }
      return result;
    } catch (error) {
      if (aborted()) return err(stoppedError);
      if (error instanceof AdapterError && error.usage !== undefined) usage = error.usage;
      fail(step, error);
      if (step === 'poll' && error instanceof AdapterError && error.kind === 'transient') {
        retryable();
      }
      await report(usage);
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
      const deadlineMs = now() + timeoutMs;
      let settled = false;
      let observing = false;
      let attempts = 0;
      let retryTimer: Timer | undefined;
      const settle = (result: PollPrResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(retryTimer);
        retryTimer = undefined;
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
      // A transient source failure goes back on the chain after a wait, inside the deadline.
      const attempt = () =>
        run(async () => {
          let retry = false;
          // A function, so the read sees the flag the callback set during the await.
          const transient = () => retry;
          const result = await demandTurn(
            ref,
            abort,
            () => !settled,
            () => {
              observing = true;
            },
            () => {
              retry = true;
            },
          );
          if (result === undefined) return;
          const waitMs = DEMAND_RETRY_WAITS_MS[attempts];
          attempts += 1;
          if (transient() && waitMs !== undefined && !settled && now() + waitMs < deadlineMs) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void attempt();
            }, waitMs);
            return;
          }
          settle(result);
        });
      void attempt();
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
      budgetWaits.delete(source);
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
