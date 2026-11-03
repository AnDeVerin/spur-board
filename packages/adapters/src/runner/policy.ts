// Pure scheduling and completeness rules of the adapter runner. No timers, no I/O.
import {
  AdapterError,
  type Batch,
  type EntityRef,
  type PollContext,
  type PrEntityRef,
  type TicketEntityRef,
} from '@spur-board/contracts';

/** The longest wait between two failed polls, unless the interval itself is longer. */
const MAX_BACKOFF_MS = 900_000;

/** A ref that can turn gone: sessions never do (A4). */
export type GoneRef = PrEntityRef | TicketEntityRef;

/** Shortens a delay by up to 10 percent, so sources do not poll in lockstep. */
function jitter(delayMs: number): number {
  return Math.round(delayMs * (1 - 0.1 * Math.random()));
}

/** How long to wait when the budget fell below the reserve; undefined when no pause is due. */
function budgetPause(
  budget: Batch['budget'],
  reserveRemaining: number | undefined,
  intervalMs: number,
  now: number,
): number | undefined {
  if (reserveRemaining === undefined || budget === undefined) return undefined;
  if (budget.remaining >= reserveRemaining) return undefined;
  return Math.max(Date.parse(budget.resetAt) - now, intervalMs);
}

export type PollOutcome =
  { kind: 'delivered'; budget?: Batch['budget'] | undefined } | { kind: 'failed'; error: unknown };

export interface DelayInput {
  outcome: PollOutcome;
  intervalMs: number;
  /** Consecutive transient failures before this outcome. */
  failures: number;
  authRetryMs: number;
  reserveRemaining?: number | undefined;
  /** When the poll ended. */
  now: number;
}

export interface Delay {
  delayMs: number;
  failures: number;
}

/** The wait before the next poll and the new failure count. */
export function nextDelay(input: DelayInput): Delay {
  const { outcome, intervalMs, failures, now } = input;
  if (outcome.kind === 'delivered') {
    const pause = budgetPause(outcome.budget, input.reserveRemaining, intervalMs, now);
    return { delayMs: pause ?? jitter(intervalMs), failures: 0 };
  }
  const { error } = outcome;
  if (error instanceof AdapterError) {
    if (error.kind === 'auth' || error.kind === 'config') {
      return { delayMs: jitter(input.authRetryMs), failures };
    }
    const retryAt = error.retryAt?.getTime();
    if (error.kind === 'throttled' && retryAt !== undefined && !Number.isNaN(retryAt)) {
      return { delayMs: Math.max(retryAt - now, intervalMs), failures };
    }
  }
  const next = failures + 1;
  const cap = Math.max(MAX_BACKOFF_MS, intervalMs);
  return { delayMs: jitter(Math.min(intervalMs * 2 ** next, cap)), failures: next };
}

/** The time after which a source without a new complete observation is blind stale. */
export function staleDeadline(
  lastCompleteMs: number | undefined,
  runnerStartMs: number,
  staleMultiplier: number,
  intervalMs: number,
): number {
  return (lastCompleteMs ?? runnerStartMs) + staleMultiplier * intervalMs;
}

/** When a stale decision deferred for an in-flight poll is forced. */
export function staleHardBound(firedAt: number, staleMultiplier: number, intervalMs: number) {
  return firedAt + staleMultiplier * intervalMs + 1;
}

/** The identity a requested entity and its batch entry share. */
function entityKey(ref: EntityRef): string {
  switch (ref.kind) {
    case 'pr':
      return JSON.stringify([ref.kind, ref.repo, ref.number]);
    case 'ticket':
      return JSON.stringify([ref.kind, ref.trackerId, ref.id]);
    case 'session':
      return JSON.stringify([ref.kind, ref.id]);
  }
}

/** Whether `entities` holds an entry for each requested ref and nothing else (A4). */
export function answersRequest(
  observe: PollContext['observe'],
  entities: Batch['entities'],
): boolean {
  const requested = new Set(
    [...observe.prs, ...observe.tickets, ...observe.sessions].map((ref) => entityKey(ref)),
  );
  const answered = new Set(entities.map((entity) => entityKey(entity.ref)));
  return (
    answered.size === entities.length &&
    answered.size === requested.size &&
    [...requested].every((key) => answered.has(key))
  );
}

export interface EntityOutcomes {
  /** Per entity key: consecutive complete batches the ref was not_found or no_access in. */
  counts: Map<string, number>;
  gone: GoneRef[];
  /** The batch is complete and every requested PR and ticket is ok or gone. */
  complete: boolean;
}

/** Applies one delivered batch to the gone counts. */
export function applyEntityOutcomes(input: {
  counts: ReadonlyMap<string, number>;
  requested: readonly GoneRef[];
  batch: Pick<Batch, 'complete' | 'entities'>;
  goneAfterPolls: number;
}): EntityOutcomes {
  const { batch, goneAfterPolls } = input;
  const statuses = new Map(batch.entities.map((entity) => [entityKey(entity.ref), entity.status]));
  const counts = new Map<string, number>();
  const gone: GoneRef[] = [];
  let complete = batch.complete;
  for (const ref of input.requested) {
    const key = entityKey(ref);
    if (counts.has(key)) continue;
    const status = statuses.get(key);
    let count = input.counts.get(key) ?? 0;
    // An ok answer proves the entity is back in any batch; only a complete one counts a miss.
    if (status === 'ok') count = 0;
    else if (batch.complete && status !== undefined) count += 1;
    counts.set(key, count);
    const isGone = count >= goneAfterPolls;
    if (isGone) gone.push(ref);
    if (status !== 'ok' && !isGone) complete = false;
  }
  return { counts, gone, complete };
}
