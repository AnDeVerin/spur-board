import { createHash } from 'node:crypto';

/** Every operator item kind; `ITEM_POLICY` must give each one a policy. */
const ITEM_KINDS = [
  'token_request',
  'post_blocked',
  'post_failed',
  'transport_health',
  'answer_undelivered',
  'worker_not_reading',
  'answer_author_unavailable',
  'inbound_failure',
  'inbound_gap',
  'board_observation',
  'worker_ended',
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/** What `board item retry` does for a kind; `never_sent` and `none` refuse with a hint. */
type RetryAction =
  'requeue_post' | 'restart_ring' | 'reapply_inbound' | 'probe_transport' | 'never_sent' | 'none';

interface ItemPolicy {
  retry: RetryAction;
  /** Whether a raise enqueues a feed line. */
  feed: boolean;
  /** The stored priority when the raise names none. */
  priority: number;
  buttons: 'approve_deny' | 'item';
  /** Whether `reconcileItems` raises and clears the kind from board state. */
  reconciled: boolean;
}

export const ITEM_POLICY = {
  token_request: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'approve_deny',
    reconciled: false,
  },
  post_blocked: {
    retry: 'never_sent',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
  },
  post_failed: {
    retry: 'requeue_post',
    feed: false,
    priority: 1,
    buttons: 'item',
    reconciled: true,
  },
  transport_health: {
    retry: 'probe_transport',
    feed: false,
    priority: 1,
    buttons: 'item',
    reconciled: false,
  },
  answer_undelivered: {
    retry: 'restart_ring',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: false,
  },
  worker_not_reading: {
    retry: 'restart_ring',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
  },
  answer_author_unavailable: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
  },
  inbound_failure: {
    retry: 'reapply_inbound',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
  },
  inbound_gap: { retry: 'none', feed: true, priority: 4, buttons: 'item', reconciled: false },
  board_observation: { retry: 'none', feed: true, priority: 4, buttons: 'item', reconciled: true },
  worker_ended: { retry: 'none', feed: false, priority: 4, buttons: 'item', reconciled: true },
} as const satisfies Record<ItemKind, ItemPolicy>;

/** Guards a stored kind: the column is free text and old or hand-written rows may hold others. */
export function isItemKind(kind: string): kind is ItemKind {
  return Object.hasOwn(ITEM_POLICY, kind);
}

/** Whether the kind's feed line and status entry offer Retry. */
export function hasRetryButton(kind: ItemKind): boolean {
  const retry: RetryAction = ITEM_POLICY[kind].retry;
  return (
    retry === 'requeue_post' ||
    retry === 'restart_ring' ||
    retry === 'reapply_inbound' ||
    retry === 'probe_transport'
  );
}

type ReconciledKind = {
  [K in ItemKind]: (typeof ITEM_POLICY)[K]['reconciled'] extends true ? K : never;
}[ItemKind];

/** The kinds `reconcileItems` owns: it clears an active one whose candidate is gone. */
export const RECONCILED_KINDS = ITEM_KINDS.filter(
  (kind): kind is ReconciledKind => ITEM_POLICY[kind].reconciled,
);

export interface ItemCandidate {
  key: string;
  kind: ReconciledKind;
  taskId: number | null;
  summary: string;
  factAt: string | null;
  source: string | null;
  priority: number;
  revision?: string | null;
}

export function fingerprint(
  candidate: Pick<ItemCandidate, 'key' | 'summary' | 'source' | 'revision'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        candidate.key,
        candidate.summary,
        candidate.source,
        candidate.revision ?? null,
      ]),
    )
    .digest('hex');
}

/** Stable ordering within priority, then by item identity. */
export function orderItems(items: readonly ItemCandidate[]): ItemCandidate[] {
  return [...items].sort(
    (left, right) => left.priority - right.priority || left.key.localeCompare(right.key),
  );
}
