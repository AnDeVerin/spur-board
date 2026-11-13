-- A PR comment history the GitHub adapter is still reading back, per source and PR. A regular
-- poll's `pr` item asks core to hold it (`continuation` with an opaque `resume`, NULL once the
-- read reached the start of the PR) and core passes it back in `PollContext.continuations`.
-- `ref_key` is the PR's entity ref key; `feedback` is the JSON array of feedback entries read so
-- far, checked by zod on read. Core never parses `resume`. A row goes when an item states `null`
-- or when the source no longer has an unbanned link to the PR.
CREATE TABLE pr_continuation (
  source TEXT NOT NULL REFERENCES source_state (source),
  ref_key TEXT NOT NULL,
  resume TEXT,
  feedback TEXT NOT NULL,
  PRIMARY KEY (source, ref_key)
) STRICT;
