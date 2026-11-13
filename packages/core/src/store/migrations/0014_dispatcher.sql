-- The dispatcher's columns, all nullable so every stored row keeps its meaning:
-- `turn.head_sha` is the task PR's head commit when the turn opened (NULL without a PR, and for
-- turns opened before this migration); `submission.voided_at` is when a left move made a submit
-- of that column or right of it stale (NULL while it counts); `task.reopen_link_floor` is the
-- largest PR link id of the task when its ticket reopened after a merge, so only links above it
-- decide the task (NULL when the ticket never reopened).
ALTER TABLE turn ADD COLUMN head_sha TEXT;
ALTER TABLE submission ADD COLUMN voided_at TEXT;
ALTER TABLE task ADD COLUMN reopen_link_floor INTEGER;
