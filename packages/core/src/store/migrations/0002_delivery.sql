-- Schema v2: outbox delivery. Forward only: never edit this file once committed; add the
-- next numbered file instead. Timestamps are ISO-8601 UTC text, JSON columns hold text
-- checked by zod on read and write, flags are 0 or 1.

-- A conversation on a gateway: the thread of a block (purpose 'block') or of a feed line
-- (purpose 'feed_line'). A block may have several.
CREATE TABLE conversation (
  ref TEXT NOT NULL,
  gateway TEXT NOT NULL,
  space TEXT NOT NULL,
  task_id INTEGER REFERENCES task (id),
  block_id INTEGER REFERENCES block (id),
  purpose TEXT NOT NULL,
  state TEXT NOT NULL,
  root_message_ref TEXT NOT NULL,
  after_message_ref TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (gateway, ref)
) STRICT;

-- One row per (gateway, space) whose transport is failing; its rows wait while it stands.
-- probe_at is when the last probe's send started: one probe per minute, kept across restarts.
CREATE TABLE transport_health (
  gateway TEXT NOT NULL,
  space TEXT NOT NULL,
  reason TEXT NOT NULL,
  since TEXT NOT NULL,
  probe_at TEXT NOT NULL,
  PRIMARY KEY (gateway, space)
) STRICT;

-- When the last send into a (gateway, space) started: the next one waits the space interval,
-- kept across restarts.
CREATE TABLE space_slot (
  gateway TEXT NOT NULL,
  space TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (gateway, space)
) STRICT;

-- A dependent row (reply, close, edit) is sent only after its parent is done.
ALTER TABLE outbox ADD COLUMN parent_outbox_id INTEGER REFERENCES outbox (id);
-- The first attempt of the current retry window; NULL while the window is suspended.
ALTER TABLE outbox ADD COLUMN first_attempt_at TEXT;
-- NULL for a comment that is not delivered to a gateway.
ALTER TABLE comment ADD COLUMN delivery_state TEXT;

CREATE INDEX outbox_parent_outbox_id ON outbox (parent_outbox_id);
