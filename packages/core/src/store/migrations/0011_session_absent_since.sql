-- When a complete Spur poll first omitted the session; NULL while it is still observed.
ALTER TABLE session_snapshot ADD COLUMN absent_since TEXT;
