import { useState } from 'react';
import {
  Banner,
  Button,
  Chip,
  CollapsibleSection,
  KeyValueBox,
  Modal,
  Skeleton,
  TabPanel,
  Tabs,
} from '../ds/index.ts';
import type { TaskState } from './data.ts';
import { shortKey } from './model.ts';
import { linkChips, timeInColumn, whyRows, whySummary } from './task-model.ts';
import styles from './TaskView.module.css';

const TABS_ID = 'task-tabs';
const TABS = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History' },
];

/** The ticket title line: a skeleton until `status.get` settles, none without a held row. */
export type TaskTitle = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'none' };

/**
 * The task view: a modal with the short key, `<column> · <time in column>` and the Now and
 * History tabs. Now holds the ticket title, the link chips and "Why it is here"; History is a
 * placeholder. Key it by the task key so the tab resets for another task.
 */
export function TaskView({
  task,
  title,
  columns,
  now,
  offline,
  onClose,
  onRetry,
}: {
  task: TaskState;
  title: TaskTitle;
  /** Enabled column ids of the task's project in `config.get` order. */
  columns: readonly string[];
  now: number;
  /** Live updates are lost: the board banner says so, so kept data shows no modal banner. */
  offline: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [tab, setTab] = useState('now');
  const { value } = task;
  const key = value?.task.key ?? task.key;
  const inColumn = value === undefined ? undefined : timeInColumn(value, now);
  const detail =
    value === undefined
      ? undefined
      : inColumn === undefined
        ? value.task.column
        : `${value.task.column} · ${inColumn}`;
  const failed = task.state === 'failed' || task.retrying;
  return (
    <Modal
      open
      onClose={onClose}
      title={<span title={key}>{shortKey(key)}</span>}
      detail={detail}
      actions={<Tabs id={TABS_ID} label="Task view" tabs={TABS} value={tab} onChange={setTab} />}
    >
      <TabPanel tabsId={TABS_ID} value={tab}>
        {tab === 'history' ? (
          <p className={styles.note}>History arrives in a later version.</p>
        ) : task.state === 'missing' ? (
          <p className={styles.note}>Task not found.</p>
        ) : (
          <>
            {failed && !(offline && value !== undefined) && (
              <Banner
                variant="error"
                icon="x"
                action={
                  <Button busy={task.retrying} onClick={onRetry}>
                    {task.retrying ? 'Retrying' : 'Retry'}
                  </Button>
                }
              >
                Could not load the task.
              </Banner>
            )}
            <div className={styles.top}>
              {title.state === 'loading' ? (
                <Skeleton widths={[60]} />
              ) : (
                title.state === 'ready' && <h2 className={styles.title}>{title.text}</h2>
              )}
              {value === undefined
                ? task.state === 'loading' && <Skeleton />
                : value.links.length > 0 && (
                    <div className={styles.links}>
                      {linkChips(value.links).map((chip, index) =>
                        chip.href === null ? (
                          // A link has no id of its own; its position in the list stays put.
                          <span key={index} title={chip.title}>
                            <Chip>{chip.text}</Chip>
                          </span>
                        ) : (
                          <Chip key={index} href={chip.href} label={chip.label}>
                            {chip.text}
                          </Chip>
                        ),
                      )}
                    </div>
                  )}
            </div>
            {value !== undefined && (
              <CollapsibleSection title="Why it is here" summary={whySummary(value)}>
                <KeyValueBox rows={whyRows(value, columns, now)} />
              </CollapsibleSection>
            )}
          </>
        )}
      </TabPanel>
    </Modal>
  );
}
