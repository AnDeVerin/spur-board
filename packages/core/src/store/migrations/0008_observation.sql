-- Observation and operator membership state. Existing task ids and child rows survive.
CREATE TABLE task_new (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  tracker_kind TEXT NOT NULL,
  tracker_id TEXT,
  key TEXT NOT NULL,
  membership TEXT NOT NULL,
  archive_reason TEXT,
  "column" TEXT NOT NULL,
  shadow_column TEXT,
  column_epoch INTEGER NOT NULL DEFAULT 0,
  left_moves INTEGER NOT NULL DEFAULT 0,
  merged_past_gate INTEGER NOT NULL DEFAULT 0 CHECK (merged_past_gate IN (0, 1)),
  created_at TEXT NOT NULL,
  manual_include INTEGER NOT NULL DEFAULT 0 CHECK (manual_include IN (0, 1)),
  manual_exclude INTEGER NOT NULL DEFAULT 0 CHECK (manual_exclude IN (0, 1)),
  last_change_at TEXT,
  terminal_at TEXT,
  archive_slot_at TEXT,
  UNIQUE (project, tracker_kind, key)
) STRICT;
INSERT INTO task_new (id, project, tracker_kind, tracker_id, key, membership, archive_reason,
  "column", shadow_column, column_epoch, left_moves, merged_past_gate, created_at)
SELECT id, project, tracker_kind, tracker_id, key, membership, archive_reason,
  "column", shadow_column, column_epoch, left_moves, merged_past_gate, created_at FROM task;
DROP TABLE task;
ALTER TABLE task_new RENAME TO task;
CREATE UNIQUE INDEX task_stable_tracker_id ON task (project, tracker_kind, tracker_id)
  WHERE tracker_id IS NOT NULL;

ALTER TABLE source_state ADD COLUMN observed_at TEXT;
ALTER TABLE source_state ADD COLUMN blind_message TEXT;
ALTER TABLE source_state ADD COLUMN gone TEXT NOT NULL DEFAULT '[]';

CREATE TABLE source_miss (
  source TEXT NOT NULL REFERENCES source_state (source),
  ref_key TEXT NOT NULL,
  ref TEXT NOT NULL,
  misses INTEGER NOT NULL CHECK (misses >= 0),
  gone INTEGER NOT NULL CHECK (gone IN (0, 1)),
  outcome TEXT,
  PRIMARY KEY (source, ref_key)
) STRICT;

ALTER TABLE operator_item ADD COLUMN fingerprint TEXT;
ALTER TABLE operator_item ADD COLUMN fact_at TEXT;
ALTER TABLE operator_item ADD COLUMN source TEXT;
ALTER TABLE operator_item ADD COLUMN priority INTEGER;
