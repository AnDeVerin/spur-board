-- The dispatcher's columns, all nullable so every stored row keeps its meaning:
-- `turn.head_sha` is the task PR's head commit when the turn opened (NULL without a PR, and for
-- turns opened before this migration); `submission.voided_at` is when a left move made a submit
-- of that column or right of it stale (NULL while it counts); `submission.pr_repo` and
-- `submission.pr_number` are the PR whose fresh head the submit was checked against (NULL for
-- submits recorded before this migration, which count as handling feedback on no PR);
-- `link.reopen_hidden_at` is when the task's ticket reopened after a merge while this PR link
-- was closed or merged, so the link no longer decides the task (NULL while it counts);
-- `link.reopen_pending_at` is when the ticket reopened while this PR link was not yet seen
-- merged, so a merge the board observes later but GitHub made by then still hides it (NULL once
-- the link is seen merged or closed, and when no reopen waits); `task.reopened_at` is when the
-- task's ticket last went from done to not done (NULL if it never did), so a PR the board first
-- links merged before that time is hidden too. It is never cleared: a later merge counts anyway.
ALTER TABLE turn ADD COLUMN head_sha TEXT;
ALTER TABLE submission ADD COLUMN voided_at TEXT;
ALTER TABLE submission ADD COLUMN pr_repo TEXT;
ALTER TABLE submission ADD COLUMN pr_number INTEGER;
ALTER TABLE link ADD COLUMN reopen_hidden_at TEXT;
ALTER TABLE link ADD COLUMN reopen_pending_at TEXT;
ALTER TABLE task ADD COLUMN reopened_at TEXT;
