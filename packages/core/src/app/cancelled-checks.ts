import { prFactsSchema, type PrFacts } from '@spur-board/contracts';
import { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { Trx } from './board-utils.ts';

// Under a `checksGate` right of Dev, a cancelled check counts as running until two complete
// scheduled polls after the one that saw it, then as red. The count lives in one `meta` row per PR
// and source; nothing reads it under a Dev gate.

/** Complete scheduled polls after the sighting that confirm a cancel as red. */
const CANCEL_CONFIRM_POLLS = 2;

const cancelledChecksSchema = z.strictObject({
  headSha: prFactsSchema.shape.headSha,
  cancelled: z.array(
    z.strictObject({
      name: z.string().min(1),
      completedAt: z.string().nullable(),
      polls: z.int().min(0),
    }),
  ),
});
type CancelledChecks = z.output<typeof cancelledChecksSchema>;

type PrChecks = Pick<
  PrFacts,
  'repo' | 'number' | 'state' | 'headSha' | 'checks' | 'requiredChecks'
>;

const cancelledChecksKey = (source: string, ref: { repo: string; number: number }): string =>
  `checks-cancel:${source}:pr:${ref.repo.toLowerCase()}#${String(ref.number)}`;

/** The stored counts on `headSha`; none when the row is absent, unreadable or for another head. */
async function countsOnHead(
  trx: Trx,
  key: string,
  headSha: string,
): Promise<CancelledChecks['cancelled']> {
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  if (row === undefined) return [];
  try {
    const saved = parseJson(cancelledChecksSchema, row.value);
    return saved.headSha.toLowerCase() === headSha.toLowerCase() ? saved.cancelled : [];
  } catch {
    return [];
  }
}

/** The cancelled checks on head, once each by name and completion time. */
function cancelledOnHead(fact: PrChecks): { name: string; completedAt: string | null }[] {
  const seen = new Set<string>();
  return [...fact.requiredChecks, ...fact.checks].flatMap((check) => {
    if (check.state !== 'cancelled') return [];
    const id = JSON.stringify([check.name, check.completedAt]);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ name: check.name, completedAt: check.completedAt }];
  });
}

const sameRun = (
  left: { name: string; completedAt: string | null },
  right: { name: string; completedAt: string | null },
) => left.name === right.name && left.completedAt === right.completedAt;

/**
 * Counts the polls since each cancelled check on the PR head was first seen: a new entry starts at
 * 0, a scheduled complete poll adds 1, and a head change starts over. It deletes the row of a PR
 * that is not open or has no cancelled check. Returns true when this poll confirms a cancel.
 */
export async function countCancelledChecks(
  trx: Trx,
  source: string,
  fact: PrChecks,
  scheduled: boolean,
): Promise<boolean> {
  const key = cancelledChecksKey(source, fact);
  const cancelled = fact.state === 'open' ? cancelledOnHead(fact) : [];
  if (cancelled.length === 0) {
    await trx.deleteFrom('meta').where('key', '=', key).execute();
    return false;
  }
  const head = fact.headSha.toLowerCase();
  const previous = await countsOnHead(trx, key, head);
  let confirmed = false;
  const next = cancelled.map((check) => {
    const before = previous.find((entry) => sameRun(entry, check));
    if (before === undefined) return { ...check, polls: 0 };
    if (!scheduled || before.polls >= CANCEL_CONFIRM_POLLS) return before;
    if (before.polls + 1 === CANCEL_CONFIRM_POLLS) confirmed = true;
    return { ...before, polls: before.polls + 1 };
  });
  const value = toJson(cancelledChecksSchema, { headSha: head, cancelled: next });
  await trx
    .insertInto('meta')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
  return confirmed;
}

/**
 * The PR with each cancelled check on head that is not confirmed yet read as pending: no stored
 * count for it on this head, or fewer than two complete polls since its sighting.
 */
export async function withUnconfirmedCancels(
  trx: Trx,
  source: string,
  pr: PrFacts,
): Promise<PrFacts> {
  if (cancelledOnHead(pr).length === 0) return pr;
  const counted = await countsOnHead(trx, cancelledChecksKey(source, pr), pr.headSha);
  const map = (checks: PrFacts['checks']): PrFacts['checks'] =>
    checks.map((check) =>
      check.state === 'cancelled' &&
      !counted.some((entry) => sameRun(entry, check) && entry.polls >= CANCEL_CONFIRM_POLLS)
        ? { ...check, state: 'pending' }
        : check,
    );
  return { ...pr, checks: map(pr.checks), requiredChecks: map(pr.requiredChecks) };
}
