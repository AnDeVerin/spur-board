import type { PrFacts } from '@spur-board/contracts';
import { z } from 'zod';

/** How long the facts of an open PR may be re-emitted before a full read. */
export const OPEN_REFRESH_MS = 900_000;
/** How long the facts of a merged or closed PR may be re-emitted before a full read. */
export const CLOSED_REFRESH_MS = 21_600_000;

const counted = <T extends z.ZodType>(node: T) =>
  z.object({ totalCount: z.int().nonnegative(), nodes: z.array(node) });
// Every field the fingerprint compares; vendor enums stay strings, so an unknown value still
// parses and only forces a full read.
const indexAliasWire = z.object({
  pullRequest: z.object({
    number: z.int().positive(),
    updatedAt: z.string(),
    state: z.string(),
    isDraft: z.boolean(),
    mergeable: z.string(),
    mergeStateStatus: z.string(),
    headRefOid: z.string(),
    // Each check by name and state: a SUCCESS rollup also covers skipped checks, which core
    // judges red when required, and `isRequired` is not read here.
    statusCheckRollup: z
      .object({
        state: z.string(),
        contexts: counted(
          z.union([
            z.object({
              __typename: z.literal('CheckRun'),
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
              completedAt: z.string().nullable(),
            }),
            z.object({
              __typename: z.literal('StatusContext'),
              context: z.string(),
              state: z.string(),
            }),
          ]),
        ),
      })
      .nullable(),
    reviews: counted(z.object({ id: z.string(), state: z.string() })),
    reviewThreads: counted(z.object({ isResolved: z.boolean() })),
    reviewRequests: counted(
      z.object({
        requestedReviewer: z
          .object({
            __typename: z.string(),
            login: z.string().optional(),
            slug: z.string().optional(),
          })
          .nullable(),
        asCodeOwner: z.boolean(),
      }),
    ),
    comments: counted(z.object({ id: z.string() })),
  }),
});

/** One PR as the light index read saw it in this poll. */
export interface IndexEntry {
  fingerprint: string;
  open: boolean;
  rollup: string | null;
  /**
   * Whether every listed check is green whether or not it is required: a completed check run
   * that succeeded or was neutral, or a successful status. The index omits `isRequired`, so a
   * skipped check could turn required with the fingerprint unchanged.
   */
  green: boolean;
  /**
   * Whether every check, review, review thread and review request is in the index; past the
   * first page one could change unseen, while the full read pages them all.
   */
  complete: boolean;
}
/** The facts of a PR's last full read, with the index fingerprint of the same poll. */
export interface CachedPr {
  fingerprint: string;
  facts: PrFacts;
  /** The PR's `feedbackCursors` entry at that read, or `none`. */
  cursorKey: string;
  readAt: number;
}

/** Reads one index alias; a shape that does not parse means the PR is read in full. */
export function indexEntry(alias: unknown): IndexEntry | undefined {
  const parsed = indexAliasWire.safeParse(alias);
  if (!parsed.success) return undefined;
  const pr = parsed.data.pullRequest;
  const whole = (conn: { totalCount: number; nodes: unknown[] }) =>
    conn.nodes.length >= conn.totalCount;
  return {
    fingerprint: JSON.stringify(pr),
    open: pr.state !== 'MERGED' && pr.state !== 'CLOSED',
    rollup: pr.statusCheckRollup?.state ?? null,
    green: (pr.statusCheckRollup?.contexts.nodes ?? []).every((node) =>
      node.__typename === 'StatusContext'
        ? node.state === 'SUCCESS'
        : node.status === 'COMPLETED' &&
          (node.conclusion === 'SUCCESS' || node.conclusion === 'NEUTRAL'),
    ),
    complete:
      (pr.statusCheckRollup === null || whole(pr.statusCheckRollup.contexts)) &&
      whole(pr.reviews) &&
      whole(pr.reviewThreads) &&
      whole(pr.reviewRequests),
  };
}

/**
 * The cached facts when the index shows the PR unchanged since its last full read and lists
 * every check, review, review thread and review request. An open PR is reused only with no
 * rollup or a `SUCCESS` one and every listed check green: a rollup that stays failed or pending
 * can hide a check that finished since, and a skipped check can turn required unseen.
 */
export function reusable(
  cached: CachedPr | undefined,
  entry: IndexEntry | undefined,
  cursorKey: string,
  now: number,
): PrFacts | undefined {
  if (cached === undefined || entry === undefined) return undefined;
  if (cached.fingerprint !== entry.fingerprint || cached.cursorKey !== cursorKey) return undefined;
  if (!cached.facts.feedbackComplete || !entry.complete) return undefined;
  if (now - cached.readAt >= (entry.open ? OPEN_REFRESH_MS : CLOSED_REFRESH_MS)) return undefined;
  if (entry.open && ((entry.rollup !== null && entry.rollup !== 'SUCCESS') || !entry.green)) {
    return undefined;
  }
  return cached.facts;
}
