-- Candidate index of the ticket keys each source last read for a PR, so a task added after its PR
-- finds the PR without reading every retained snapshot. It may hold stale extras: reconcileTaskPrs
-- re-checks each candidate against the snapshot and the source's polling state. Only pr() in
-- observe.ts writes snapshot details and polling keys; a new writer must keep this table current.
CREATE TABLE pr_ticket_key (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  source TEXT NOT NULL,
  ticket_key TEXT NOT NULL,
  PRIMARY KEY (repo, number, source, ticket_key),
  FOREIGN KEY (repo, number) REFERENCES pr_snapshot (repo, number) ON DELETE CASCADE
) STRICT;
CREATE INDEX pr_ticket_key_lookup ON pr_ticket_key (ticket_key, source);

-- Each snapshot's keys under the source that wrote it. CASE keeps malformed JSON out of json_each.
INSERT OR IGNORE INTO pr_ticket_key (repo, number, source, ticket_key)
SELECT s.repo, s.number, s.source, k.value
FROM pr_snapshot s,
  json_each(
    CASE WHEN json_valid(s.detail) THEN
      CASE WHEN json_type(s.detail, '$.ticketKeys') = 'array' THEN s.detail END
    END,
    '$.ticketKeys'
  ) k
WHERE k.type = 'text';

-- Keys other sources saved in their polling state ('pr-poll:<source>:pr:<lower repo>#<number>').
-- Each key is parsed once and joined through a temporary index on the lowercased snapshot
-- identity, so the backfill does not compare every polling key with every snapshot. Repo names
-- hold no ':' or '#', so the repo is the text after the last ':' and the number follows the '#'.
CREATE INDEX pr_snapshot_lower_identity ON pr_snapshot (lower(repo), number);

INSERT OR IGNORE INTO pr_ticket_key (repo, number, source, ticket_key)
SELECT s.repo, s.number, p.source, k.value
FROM (
  SELECT value,
    substr(prefix, 1, length(prefix) - 4) AS source,
    substr(head, length(prefix) + 1, length(head) - length(prefix) - 1) AS repo,
    CAST(digits AS INTEGER) AS number
  FROM (
    SELECT value, head, digits,
      rtrim(head, replace(head, ':', '')) AS prefix
    FROM (
      SELECT value, head, substr(rest, length(head) + 1) AS digits
      FROM (
        SELECT value, rest, rtrim(rest, '0123456789') AS head
        FROM (SELECT value, substr(key, 9) AS rest FROM meta WHERE key GLOB 'pr-poll:*')
      )
    )
  )
  WHERE head GLOB '*#' AND digits <> '' AND CAST(CAST(digits AS INTEGER) AS TEXT) = digits
    AND prefix GLOB '*:pr:' AND length(prefix) > 4
) p
JOIN pr_snapshot s ON lower(s.repo) = p.repo AND s.number = p.number,
  json_each(
    CASE WHEN json_valid(p.value) THEN
      CASE WHEN json_type(p.value, '$.ticketKeys') = 'array' THEN p.value END
    END,
    '$.ticketKeys'
  ) k
WHERE k.type = 'text';

DROP INDEX pr_snapshot_lower_identity;
