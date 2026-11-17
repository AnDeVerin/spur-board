-- Colour of each GitHub source's default-branch head as JSON (defaultBranchViewSchema). observe
-- writes it from a batch that carries a default-branch fact; reportSourceState never changes it.
ALTER TABLE source_state ADD COLUMN default_branch TEXT;
