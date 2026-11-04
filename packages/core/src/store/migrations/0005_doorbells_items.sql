-- Notification state tracks distinct delivered rings separately from outbox transport attempts.
CREATE TABLE notification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES task (id),
  block_id INTEGER NOT NULL REFERENCES block (id),
  comment_id INTEGER REFERENCES comment (id),
  revision INTEGER,
  role TEXT NOT NULL,
  author_session TEXT,
  recipient_session TEXT,
  rings INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_outbox_id INTEGER REFERENCES outbox (id),
  acked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX notification_due ON notification (acked_at, next_at);
CREATE INDEX notification_block ON notification (block_id, id);

-- A new raise of the same item key gets a new raise number and a new feed dedupe key.
CREATE TABLE operator_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  raise_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  task_id INTEGER REFERENCES task (id),
  block_id INTEGER REFERENCES block (id),
  raised_at TEXT NOT NULL,
  cleared_at TEXT,
  line_outbox_id INTEGER REFERENCES outbox (id),
  UNIQUE (item_key, raise_no)
) STRICT;

CREATE INDEX operator_item_active ON operator_item (item_key, cleared_at);
