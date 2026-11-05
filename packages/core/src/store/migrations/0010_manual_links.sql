-- Manual ticket links and observed PR openness. Preserve existing link IDs and provenance.
CREATE TABLE link_new (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task (id),
  entity TEXT NOT NULL,
  repo TEXT,
  number INTEGER,
  pr_state TEXT,
  session_id TEXT,
  role TEXT,
  source TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0, 1)),
  created_at TEXT NOT NULL,
  ticket_key TEXT,
  pr_open INTEGER CHECK (pr_open IN (0, 1)),
  CHECK (entity <> 'pr' OR
    (repo IS NOT NULL AND number IS NOT NULL AND pr_state IS NOT NULL AND pr_open IS NOT NULL)),
  CHECK (entity <> 'session' OR session_id IS NOT NULL),
  CHECK (entity <> 'ticket' OR ticket_key IS NOT NULL)
) STRICT;

INSERT INTO link_new (id, task_id, entity, repo, number, pr_state, session_id, role,
  source, banned, created_at, ticket_key, pr_open)
SELECT link.id, link.task_id, link.entity, link.repo, link.number, link.pr_state,
  link.session_id, link.role, link.source, link.banned, link.created_at, NULL,
  CASE WHEN link.entity = 'pr' THEN
    CASE WHEN EXISTS (
      SELECT 1 FROM pr_snapshot AS pr
      WHERE pr.repo = link.repo AND pr.number = link.number AND pr.state IN ('closed', 'merged')
    ) THEN 0 ELSE 1 END
  ELSE NULL END
FROM link;

DROP TABLE link;
ALTER TABLE link_new RENAME TO link;
CREATE UNIQUE INDEX link_pr_pair ON link (task_id, repo, number) WHERE entity = 'pr';
CREATE UNIQUE INDEX link_session_pair ON link (task_id, session_id) WHERE entity = 'session';
CREATE UNIQUE INDEX link_ticket_pair ON link (task_id, ticket_key) WHERE entity = 'ticket';
CREATE UNIQUE INDEX link_one_active_pr ON link (task_id)
  WHERE entity = 'pr' AND pr_state = 'active' AND banned = 0 AND pr_open = 1;
