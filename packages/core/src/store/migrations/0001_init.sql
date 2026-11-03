-- Schema v1 of the board store. Forward only: never edit this file once committed;
-- add the next numbered file instead. Timestamps are ISO-8601 UTC text, JSON columns
-- hold text checked by zod on read and write, flags are 0 or 1.

CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  tracker_kind TEXT NOT NULL,
  tracker_id TEXT NOT NULL,
  key TEXT NOT NULL,
  membership TEXT NOT NULL,
  archive_reason TEXT,
  "column" TEXT NOT NULL,
  shadow_column TEXT,
  column_epoch INTEGER NOT NULL DEFAULT 0,
  left_moves INTEGER NOT NULL DEFAULT 0,
  merged_past_gate INTEGER NOT NULL DEFAULT 0 CHECK (merged_past_gate IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (project, tracker_kind, tracker_id)
) STRICT;

CREATE TABLE pr_snapshot (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  state TEXT NOT NULL,
  draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
  mergeable TEXT,
  merge_state TEXT,
  detail TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) STRICT;

CREATE TABLE ticket_snapshot (
  task_id INTEGER PRIMARY KEY REFERENCES task (id),
  status TEXT NOT NULL,
  assignee TEXT,
  detail TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_snapshot (
  id TEXT PRIMARY KEY,
  spur_project TEXT NOT NULL,
  branch TEXT,
  pr TEXT,
  raw_state TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  detail TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

-- A task's link to a PR (entity 'pr') or to a spur session (entity 'session').
CREATE TABLE link (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task (id),
  entity TEXT NOT NULL,
  repo TEXT,
  number INTEGER,
  pr_state TEXT,
  session_id TEXT,
  role TEXT,
  source TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX link_pr_pair ON link (task_id, repo, number) WHERE entity = 'pr';
CREATE UNIQUE INDEX link_session_pair ON link (task_id, session_id) WHERE entity = 'session';
-- At most one active, unbanned PR link per task; conflict and banned links are not limited.
CREATE UNIQUE INDEX link_one_active_pr ON link (task_id)
  WHERE entity = 'pr' AND pr_state = 'active' AND banned = 0;

-- A column executor marks its turn finished at a head commit. One visit (epoch) may hold
-- several rows; the row at the current head commit is the one that counts.
CREATE TABLE submission (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task (id),
  "column" TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  author TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  note TEXT
) STRICT;

CREATE INDEX submission_task_column_submitted ON submission (task_id, "column", submitted_at);

CREATE TABLE block (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES task (id),
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  addressee_role TEXT NOT NULL,
  target_column TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  outcome_reason TEXT,
  repeat_of INTEGER REFERENCES block (id),
  unblocked_by TEXT,
  unblocked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX block_task_state ON block (task_id, state);

CREATE TABLE comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES task (id),
  block_id INTEGER REFERENCES block (id),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  conversation_ref TEXT,
  message_ref TEXT,
  acked_revision INTEGER,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX comment_task_id ON comment (task_id, id);

-- Idempotent operator and agent commands, keyed by the caller's idempotency key.
CREATE TABLE command (
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  fingerprint TEXT,
  result TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
) STRICT;

-- The journal. actor_ref is JSON {project, session}, set exactly when actor is 'agent'.
CREATE TABLE event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  project TEXT NOT NULL,
  task_id INTEGER REFERENCES task (id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_ref TEXT,
  payload TEXT NOT NULL,
  v INTEGER NOT NULL,
  request_id TEXT
) STRICT;

CREATE INDEX event_task_id ON event (task_id, id);
CREATE INDEX event_at ON event (at);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT,
  external_ref TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1))
) STRICT;

CREATE INDEX outbox_state_next_at ON outbox (state, next_at);

CREATE TABLE dismissal (
  item_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL
) STRICT;

-- Digest and archive slots. The schema version lives in PRAGMA user_version, not here.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE source_state (
  source TEXT PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  last_complete_at TEXT,
  blind_reason TEXT,
  cursor TEXT
) STRICT;
