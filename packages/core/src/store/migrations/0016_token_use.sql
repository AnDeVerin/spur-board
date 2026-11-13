-- When an operator token was approved, and when an authenticated call last used it. Revoke
-- overwrites `decided_at`, so the backfill sets `approved_at` only for rows still approved: a token
-- revoked before this migration keeps `approved_at` NULL. `last_used_at` is NULL until the first
-- call with the token and is written at most once per token per few minutes.
ALTER TABLE operator_token ADD COLUMN approved_at TEXT;
ALTER TABLE operator_token ADD COLUMN last_used_at TEXT;
UPDATE operator_token SET approved_at = decided_at WHERE status = 'approved';
