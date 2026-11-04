/**
 * Built-in board columns in canonical order, left to right. Everything stored or addressed
 * (journal, store, addressee roles) uses the `id`; `name` is display text only.
 */
export const COLUMNS = [
  { id: 'todo', name: 'To Do', required: true },
  { id: 'ready-for-dev', name: 'Ready for Dev', required: false },
  { id: 'dev', name: 'Dev', required: true },
  { id: 'review', name: 'Review', required: false },
  { id: 'qa', name: 'QA', required: false },
  { id: 'ready-to-merge', name: 'Ready to Merge', required: false },
  { id: 'done', name: 'Done', required: true },
] as const;
export type ColumnId = (typeof COLUMNS)[number]['id'];

/** Column ids in canonical order. */
export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((column) => column.id);

/** Columns every project board has, enabled. */
export const REQUIRED_COLUMN_IDS: readonly ColumnId[] = COLUMNS.filter(
  (column) => column.required,
).map((column) => column.id);

/** Whether a task is on the board, outside the tracker filter, or archived. */
export const MEMBERSHIPS = ['active', 'out_of_filter', 'archived'] as const;
export type Membership = (typeof MEMBERSHIPS)[number];

export const ARCHIVE_REASONS = ['done', 'out_of_filter', 'manual'] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export const BLOCK_TYPES = ['code', 'needs_input', 'dependency', 'external'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const BLOCK_STATES = ['open', 'unblocked'] as const;
export type BlockState = (typeof BLOCK_STATES)[number];

export const BLOCK_OUTCOMES = ['done', 'reason', 'terminal', 'withdrawn', 'archived'] as const;
export type BlockOutcome = (typeof BLOCK_OUTCOMES)[number];

/** Who a block, comment or doorbell is addressed to. */
export type AddresseeRole = 'operator' | 'worker' | `orchestrator:${ColumnId}`;
export const ADDRESSEE_ROLES: readonly AddresseeRole[] = [
  'operator',
  ...COLUMN_IDS.map((id): AddresseeRole => `orchestrator:${id}`),
  'worker',
];

export const SESSION_LINK_ROLES = ['worker', 'other', 'orchestrator'] as const;
export type SessionLinkRole = (typeof SESSION_LINK_ROLES)[number];

export const LINK_SOURCES = ['spawn_link', 'branch', 'manual'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export const PR_LINK_STATES = ['active', 'conflict'] as const;
export type PrLinkState = (typeof PR_LINK_STATES)[number];

export const SESSION_END_REASONS = ['complete', 'kill', 'vanished', 'unknown'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** Who caused a journal event. */
export const ACTORS = ['operator', 'agent', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

/** Bot OAuth scopes required by the generated Slack manifest and checked by doctor. */
export const SLACK_BOT_SCOPES = [
  'chat:write',
  'chat:write.customize',
  'groups:history',
  'groups:read',
  'app_mentions:read',
  'commands',
  'reactions:write',
] as const;
