-- Named operator credentials store hashes only. Expiry is enforced at read and decision time.
CREATE TABLE operator_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  item_id INTEGER NOT NULL REFERENCES operator_item (id)
) STRICT;

CREATE INDEX operator_token_status_expiry ON operator_token (status, expires_at);
