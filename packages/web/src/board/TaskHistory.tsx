import { useState } from 'react';
import { Banner, Button, Skeleton, quiet } from '../ds/index.ts';
import type { HistoryState } from './data.ts';
import { historyRuns } from './task-model.ts';
import styles from './TaskHistory.module.css';

/**
 * The History tab: quiet journal rows newest first, folding runs of at least three raw matches.
 * Each row keeps its time, summary, actor and raw kind. A Skeleton until the first answer; a failed read shows an
 * error banner with Retry above the rows it kept, except while offline, when the board banner
 * already says so. The caller shows "Task not found." in place of a missing history.
 */
export function TaskHistory({
  history,
  offline,
  onRetry,
}: {
  history: HistoryState | undefined;
  /** Live updates are lost: kept rows show no banner of their own. */
  offline: boolean;
  onRetry: () => void;
}) {
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<number>>(new Set());
  const value = history?.value;
  const failed = history !== undefined && (history.state === 'failed' || history.retrying);
  const loading = history === undefined || history.state === 'loading';
  return (
    <>
      {failed && !(offline && value !== undefined) && (
        <Banner
          variant="error"
          icon="x"
          action={
            <Button busy={history.retrying} onClick={onRetry}>
              {history.retrying ? 'Retrying' : 'Retry'}
            </Button>
          }
        >
          Could not load the history.
        </Banner>
      )}
      {value === undefined ? (
        loading && (
          <div className={styles.loading}>
            <Skeleton />
          </div>
        )
      ) : value.events.length === 0 ? (
        <p className={styles.empty}>No journal events for this task.</p>
      ) : (
        <table className={styles.table} aria-label="Task history">
          <tbody>
            {historyRuns(value.events).flatMap((run) => {
              const grouped = run.rows.length >= 3;
              const expanded = expandedRuns.has(run.key);
              return (expanded ? run.rows : run.rows.slice(0, 1)).map((row, index) => (
                <tr
                  key={row.key}
                  className={[quiet, grouped && expanded ? styles.run : undefined]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td className={styles.when}>{row.time}</td>
                  <td className={styles.what}>
                    {row.summary} · <span className={styles.actor}>{row.actor}</span>
                    {grouped && index === 0 && (
                      <>
                        {' '}
                        <Button
                          expanded={expanded}
                          onClick={() => {
                            setExpandedRuns((current) => {
                              const next = new Set(current);
                              if (next.has(run.key)) next.delete(run.key);
                              else next.add(run.key);
                              return next;
                            });
                          }}
                        >
                          {expanded
                            ? `${String(run.rows.length)} rows`
                            : `+${String(run.rows.length - 1)}`}
                          <span className={styles.actionText}>
                            {expanded ? ', collapse matching rows' : ', show matching rows'}
                          </span>
                        </Button>
                        {!expanded && <span className={styles.since}> since {run.since}</span>}
                      </>
                    )}
                  </td>
                  <td className={styles.kind}>{row.kind}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
