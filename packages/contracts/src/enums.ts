/** Board columns, left to right. */
export const COLUMNS = [
  'To Do',
  'Ready for Dev',
  'Dev',
  'Review',
  'QA',
  'Ready to Merge',
  'Done',
] as const;
export type Column = (typeof COLUMNS)[number];

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
export type AddresseeRole = 'operator' | 'worker' | `orchestrator:${Column}`;
export const ADDRESSEE_ROLES: readonly AddresseeRole[] = [
  'operator',
  ...COLUMNS.map((column): AddresseeRole => `orchestrator:${column}`),
  'worker',
];

export const VERDICT_KINDS = ['approve', 'back', 'running', 'carried'] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

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
