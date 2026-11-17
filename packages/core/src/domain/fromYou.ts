import { ITEM_KINDS, type INBOX_SEVERITIES } from '@spur-board/contracts';
import { createHash } from 'node:crypto';

export type ItemKind = (typeof ITEM_KINDS)[number];
type Severity = (typeof INBOX_SEVERITIES)[number];

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
  /**
   * Whether the item is the ledger of an operator block: its raise opens the block, its clear
   * closes it, and the block, not a feed line, is what the operator sees.
   */
  block: boolean;
  /**
   * How `inbox.operator` marks the kind: `failure` when the board or a connection broke, else
   * `attention` when a decision, answer or other operator action is wanted. A `source:` item is a
   * failure whatever its kind.
   */
  severity: Severity;
}

export const ITEM_POLICY = {
  token_request: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'approve_deny',
    reconciled: false,
    block: false,
    severity: 'attention',
  },
  post_blocked: {
    retry: 'never_sent',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'attention',
  },
  post_failed: {
    retry: 'requeue_post',
    feed: false,
    priority: 1,
    buttons: 'item',
    reconciled: true,
    block: false,
    severity: 'failure',
  },
  transport_health: {
    retry: 'probe_transport',
    feed: false,
    priority: 1,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'failure',
  },
  answer_undelivered: {
    retry: 'restart_ring',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'failure',
  },
  worker_not_reading: {
    retry: 'restart_ring',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'failure',
  },
  answer_author_unavailable: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'attention',
  },
  inbound_failure: {
    retry: 'reapply_inbound',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'failure',
  },
  inbound_gap: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'failure',
  },
  board_observation: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: true,
    block: false,
    severity: 'attention',
  },
  worker_ended: {
    retry: 'none',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: true,
    block: false,
    severity: 'attention',
  },
  /** A turn whose executor is the operator; `closeTurns` clears it. */
  turn: {
    retry: 'none',
    feed: true,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: false,
    severity: 'attention',
  },
  /** A task-scoped condition only the operator can fix; `reconcileItems` owns its block. */
  anomaly: {
    retry: 'none',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: true,
    block: true,
    severity: 'attention',
  },
  /** A task that reached its column's cycle limit; the operator's close resets it. */
  cycle_limit: {
    retry: 'none',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: true,
    severity: 'attention',
  },
  /**
   * A task whose returns from a column reached its course check; the answer to its block, sent to
   * the curator or the operator, resets it.
   */
  course_check: {
    retry: 'none',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: false,
    block: true,
    severity: 'attention',
  },
  /** An operator conversation whose ring waits for a live session of its Spur project. */
  conversation_waiting: {
    retry: 'none',
    feed: false,
    priority: 4,
    buttons: 'item',
    reconciled: true,
    block: false,
    severity: 'attention',
  },
} as const satisfies Record<ItemKind, ItemPolicy>;

/** The `inbox.operator` severity of an item; a blind source's item is a failure. */
export function itemSeverity(kind: ItemKind, key: string): Severity {
  return key.startsWith(SOURCE_KEY) ? 'failure' : ITEM_POLICY[kind].severity;
}

/** Key prefixes of the items `reconcileItems` raises about a source or a block. */
export const SOURCE_KEY = 'source:';
export const OPERATOR_BLOCK_KEY = 'operator-block:';
export const BLOCK_KEY = 'block:';
export const CONVERSATION_KEY = 'conversation:';

/** The block an item is about: its ledger block, else the block its key names. */
export function itemBlockRef(item: {
  item_key: string;
  block_id: number | null;
}): number | undefined {
  if (item.block_id !== null) return item.block_id;
  for (const prefix of [OPERATOR_BLOCK_KEY, BLOCK_KEY, CONVERSATION_KEY]) {
    if (!item.item_key.startsWith(prefix)) continue;
    const id = Number(item.item_key.slice(prefix.length));
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

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

type BlockItemKind = {
  [K in ItemKind]: (typeof ITEM_POLICY)[K]['block'] extends true ? K : never;
}[ItemKind];

/** The kinds whose item is the ledger of an operator block. */
export const BLOCK_ITEM_KINDS = ITEM_KINDS.filter(
  (kind): kind is BlockItemKind => ITEM_POLICY[kind].block,
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
