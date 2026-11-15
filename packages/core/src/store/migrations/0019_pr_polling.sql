-- A separate deadline keeps cache replay from extending a closed PR's quiet period.
ALTER TABLE pr_snapshot ADD COLUMN closed_recheck_at TEXT;
CREATE TABLE source_cost (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  at TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points >= 0)
) STRICT;
CREATE INDEX source_cost_source_at ON source_cost (source, at);
