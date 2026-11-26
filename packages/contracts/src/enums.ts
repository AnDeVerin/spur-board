/** Column groups. The dispatcher never moves a task between two columns of one group. */
export const COLUMN_GROUPS = ['todo'] as const;
export type ColumnGroup = (typeof COLUMN_GROUPS)[number];

/** The properties every built-in column declares; a missing one fails compile. */
interface ColumnSpec {
  readonly id: string;
  readonly name: string;
  /** Every project board has it, enabled. */
  readonly required: boolean;
  /** Its group, or `null` outside every group. */
  readonly group: ColumnGroup | null;
  /** `task.return` may send a task back from it to Dev. */
  readonly returnable: boolean;
  /** Its orchestrator's `task.mark` records a head-bound mark there. */
  readonly marks: boolean;
  /** Enabled on a project that omits `columns`. */
  readonly defaultEnabled: boolean;
}

/**
 * Built-in board columns in canonical order, left to right. Everything stored or addressed
 * (journal, store, addressee roles) uses the `id`; `name` is display text only.
 */
export const COLUMNS = [
  {
    id: 'todo',
    name: 'To Do',
    required: true,
    group: 'todo',
    returnable: false,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'triage',
    name: 'Triage',
    required: false,
    group: 'todo',
    returnable: false,
    marks: false,
    defaultEnabled: false,
  },
  {
    id: 'ready-for-dev',
    name: 'Ready for Dev',
    required: false,
    group: 'todo',
    returnable: false,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'dev',
    name: 'Dev',
    required: true,
    group: null,
    returnable: false,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'review',
    name: 'Review',
    required: false,
    group: null,
    returnable: true,
    marks: true,
    defaultEnabled: true,
  },
  {
    id: 'product-review',
    name: 'Product Review',
    required: false,
    group: null,
    returnable: true,
    marks: true,
    defaultEnabled: true,
  },
  {
    id: 'external-review',
    name: 'External Review',
    required: false,
    group: null,
    returnable: true,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'qa',
    name: 'QA',
    required: false,
    group: null,
    returnable: true,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'ready-to-merge',
    name: 'Ready to Merge',
    required: false,
    group: null,
    returnable: true,
    marks: false,
    defaultEnabled: true,
  },
  {
    id: 'done',
    name: 'Done',
    required: true,
    group: null,
    returnable: false,
    marks: false,
    defaultEnabled: true,
  },
] as const satisfies readonly ColumnSpec[];
export type ColumnId = (typeof COLUMNS)[number]['id'];
type ColumnEntry = (typeof COLUMNS)[number];

/** Column ids in canonical order. */
export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((column) => column.id);

/** Columns of the Todo group: a task rests there until work starts. */
export type TodoGroupColumnId = Extract<ColumnEntry, { group: 'todo' }>['id'];

/** Columns of the Todo group in canonical order. */
export const TODO_GROUP_COLUMN_IDS: readonly TodoGroupColumnId[] = COLUMNS.filter(
  (column): column is Extract<ColumnEntry, { group: 'todo' }> => column.group === 'todo',
).map((column) => column.id);

/** True for a column of the Todo group. */
export function isTodoGroupColumn(column: ColumnId): column is TodoGroupColumnId {
  return (TODO_GROUP_COLUMN_IDS as readonly ColumnId[]).includes(column);
}

/** Columns where an orchestrator records a head-bound mark. */
export type MarkColumnId = Extract<ColumnEntry, { marks: true }>['id'];

/** Columns every project board has, enabled. */
export const REQUIRED_COLUMN_IDS: readonly ColumnId[] = COLUMNS.filter(
  (column) => column.required,
).map((column) => column.id);

/**
 * The columns `projects[].checksGate` may name: running or missing checks hold a task only at the
 * exit of that column. Each is left of qa and ready-to-merge, so a task never reaches them without
 * green checks.
 */
export const CHECKS_GATE_COLUMNS = [
  'dev',
  'review',
  'product-review',
  'external-review',
] as const satisfies readonly ColumnId[];
export type CheckGateColumn = (typeof CHECKS_GATE_COLUMNS)[number];

/**
 * What `projects[].columns[].approvalRule` on External Review lets a task leave on: any external
 * approval, or that and the repository's own GitHub review rule for the PR head.
 */
export const APPROVAL_RULES = ['any-approval', 'github-rules'] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];

/** Where a column's effective orchestrator comes from: its own column entry or top-level `spurProjects`. */
export const COLUMN_BINDING_SOURCES = ['project', 'board-wide'] as const;
export type ColumnBindingSource = (typeof COLUMN_BINDING_SOURCES)[number];

/** Where a project's effective operator comes from: its own `spurProjects` or top-level `spurProjects`. */
export const OPERATOR_BINDING_SOURCES = ['project', 'board-wide'] as const;
export type OperatorBindingSource = (typeof OPERATOR_BINDING_SOURCES)[number];

/** Where the default Slack addressee comes from: `slack.defaultAddressee`, the board-wide operator or a project's operator. */
export const ADDRESSEE_SOURCES = ['config', 'board-wide', 'project'] as const;
export type AddresseeSource = (typeof ADDRESSEE_SOURCES)[number];

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
export type AddresseeRole = 'operator' | 'curator' | 'worker' | `orchestrator:${ColumnId}`;
export const ADDRESSEE_ROLES: readonly AddresseeRole[] = [
  'operator',
  'curator',
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

/** How a project's dispatcher runs: `shadow` records moves only, `on` moves tasks and opens turns. */
export const DISPATCHER_MODES = ['shadow', 'on'] as const;
export type DispatcherMode = (typeof DISPATCHER_MODES)[number];

/** The submitter's declared testing provenance. */
export const SUBMISSION_BASES = ['tested', 'carried', 'skipped'] as const;
export type SubmissionBasis = (typeof SUBMISSION_BASES)[number];

/**
 * How a turn closed: `submitted` by the executor's submit, `returned` by `task.return`, `moved`
 * when the task moved on (it also covers returns and mode switches recorded by older versions),
 * `corrected` by the operator's column correction, `rerouted` to another executor,
 * `mode_changed` by a dispatcher mode switch, `archived` with the task. `moved` also closes a
 * Done wrap-up turn whose holder session ended, or an untaken one with no recipient left.
 */
export const TURN_OUTCOMES = [
  'submitted',
  'returned',
  'moved',
  'corrected',
  'rerouted',
  'mode_changed',
  'archived',
] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/**
 * How a turn wait ended: `woken` when its time ran out, `submitted` by the holder's submit,
 * `closed` by any other turn close, a take or the holder's end, `ended` when the operator ended it
 * early, `limit` when it ran out and the turn's waits reached their count or total time.
 */
export const TURN_WAIT_OUTCOMES = ['woken', 'submitted', 'closed', 'ended', 'limit'] as const;
export type TurnWaitOutcome = (typeof TURN_WAIT_OUTCOMES)[number];

/** The exit conditions of the column gates, as `board task --why` names them. */
export const GATE_CONDITIONS = [
  'pr_open',
  'not_draft',
  'checks_green',
  'checks_not_red',
  'no_conflict',
  'external_comments_handled',
  'comment_history_read',
  'threads_resolved',
  'submit_on_head',
  'review_on_head',
  'approved',
  'review_rule_satisfied',
  'merged',
] as const;
export type GateCondition = (typeof GATE_CONDITIONS)[number];

/**
 * The state of one gate condition: `waiting` fails only on a fact not known yet, `unchecked` was
 * not evaluated because an earlier condition of the column failed first.
 */
export const GATE_CONDITION_STATES = ['met', 'failed', 'waiting', 'unchecked'] as const;
export type GateConditionState = (typeof GATE_CONDITION_STATES)[number];

/** What holds the dispatcher from acting on a task. */
export const TASK_HOLDS = [
  'pr_snapshot_missing',
  'github_blind',
  'spur_blind',
  'ticket_unconfirmed',
  'submit_pending',
  'cycle_limit',
  'work_not_started',
] as const;
export type TaskHold = (typeof TASK_HOLDS)[number];

/**
 * What a task waits for, as `board task --why` names it in `why.waitsFor`: an open turn, a merge,
 * a human approval, the ticket, CI checks, GitHub, Spur, the board itself, an answer to a block,
 * work to start or end, a failing gate, nothing (`done`, `archived`), or the project config.
 */
export const WAITS_FOR_KINDS = [
  'turn',
  'merge',
  'approval',
  'ticket',
  'checks',
  'github',
  'spur',
  'board',
  'answer',
  'work',
  'gate',
  'done',
  'archived',
  'config',
] as const;
export type WaitsForKind = (typeof WAITS_FOR_KINDS)[number];

/** Every operator item kind; core's `ITEM_POLICY` gives each one a policy. */
export const ITEM_KINDS = [
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
  'turn',
  'anomaly',
  'cycle_limit',
  'course_check',
  'conversation_waiting',
] as const;

/** What an `inbox.operator` entry is: a block addressed to the operator, else an item kind. */
export const INBOX_KINDS = ['block', ...ITEM_KINDS] as const;

/**
 * `failure`: the board or a connection broke; `attention`: a decision, answer or other operator
 * action is wanted.
 */
export const INBOX_SEVERITIES = ['attention', 'failure'] as const;

/** Who caused a journal event. */
export const ACTORS = ['operator', 'agent', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * The channel a write arrived through, whoever the actor, journaled as `event.via`. The daemon
 * sets `web` and `slack` where the write arrived; `cli` and `mcp` are what the `board` client
 * reported in its `x-board-via` header; every other write has none. Named `via` because core
 * keeps platform terms such as "channel" out of its source.
 */
export const VIAS = ['web', 'slack', 'cli', 'mcp'] as const;
export type Via = (typeof VIAS)[number];

/** The stored state of an operator token. */
export const TOKEN_STATUSES = ['pending', 'approved', 'denied', 'expired', 'revoked'] as const;

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
