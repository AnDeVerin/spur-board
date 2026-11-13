-- The dispatcher's columns, all nullable so every stored row keeps its meaning:
-- `turn.head_sha` is the task PR's head commit when the turn opened (NULL without a PR, and for
-- turns opened before this migration); `submission.voided_at` is when a left move made a submit
-- of that column or right of it stale (NULL while it counts); `submission.pr_repo` and
-- `submission.pr_number` are the PR whose fresh head the submit was checked against (NULL for
-- submits recorded before this migration, which count as handling feedback on no PR);
-- `link.reopen_hidden_at` is when the task's ticket reopened after a merge while this PR link
-- was closed or merged, so the link no longer decides the task (NULL while it counts).
ALTER TABLE turn ADD COLUMN head_sha TEXT;
ALTER TABLE submission ADD COLUMN voided_at TEXT;
ALTER TABLE submission ADD COLUMN pr_repo TEXT;
ALTER TABLE submission ADD COLUMN pr_number INTEGER;
ALTER TABLE link ADD COLUMN reopen_hidden_at TEXT;
