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
INSERT OR IGNORE INTO pr_ticket_key (repo, number, source, ticket_key)
SELECT p.repo, p.number, p.source, k.value
FROM (
  SELECT s.repo, s.number, m.value,
    substr(m.key, 9, length(m.key) - 8 - length(':pr:' || lower(s.repo) || '#' || s.number)) AS source
  FROM meta m, pr_snapshot s
  WHERE m.key GLOB 'pr-poll:*'
    AND substr(m.key, -length(':pr:' || lower(s.repo) || '#' || s.number))
      = ':pr:' || lower(s.repo) || '#' || s.number
) p,
  json_each(
    CASE WHEN json_valid(p.value) THEN
      CASE WHEN json_type(p.value, '$.ticketKeys') = 'array' THEN p.value END
    END,
    '$.ticketKeys'
  ) k
WHERE p.source <> '' AND k.type = 'text';
