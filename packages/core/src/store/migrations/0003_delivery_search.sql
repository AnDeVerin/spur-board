-- Keep the earliest possible send time across retry-window and transport-health resets.
-- Existing uncertain rows remain NULL and must search without a lower bound.
ALTER TABLE outbox ADD COLUMN first_delivery_at TEXT;
