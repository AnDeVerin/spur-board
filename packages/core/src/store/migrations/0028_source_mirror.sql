-- A github-project source's last failure code and message, and the GitHub Project title it read.
-- observe and reportSourceState write failure_* from the reported state (null when it has none);
-- observe writes project_title from a batch that carries a mirror; reportSourceState keeps it.
ALTER TABLE source_state ADD COLUMN failure_code TEXT;
ALTER TABLE source_state ADD COLUMN failure_message TEXT;
ALTER TABLE source_state ADD COLUMN project_title TEXT;
