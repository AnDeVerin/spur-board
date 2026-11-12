import type {
  Actor,
  ActorId,
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
  SpaceId,
} from '@spur-board/contracts';
import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

// Row types for `migrations/*.sql`, written by hand. Change them in the same commit as the
// migration that changes a table. Timestamps are ISO-8601 UTC strings, JSON columns are
// strings (read and write them through `parseJson` / `toJson`), flags are 0 or 1 because
// better-sqlite3 does not bind booleans.

type Flag = 0 | 1;

export type TrackerKind = Config['projects'][number]['tracker']['type'];

/** `post_failed`: the sender gave up until the next start; `dead`: superseded or invalid. */
export type OutboxState = 'pending' | 'in_flight' | 'done' | 'post_failed' | 'dead';

/** Delivery of a comment to a gateway conversation. `post_blocked` is reserved for #38. */
export type CommentDeliveryState =
  'pending' | 'delivered' | 'post_failed' | 'post_blocked' | 'superseded';

/** What a conversation is the thread of: a block or a feed line. `digest` is reserved for M2. */
export type ConversationPurpose = 'block' | 'feed_line' | 'digest';

export type ConversationState = 'open' | 'closed';

// `ActorId` (from contracts) types every doer column: `submission.author`, `block.author`,
// `block.unblocked_by`, `comment.author`, `command.actor` and `dismissal.dismissed_by`.

export interface TaskTable {
  id: Generated<number>;
  project: string;
  tracker_kind: TrackerKind;
  tracker_id: string | null;
  key: string;
  membership: Membership;
  archive_reason: ArchiveReason | null;
  column: ColumnId;
  shadow_column: ColumnId | null;
  column_epoch: Generated<number>;
  left_moves: Generated<number>;
  merged_past_gate: Generated<Flag>;
  created_at: string;
  manual_include: Generated<Flag>;
  manual_exclude: Generated<Flag>;
  last_change_at: string | null;
  terminal_at: string | null;
  archive_slot_at: string | null;
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
  /** When a complete poll of `source` first omitted the session; null while it is observed. */
  absent_since: string | null;
}

/** Only the identity columns for `entity` are set on a link. */
export interface LinkTable {
  id: Generated<number>;
  task_id: number;
  entity: 'pr' | 'session' | 'ticket';
  repo: string | null;
  number: number | null;
  pr_state: PrLinkState | null;
  session_id: string | null;
  role: SessionLinkRole | null;
  source: LinkSource;
  banned: Generated<Flag>;
  created_at: string;
  ticket_key: string | null;
  pr_open: Flag | null;
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

/** A column executor's turn of one column visit; `seq` counts the turns of the visit. */
export interface TurnTable {
  id: Generated<number>;
  task_id: number;
  column: ColumnId;
  epoch: number;
  seq: number;
  role: AddresseeRole;
  reason: string;
  /** JSON array of `turnHandedSchema` entries: the feedback this turn hands over. */
  handed: string;
  acked_by: ActorId | null;
  acked_at: string | null;
  closed_at: string | null;
  /** Free text in the store, so a later reason (a submit) needs no migration. */
  closed_reason: 'moved' | 'archived' | null;
  created_at: string;
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
  /** NULL when the comment is not delivered to a gateway. */
  delivery_state: CommentDeliveryState | null;
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
  /** JSON, set when the row is done. */
  external_ref: string | null;
  uncertain: Generated<Flag>;
  /** The row this one waits for: it is sent only after the parent is done. */
  parent_outbox_id: number | null;
  /** The first attempt of the current retry window; NULL while the window is suspended. */
  first_attempt_at: string | null;
  /** Earliest possible delivery of this key; never reset after an uncertain send. */
  first_delivery_at: string | null;
  /** Whether the current claimed attempt reached the send-start transaction. */
  attempt_started: Generated<Flag>;
}

/** A gateway conversation, keyed by `(gateway, ref)`. A block may have several. */
export interface ConversationTable {
  ref: string;
  gateway: string;
  space: SpaceId;
  task_id: number | null;
  block_id: number | null;
  purpose: ConversationPurpose;
  state: ConversationState;
  root_message_ref: string;
  after_message_ref: string | null;
  created_at: string;
  closed_at: string | null;
}

/** A failing transport for one `(gateway, space)`; that space's rows wait while it stands. */
export interface TransportHealthTable {
  gateway: string;
  space: SpaceId;
  reason: string;
  since: string;
  /** When the last probe's send started; the next probe waits a minute from it. */
  probe_at: string;
}

/** When the last send into a `(gateway, space)` started; the next one waits the space interval. */
export interface SpaceSlotTable {
  gateway: string;
  space: SpaceId;
  sent_at: string;
}

export interface NotificationTable {
  id: Generated<number>;
  source_key: string;
  kind: 'answer' | 'block' | 'removed' | 'turn' | 'turn_reminder';
  task_id: number;
  /** Null exactly for kinds `turn` and `turn_reminder`, which have `turn_id` instead. */
  block_id: number | null;
  comment_id: number | null;
  revision: number | null;
  role: AddresseeRole;
  author_session: string | null;
  recipient_session: string | null;
  rings: Generated<number>;
  next_at: string;
  last_outbox_id: number | null;
  acked_at: string | null;
  exhausted_at: string | null;
  created_at: string;
  turn_id: number | null;
}

export interface OperatorItemTable {
  id: Generated<number>;
  item_key: string;
  raise_no: number;
  kind: string;
  text: string;
  url: string;
  task_id: number | null;
  block_id: number | null;
  raised_at: string;
  cleared_at: string | null;
  line_outbox_id: number | null;
  fingerprint: Generated<string | null>;
  fact_at: Generated<string | null>;
  source: Generated<string | null>;
  priority: Generated<number | null>;
  /** Normalized event retained for a later explicit retry. */
  inbound_event_json: string | null;
}

export type OperatorTokenStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';

export interface OperatorTokenTable {
  id: Generated<number>;
  name: string;
  /** SHA-256 hex of the file secret; the raw secret never reaches the store. */
  hash: string;
  folder: string;
  host: string;
  status: OperatorTokenStatus;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  item_id: number;
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
  observed_at: string | null;
  blind_message: string | null;
  /** JSON array of entity refs. */
  gone: Generated<string>;
}

export interface SourceMissTable {
  source: string;
  ref_key: string;
  /** JSON entity ref. */
  ref: string;
  misses: number;
  gone: Flag;
  outcome: 'ok' | 'not_found' | 'no_access' | null;
}

/** Every table in the store, for `Kysely<Tables>`. */
export interface Tables {
  task: TaskTable;
  pr_snapshot: PrSnapshotTable;
  ticket_snapshot: TicketSnapshotTable;
  session_snapshot: SessionSnapshotTable;
  link: LinkTable;
  submission: SubmissionTable;
  turn: TurnTable;
  block: BlockTable;
  comment: CommentTable;
  conversation: ConversationTable;
  command: CommandTable;
  event: EventTable;
  outbox: OutboxTable;
  dismissal: DismissalTable;
  meta: MetaTable;
  source_state: SourceStateTable;
  source_miss: SourceMissTable;
  transport_health: TransportHealthTable;
  space_slot: SpaceSlotTable;
  notification: NotificationTable;
  operator_item: OperatorItemTable;
  operator_token: OperatorTokenTable;
}

export type Row<T extends keyof Tables> = Selectable<Tables[T]>;
export type NewRow<T extends keyof Tables> = Insertable<Tables[T]>;
export type RowUpdate<T extends keyof Tables> = Updateable<Tables[T]>;
