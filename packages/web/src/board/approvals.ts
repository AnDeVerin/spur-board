// Approval freshness as data: how each latest approval of a PR stands against its head, read
// only from the facts `status.get` and `task.get` carry. A hint for the operator, never a gate.
import type { BoardRow } from './model.ts';

type PrSummary = NonNullable<BoardRow['prSummary']>[number];
export type ApprovalView = NonNullable<PrSummary['approvals']>[number];
type NotCounted = NonNullable<ApprovalView['notCounted']>;

/** Why the commits after an approval were not counted, as the card and the task view say it. */
export const NOT_COUNTED: Record<NotCounted, string> = {
  history_rewritten: 'history rewritten after the approval',
  rate_limit: 'GitHub rate limit',
  pr_too_large: 'the PR is too large to compare',
};

/** The title of a changed entry's chip in a task view row. */
export const changedTitle = (watched: boolean) =>
  `Changed since the approval; ${watched ? 'watched' : 'not watched'}`;

/** `1 commit`, `N commits`. */
export const plural = (count: number, word: string) =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The first 7 characters of a commit SHA. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * `fresh` on the head, `stale` with commits counted after it, `rewritten` or `uncounted` when
 * not counted, `unread` before the first read.
 */
type ApprovalKind = 'fresh' | 'stale' | 'rewritten' | 'uncounted' | 'unread';

export interface ApprovalState {
  approval: ApprovalView;
  kind: ApprovalKind;
  /** Asks for a look before the merge: a watched entry changed after it, or history rewritten. */
  loud: boolean;
  /** The watched entries changed after it; empty unless stale. */
  watched: string[];
}

/** How one approval stands against the head. Watched means `watchedAfter`, never the config. */
export function approvalState(approval: ApprovalView): ApprovalState {
  const state = (kind: ApprovalKind, loud = false, watched: string[] = []) => ({
    approval,
    kind,
    loud,
    watched,
  });
  if (approval.notCounted === 'history_rewritten') return state('rewritten', true);
  if (approval.notCounted !== undefined) return state('uncounted');
  if (approval.onHead) return state('fresh');
  if (approval.commitsAfter === undefined) return state('unread');
  const watched = approval.watchedAfter ?? [];
  return state('stale', watched.length > 0, watched);
}

const RANK: Record<ApprovalKind, number> = {
  rewritten: 4,
  stale: 3,
  uncounted: 1,
  unread: 1,
  fresh: 0,
};

/** Every approval's state and the worst one: loud first, then by kind; ties keep the order. */
export function approvalSummary(views: readonly ApprovalView[]): {
  states: ApprovalState[];
  worst: ApprovalState | null;
} {
  const states = views.map(approvalState);
  const sorted = [...states].sort(
    (a, b) => Number(b.loud) - Number(a.loud) || RANK[b.kind] - RANK[a.kind],
  );
  return { states, worst: sorted[0] ?? null };
}

/** The card cell's quiet suffix and its tooltip for the worst approval. */
export function approvalSuffix(worst: ApprovalState): { text: string; title: string } {
  const { approval } = worst;
  switch (worst.kind) {
    case 'fresh':
      return { text: '', title: 'Approved on the head' };
    case 'stale': {
      const changed = approval.changedAfter ?? [];
      return {
        text: `+${String(approval.commitsAfter ?? 0)}`,
        title: `Approved ${plural(approval.commitsAfter ?? 0, 'commit')} ago; changed since: ${
          changed.length === 0 ? 'nothing' : changed.join(', ')
        }`,
      };
    }
    case 'unread':
      return { text: '?', title: 'Changes since the approval not read yet' };
    case 'rewritten':
    case 'uncounted':
      return {
        text: '?',
        title: `Changes since the approval not counted: ${
          NOT_COUNTED[approval.notCounted ?? 'history_rewritten']
        }`,
      };
  }
}

/** The card chip names at most this many watched entries, then `+K`; its title names all. */
const CHIP_ENTRIES = 2;

/** The card's warn chip text and tooltip for a loud worst approval; null when quiet. */
export function approvalChip(worst: ApprovalState | null): { text: string; title: string } | null {
  if (worst === null || !worst.loud) return null;
  if (worst.kind === 'rewritten')
    return {
      text: 'approval: history rewritten',
      title: 'The history was rewritten after the approval; what changed since is not counted.',
    };
  const { approval, watched } = worst;
  const more = watched.length - CHIP_ENTRIES;
  return {
    text: `approved before ${watched.slice(0, CHIP_ENTRIES).join(' ')}${
      more > 0 ? ` +${String(more)}` : ''
    }`,
    title: `${approval.author} approved ${approval.sha}; ${plural(
      approval.commitsAfter ?? 0,
      'commit',
    )} since changed ${watched.join(', ')}.`,
  };
}
