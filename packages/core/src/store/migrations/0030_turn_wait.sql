-- The holder's wait on a taken turn (task.wait). A wait is active exactly while wait_until is set;
-- its end clears wait_until and sets wait_ended_at, and keeps wait_reason and wait_since for the
-- wake ring. wait_count and waited_ms count every wait of the turn and are never reset.
ALTER TABLE turn ADD COLUMN wait_reason TEXT;
ALTER TABLE turn ADD COLUMN wait_since TEXT;
ALTER TABLE turn ADD COLUMN wait_until TEXT;
ALTER TABLE turn ADD COLUMN wait_ended_at TEXT;
ALTER TABLE turn ADD COLUMN wait_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn ADD COLUMN waited_ms INTEGER NOT NULL DEFAULT 0;
