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
    statusCheckRollup: z.object({ state: z.string() }).nullable(),
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
  return {
    fingerprint: JSON.stringify(pr),
    open: pr.state !== 'MERGED' && pr.state !== 'CLOSED',
    rollup: pr.statusCheckRollup?.state ?? null,
  };
}

/**
 * The cached facts when the index shows the PR unchanged since its last full read. An open PR
 * is reused only with no rollup or a `SUCCESS` one: a rollup that stays failed or pending can
 * hide a check that finished since.
 */
export function reusable(
  cached: CachedPr | undefined,
  entry: IndexEntry | undefined,
  cursorKey: string,
  now: number,
): PrFacts | undefined {
  if (cached === undefined || entry === undefined) return undefined;
  if (cached.fingerprint !== entry.fingerprint || cached.cursorKey !== cursorKey) return undefined;
  if (!cached.facts.feedbackComplete) return undefined;
  if (now - cached.readAt >= (entry.open ? OPEN_REFRESH_MS : CLOSED_REFRESH_MS)) return undefined;
  if (entry.open && entry.rollup !== null && entry.rollup !== 'SUCCESS') return undefined;
  return cached.facts;
}
