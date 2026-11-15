-- Request budget each source reported on its last batch that carried one. observe writes the three
-- columns together from one batch or leaves them alone; reportSourceState never changes them.
ALTER TABLE source_state ADD COLUMN budget_remaining INTEGER;
ALTER TABLE source_state ADD COLUMN budget_limit INTEGER;
ALTER TABLE source_state ADD COLUMN budget_reset_at TEXT;
