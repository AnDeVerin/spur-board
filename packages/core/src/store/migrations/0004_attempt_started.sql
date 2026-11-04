-- Claim and send start are separate transactions. Legacy in-flight rows may have been sent.
ALTER TABLE outbox ADD COLUMN attempt_started INTEGER NOT NULL DEFAULT 0 CHECK (attempt_started IN (0, 1));
UPDATE outbox SET attempt_started = 1 WHERE state = 'in_flight';
