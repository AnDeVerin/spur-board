-- A live task's 1-based place in its (project, column) order: dense 1..n among non-archived tasks.
-- The backfill orders each column by the latest real column entry, the predicate of
-- readStatusColumnEntries frozen here, then journal order, then task id; created_at stands in for
-- a task with no entry. Two triggers keep the order dense from then on. Any insert, column change,
-- column_epoch change or un-archive puts the task last; leaving a column or archiving closes the
-- gap. The WHEN guard skips a SET that keeps column, epoch and archived-ness, because SQLite fires
-- UPDATE OF for every listed column in SET, changed or not. task.order rewrites position alone,
-- which no trigger watches. A table rebuild of task must recreate both triggers.
ALTER TABLE task ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

WITH entry AS (
  SELECT e.task_id, MAX(e.id) AS id
  FROM event e
  JOIN task t ON t.id = e.task_id
  WHERE t.membership != 'archived'
    AND (json_extract(e.payload, '$.to') = t."column" OR (
      e.kind = 'task_added' AND e.at = t.created_at
      AND json_extract(e.payload, '$.column') = t."column"
      AND e.id = (
        SELECT MIN(original.id) FROM event original
        WHERE original.task_id = t.id AND original.kind = 'task_added'
      )
    ))
    AND (e.kind IN ('task_added', 'task_moved', 'task_manually_moved')
      OR (e.kind = 'task_mirror_moved' AND json_extract(e.payload, '$.shadow') IS NULL)
      OR (e.kind = 'task_corrected' AND json_extract(e.payload, '$.shadow') = 0))
  GROUP BY e.task_id
),
ranked AS (
  SELECT t.id, ROW_NUMBER() OVER (
    PARTITION BY t.project, t."column"
    ORDER BY julianday(coalesce(latest.at, t.created_at)), latest.id, t.id
  ) AS place
  FROM task t
  LEFT JOIN entry ON entry.task_id = t.id
  LEFT JOIN event latest ON latest.id = entry.id
  WHERE t.membership != 'archived'
)
UPDATE task SET position = (SELECT place FROM ranked WHERE ranked.id = task.id)
WHERE membership != 'archived';

CREATE TRIGGER task_position_insert AFTER INSERT ON task
WHEN NEW.membership != 'archived'
BEGIN
  UPDATE task SET position = (
    SELECT coalesce(MAX(other.position), 0) + 1 FROM task other
    WHERE other.project = NEW.project AND other."column" = NEW."column"
      AND other.membership != 'archived' AND other.id != NEW.id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER task_position_update AFTER UPDATE OF "column", column_epoch, membership ON task
WHEN OLD."column" IS NOT NEW."column"
  OR OLD.column_epoch IS NOT NEW.column_epoch
  OR (OLD.membership = 'archived') IS NOT (NEW.membership = 'archived')
BEGIN
  UPDATE task SET position = position - 1
  WHERE OLD.membership != 'archived'
    AND project = OLD.project AND "column" = OLD."column"
    AND membership != 'archived' AND id != OLD.id AND position > OLD.position;
  UPDATE task SET position = (
    SELECT coalesce(MAX(other.position), 0) + 1 FROM task other
    WHERE other.project = NEW.project AND other."column" = NEW."column"
      AND other.membership != 'archived' AND other.id != NEW.id
  )
  WHERE id = NEW.id AND NEW.membership != 'archived';
END;
