-- Kind `turn_reminder` is the single reminder ring to the holder of a quiet turn; like `turn` it
-- belongs to a turn, not a block. Keep every id, and keep the sequence: outbox payloads name
-- notification ids above the largest one still stored.
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
  CHECK (kind NOT IN ('turn', 'turn_reminder') OR (turn_id IS NOT NULL AND block_id IS NULL)),
  CHECK (kind IN ('turn', 'turn_reminder') OR (block_id IS NOT NULL AND turn_id IS NULL))
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
