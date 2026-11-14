-- A project-level block has no task: `block.project` names its board project, set only when
-- `task_id` is NULL. Its comments and notifications have no task either and belong to the block.
-- Keep every id, and keep each sequence: outbox payloads and journal entries name ids above the
-- largest one still stored. Existing rows keep their columns; `block.project` stays NULL.
CREATE TABLE block_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES task (id),
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
  created_at TEXT NOT NULL,
  project TEXT,
  CHECK ((task_id IS NULL) = (project IS NOT NULL))
) STRICT;

INSERT INTO block_new (id, task_id, type, reason, author, addressee_role, target_column, state,
  outcome, outcome_reason, repeat_of, unblocked_by, unblocked_at, created_at, project)
SELECT id, task_id, type, reason, author, addressee_role, target_column, state, outcome,
  outcome_reason, repeat_of, unblocked_by, unblocked_at, created_at, NULL
FROM block;

INSERT INTO sqlite_sequence (name, seq)
SELECT 'block_new', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'block_new');
UPDATE sqlite_sequence
SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'block'), 0))
WHERE name = 'block_new';

DROP TABLE block;
ALTER TABLE block_new RENAME TO block;
CREATE INDEX block_task_state ON block (task_id, state);

CREATE TABLE comment_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES task (id),
  block_id INTEGER REFERENCES block (id),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  conversation_ref TEXT,
  message_ref TEXT,
  acked_revision INTEGER,
  created_at TEXT NOT NULL,
  delivery_state TEXT,
  CHECK (task_id IS NOT NULL OR block_id IS NOT NULL)
) STRICT;

INSERT INTO comment_new (id, task_id, block_id, author, text, revision, conversation_ref,
  message_ref, acked_revision, created_at, delivery_state)
SELECT id, task_id, block_id, author, text, revision, conversation_ref, message_ref,
  acked_revision, created_at, delivery_state
FROM comment;

INSERT INTO sqlite_sequence (name, seq)
SELECT 'comment_new', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'comment_new');
UPDATE sqlite_sequence
SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'comment'), 0))
WHERE name = 'comment_new';

DROP TABLE comment;
ALTER TABLE comment_new RENAME TO comment;
CREATE INDEX comment_task_id ON comment (task_id, id);
CREATE INDEX comment_conversation_message ON comment (conversation_ref, message_ref);

CREATE TABLE notification_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  task_id INTEGER REFERENCES task (id),
  block_id INTEGER REFERENCES block (id),
  comment_id INTEGER REFERENCES comment (id),
  revision INTEGER,
  role TEXT NOT NULL,
  author_session TEXT,
  recipient_session TEXT,
  rings INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_outbox_id INTEGER REFERENCES outbox (id),
  acked_at TEXT,
  created_at TEXT NOT NULL,
  exhausted_at TEXT,
  turn_id INTEGER REFERENCES turn (id),
  CHECK (kind NOT IN ('turn', 'turn_reminder') OR (turn_id IS NOT NULL AND block_id IS NULL)),
  CHECK (kind IN ('turn', 'turn_reminder') OR (block_id IS NOT NULL AND turn_id IS NULL)),
  CHECK (task_id IS NOT NULL OR block_id IS NOT NULL)
) STRICT;

INSERT INTO notification_new (id, source_key, kind, task_id, block_id, comment_id, revision, role,
  author_session, recipient_session, rings, next_at, last_outbox_id, acked_at, created_at,
  exhausted_at, turn_id)
SELECT id, source_key, kind, task_id, block_id, comment_id, revision, role, author_session,
  recipient_session, rings, next_at, last_outbox_id, acked_at, created_at, exhausted_at, turn_id
FROM notification;

INSERT INTO sqlite_sequence (name, seq)
SELECT 'notification_new', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'notification_new');
UPDATE sqlite_sequence
SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'notification'), 0))
WHERE name = 'notification_new';

DROP TABLE notification;
ALTER TABLE notification_new RENAME TO notification;
CREATE INDEX notification_due ON notification (acked_at, next_at);
CREATE INDEX notification_block ON notification (block_id, id);
CREATE INDEX notification_turn ON notification (turn_id, id);
