import type {
  Actor,
  AddresseeRole,
  ArchiveReason,
  BlockOutcome,
  BlockState,
  BlockType,
  ColumnId,
  Config,
  LinkSource,
  Membership,
  PrLinkState,
  SessionEndReason,
  SessionLinkRole,
} from '@spur-board/contracts';
import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

// Row types for `migrations/*.sql`, written by hand. Change them in the same commit as the
// migration that changes a table. Timestamps are ISO-8601 UTC strings, JSON columns are
// strings (read and write them through `parseJson` / `toJson`), flags are 0 or 1 because
// better-sqlite3 does not bind booleans.

type Flag = 0 | 1;

export type TrackerKind = Config['projects'][number]['tracker']['type'];

export type OutboxState = 'pending' | 'in_flight' | 'done' | 'dead';

/**
 * Who did something, as one string: `operator`, `system`, or `agent:<project>/<session>` for
 * an agent, naming its spur project and session. Every column that records a doer uses it:
 * `submission.author`, `block.author`, `block.unblocked_by`, `comment.author`,
 * `command.actor` and `dismissal.dismissed_by`. The session lets the dispatcher accept a
 * submission only from the column's executor and a withdrawal only from the block's author,
 * and keeps `command`'s `(actor, key)` from mixing two agents' idempotency keys. `event`
 * records the same facts split into `actor` and `actor_ref`.
 */
export type ActorId = 'operator' | 'system' | `agent:${string}/${string}`;

export interface TaskTable {
  id: Generated<number>;
  project: string;
  tracker_kind: TrackerKind;
  tracker_id: string;
  key: string;
  membership: Membership;
  archive_reason: ArchiveReason | null;
  column: ColumnId;
  shadow_column: ColumnId | null;
  column_epoch: Generated<number>;
  left_moves: Generated<number>;
  merged_past_gate: Generated<Flag>;
  created_at: string;
}

export interface PrSnapshotTable {
  repo: string;
  number: number;
  head_sha: string;
  head_branch: string;
  state: string;
  draft: Flag;
  mergeable: string | null;
  merge_state: string | null;
  /** JSON. */
  detail: string;
  source: string;
  observed_at: string;
}

export interface TicketSnapshotTable {
  task_id: number;
  status: string;
  assignee: string | null;
  /** JSON. */
  detail: string;
  source: string;
  observed_at: string;
}

export interface SessionSnapshotTable {
  id: string;
  spur_project: string;
  branch: string | null;
  pr: string | null;
  /** The state as last observed. */
  raw_state: string;
  /** The smoothed state the board shows. */
  state: string;
  first_seen: string;
  last_seen: string;
  ended_at: string | null;
  end_reason: SessionEndReason | null;
  /** JSON. */
  detail: string;
  source: string;
  observed_at: string;
}

/** PR fields are set when `entity` is `pr`, session fields when it is `session`. */
export interface LinkTable {
  id: Generated<number>;
  task_id: number;
  entity: 'pr' | 'session';
  repo: string | null;
  number: number | null;
  pr_state: PrLinkState | null;
  session_id: string | null;
  role: SessionLinkRole | null;
  source: LinkSource;
  banned: Generated<Flag>;
  created_at: string;
}

/** A column executor's finished turn at a head commit. No unique key per epoch. */
export interface SubmissionTable {
  id: Generated<number>;
  task_id: number;
  column: ColumnId;
  epoch: number;
  commit_sha: string;
  author: ActorId;
  submitted_at: string;
  note: string | null;
}

export interface BlockTable {
  id: Generated<number>;
  task_id: number;
  type: BlockType;
  reason: string;
  author: ActorId;
  addressee_role: AddresseeRole;
  target_column: ColumnId | null;
  state: BlockState;
  outcome: BlockOutcome | null;
  outcome_reason: string | null;
  repeat_of: number | null;
  unblocked_by: ActorId | null;
  unblocked_at: string | null;
  created_at: string;
}

export interface CommentTable {
  id: Generated<number>;
  task_id: number;
  block_id: number | null;
  author: ActorId;
  text: string;
  revision: Generated<number>;
  conversation_ref: string | null;
  message_ref: string | null;
  acked_revision: number | null;
  created_at: string;
}

export interface CommandTable {
  /** The caller, not only its kind: two agents may pick the same `key`. */
  actor: ActorId;
  key: string;
  operation: string;
  fingerprint: string | null;
  /** JSON. */
  result: string;
  at: string;
}

export interface EventTable {
  id: Generated<number>;
  at: string;
  project: string;
  task_id: number | null;
  /** An `EventKind` on write; readers skip kinds they do not know. */
  kind: string;
  actor: Actor;
  /** JSON `{project, session}`, set exactly when `actor` is `agent`. */
  actor_ref: string | null;
  /** JSON. */
  payload: string;
  v: number;
  request_id: string | null;
}

export interface OutboxTable {
  id: Generated<number>;
  kind: string;
  dedupe_key: string;
  /** JSON. */
  payload: string;
  state: OutboxState;
  attempts: Generated<number>;
  next_at: string;
  last_error: string | null;
  external_ref: string | null;
  uncertain: Generated<Flag>;
}

export interface DismissalTable {
  item_key: string;
  fingerprint: string;
  dismissed_by: ActorId;
  dismissed_at: string;
}

export interface MetaTable {
  key: string;
  /** JSON. */
  value: string;
}

export interface SourceStateTable {
  source: string;
  initialized: Generated<Flag>;
  last_complete_at: string | null;
  blind_reason: string | null;
  cursor: string | null;
}

/** Every table in the store, for `Kysely<Tables>`. */
export interface Tables {
  task: TaskTable;
  pr_snapshot: PrSnapshotTable;
  ticket_snapshot: TicketSnapshotTable;
  session_snapshot: SessionSnapshotTable;
  link: LinkTable;
  submission: SubmissionTable;
  block: BlockTable;
  comment: CommentTable;
  command: CommandTable;
  event: EventTable;
  outbox: OutboxTable;
  dismissal: DismissalTable;
  meta: MetaTable;
  source_state: SourceStateTable;
}

export type Row<T extends keyof Tables> = Selectable<Tables[T]>;
export type NewRow<T extends keyof Tables> = Insertable<Tables[T]>;
export type RowUpdate<T extends keyof Tables> = Updateable<Tables[T]>;
