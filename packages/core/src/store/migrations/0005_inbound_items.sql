-- Operator items raised by inbound failures and recovery gaps.
CREATE TABLE from_you_item (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_url TEXT,
  event_json TEXT NOT NULL,
  task_id INTEGER REFERENCES task (id),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
