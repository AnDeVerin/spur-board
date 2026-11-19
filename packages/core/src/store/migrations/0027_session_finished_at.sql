-- When the board first saw a session in a finished lifecycle state (FINISHED_STATES in
-- doorbells.ts: killed, stopped, errored, completed); null while it is in any other state. Spur
-- keeps listing finished sessions with no end time, so this is the moment one stopped being a
-- recipient. Rows already finished take their last observation: no earlier time is stored.
ALTER TABLE session_snapshot ADD COLUMN finished_at TEXT;
UPDATE session_snapshot SET finished_at = observed_at
  WHERE state IN ('killed', 'stopped', 'errored', 'completed');
