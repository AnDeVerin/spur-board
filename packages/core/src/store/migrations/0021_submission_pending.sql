-- A turn submit the board accepted before it could confirm the head waits for a later poll.
-- pending_until is the ISO-8601 UTC deadline for a PR to appear; NULL means not pending, which is
-- every row recorded before this migration and every submit whose head was confirmed. The board
-- clears it when a poll confirms the head and voids the row when it hands the turn back.
-- A null pr_repo / pr_number, which 0014 reserved for a submit recorded before it, now also marks
-- a pending submit made before the board linked a PR; confirmation fills them in.
ALTER TABLE submission ADD COLUMN pending_until TEXT;
