-- A turn hands a task's current column visit to its executor. `seq` counts the turns of one
-- visit; a task has at most one unclosed turn. `handed` is JSON checked by zod.
CREATE TABLE turn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES task (id),
  "column" TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  reason TEXT NOT NULL,
  handed TEXT NOT NULL,
  acked_by TEXT,
  acked_at TEXT,
  closed_at TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, "column", epoch, seq),
  CHECK ((acked_at IS NULL) = (acked_by IS NULL)),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
) STRICT;

CREATE UNIQUE INDEX turn_one_unclosed ON turn (task_id) WHERE closed_at IS NULL;

-- A notification belongs to a block or, for kind `turn`, to a turn. Keep every id, and keep the
-- sequence: outbox payloads name notification ids above the largest one still stored.
CREATE TABLE notification_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES task (id),
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
  CHECK (kind <> 'turn' OR (turn_id IS NOT NULL AND block_id IS NULL)),
  CHECK (kind = 'turn' OR (block_id IS NOT NULL AND turn_id IS NULL))
) STRICT;

INSERT INTO notification_new (id, source_key, kind, task_id, block_id, comment_id, revision, role,
  author_session, recipient_session, rings, next_at, last_outbox_id, acked_at, created_at,
  exhausted_at, turn_id)
SELECT id, source_key, kind, task_id, block_id, comment_id, revision, role, author_session,
  recipient_session, rings, next_at, last_outbox_id, acked_at, created_at, exhausted_at, NULL
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
