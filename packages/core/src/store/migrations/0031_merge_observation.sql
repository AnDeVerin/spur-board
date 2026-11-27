-- Poll start times can predate accepting a merge, and inferred absence is not a ticket read.
ALTER TABLE pr_snapshot ADD COLUMN merged_seen_at TEXT;
ALTER TABLE ticket_snapshot ADD COLUMN last_read_at TEXT;
