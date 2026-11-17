import { Banner, Button, Skeleton, quiet } from '../ds/index.ts';
import type { HistoryState } from './data.ts';
import { historyRows } from './task-model.ts';
import styles from './TaskHistory.module.css';

/**
 * The History tab: the task's journal events newest first, one quiet row each with the time, the
 * summary and actor, and the raw kind. A Skeleton until the first answer; a failed read shows an
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
            {historyRows(value.events).map((row) => (
              <tr key={row.key} className={quiet}>
                <td className={styles.when}>{row.time}</td>
                <td className={styles.what}>
                  {row.summary} · <span className={styles.actor}>{row.actor}</span>
                </td>
                <td className={styles.kind}>{row.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
