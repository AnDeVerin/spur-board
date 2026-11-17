import { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Chip,
  focusRing,
  Icon,
  CollapsibleSection,
  quiet,
  KeyValueBox,
  Modal,
  Skeleton,
  TabPanel,
  Tabs,
} from '../ds/index.ts';
import type { BoardConfig, BoardData, BoardTask, HistoryState, TaskState } from './data.ts';
import { TaskWrite } from './TaskWrite.tsx';
import { TaskHistory } from './TaskHistory.tsx';
import { shortKey } from './model.ts';
import { age, linkChips, timeInColumn, whyRows, whySummary } from './task-model.ts';
import styles from './TaskView.module.css';
import cardStyles from './Card.module.css';
import type { BoardRow } from './model.ts';

const TABS_ID = 'task-tabs';
const TABS = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History' },
];

/** The ticket title line: a skeleton until `status.get` settles, none without a held row. */
export type TaskTitle = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'none' };

/**
 * The task view: a modal with the short key, `<column> · <time in column>` and the Now and
 * History tabs. Now holds links, Why, blocks and comments; History lists journal events and
 * reads only while shown. Key it by the task key so state resets for another task.
 */
export function TaskView({
  task,
  history,
  title,
  row,
  columns,
  spurUiOrigin,
  ticketBrowseBase,
  now,
  offline,
  onClose,
  onRetry,
  onHistory,
  onRetryHistory,
  config,
  unavailable,
  answerIntent,
  followUpIntent,
  commentIntent,
  refreshTask,
}: {
  task: TaskState;
  history: HistoryState | undefined;
  config: BoardConfig | undefined;
  unavailable: string | undefined;
  answerIntent: BoardData['answerIntent'];
  followUpIntent: BoardData['followUpIntent'];
  commentIntent: BoardData['commentIntent'];
  refreshTask: BoardData['refreshTask'];
  title: TaskTitle;
  row: BoardRow | undefined;
  /** Enabled column ids of the task's project in `config.get` order. */
  columns: readonly string[];
  /** `config.get` `web.spurUiOrigin`: session chips link there; null keeps them plain. */
  spurUiOrigin: string | null;
  /** Jira browse base of the task's own configured project; null keeps its chip plain. */
  ticketBrowseBase: string | null;
  now: number;
  /** Live updates are lost: the board banner says so, so kept data shows no modal banner. */
  offline: boolean;
  onClose: () => void;
  onRetry: () => void;
  onHistory: (shown: boolean) => void;
  onRetryHistory: () => void;
}) {
  const [tab, setTab] = useState('now');
  const historyShown = tab === 'history';
  useEffect(() => {
    if (!historyShown) return;
    onHistory(true);
    return () => {
      onHistory(false);
    };
  }, [historyShown, onHistory]);
  const { value } = task;
  const key = value?.task.key ?? task.key;
  const inColumn = value === undefined ? undefined : timeInColumn(value.task.column, row, now);
  const detail =
    value === undefined ? undefined : (
      <>
        {' · '}
        <span className={styles.columnName}>{value.task.column.toUpperCase()}</span>
        {inColumn !== undefined && (
          <>
            {' · '}
            <span className={styles.duration}>{inColumn}</span>
          </>
        )}
      </>
    );
  const failed = task.state === 'failed' || task.retrying;
  const chips =
    value === undefined ? [] : linkChips(value.links, key, spurUiOrigin, ticketBrowseBase, row);
  return (
    <Modal
      open
      onClose={onClose}
      title={<span title={key}>{shortKey(key)}</span>}
      detail={detail}
      actions={<Tabs id={TABS_ID} label="Task view" tabs={TABS} value={tab} onChange={setTab} />}
    >
      <TabPanel tabsId={TABS_ID} value={tab}>
        {/* Keep drafts and intent guards for this modal's lifetime, including on History. */}
        <div hidden={tab !== 'now'}>
          {task.state === 'missing' ? (
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
              <div className={`${quiet} ${styles.top ?? ''}`}>
                {title.state === 'loading' ? (
                  <Skeleton widths={[60]} />
                ) : (
                  title.state === 'ready' && <h2 className={styles.title}>{title.text}</h2>
                )}
                {value === undefined
                  ? task.state === 'loading' && <Skeleton />
                  : chips.length > 0 && (
                      <div className={styles.links}>
                        {chips.map((chip, index) =>
                          // A link has no id of its own; its position in the list stays put.
                          chip.href === null ? (
                            <span
                              key={index}
                              className={`${cardStyles.cell ?? ''} ${cardStyles.standalone ?? ''}`}
                              title={chip.text}
                            >
                              <Icon name={chip.icon} />
                              <span className={styles.linkText}>{chip.text}</span>
                            </span>
                          ) : (
                            <a
                              key={index}
                              className={`${cardStyles.cell ?? ''} ${cardStyles.standalone ?? ''} ${focusRing}`}
                              href={chip.href}
                              aria-label={chip.label}
                              title={chip.text}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Icon name={chip.icon} />
                              <span className={styles.linkText}>{chip.text}</span>
                            </a>
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
              {value !== undefined && (
                <TaskDiscussion
                  value={value}
                  taskKey={task.key}
                  config={config}
                  now={now}
                  unavailable={
                    value.task.membership === 'archived'
                      ? 'This task is archived. Answers and comments cannot be sent.'
                      : unavailable
                  }
                  answerIntent={answerIntent}
                  followUpIntent={followUpIntent}
                  commentIntent={commentIntent}
                  refreshTask={refreshTask}
                />
              )}
            </>
          )}
        </div>
        {historyShown && (
          <div role="region" aria-label="History">
            {task.state === 'missing' || history?.state === 'missing' ? (
              <p className={styles.note}>Task not found.</p>
            ) : (
              <TaskHistory history={history} offline={offline} onRetry={onRetryHistory} />
            )}
          </div>
        )}
      </TabPanel>
    </Modal>
  );
}

function TaskDiscussion({
  value,
  taskKey,
  config,
  now,
  unavailable,
  answerIntent,
  followUpIntent,
  commentIntent,
  refreshTask,
}: {
  value: BoardTask;
  taskKey: string;
  config: BoardConfig | undefined;
  now: number;
  unavailable: string | undefined;
  answerIntent: BoardData['answerIntent'];
  followUpIntent: BoardData['followUpIntent'];
  commentIntent: BoardData['commentIntent'];
  refreshTask: BoardData['refreshTask'];
}) {
  const name = (actor: string) => {
    if (actor === 'operator') return 'you';
    if (!actor.startsWith('agent:')) return actor;
    const [project, ...session] = actor.slice(6).split('/');
    const binding = config?.projects
      .flatMap((entry) => entry.spurProjects)
      .find((entry) => entry.name === project);
    return `${binding?.displayName ?? project ?? actor} / ${session.join('/')}`;
  };
  const blocks = [...value.blocks].sort(
    (a, b) => Number(b.state === 'open') - Number(a.state === 'open'),
  );
  const comments = value.comments.filter((comment) => comment.block === null);
  const metadata = (author: string, at: string) => `${name(author)} · ${age(at, now)}`;
  // Blocks whose follow-up was opened: their answer's "Answer sent." line gives way to it.
  const [followed, setFollowed] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      <CollapsibleSection
        title="Blocks"
        count={blocks.length}
        summary={`${String(blocks.filter((block) => block.state === 'open').length)} open`}
      >
        <div className={styles.items}>
          {blocks.length === 0 && <p className={styles.empty}>No blocks on this task.</p>}
          {blocks.map((block) => {
            const question = block.type === 'needs_input';
            const mine = block.state === 'open' && block.addressee === 'operator';
            const replies = value.comments.filter((comment) => comment.block === block.id);
            const answered = question && block.state === 'unblocked' && block.outcome === 'done';
            return (
              <article
                key={block.id}
                className={`${quiet} ${styles.item ?? ''} ${mine ? (styles.forYou ?? '') : ''}`}
              >
                <div className={styles.metadata}>
                  <strong>{block.id}</strong>
                  <span>{metadata(block.author, block.at)}</span>
                  <span>→ {block.addressee === 'operator' ? 'you' : block.addressee}</span>
                  <Chip>
                    {block.state === 'open'
                      ? 'open'
                      : answered
                        ? `answered${block.answeredVia ? ` via ${block.answeredVia === 'slack' ? 'Slack' : block.answeredVia}` : ''}`
                        : (block.outcome ?? 'closed')}
                  </Chip>
                </div>
                <p className={styles.text}>{block.reason}</p>
                {replies.map((reply) => (
                  <div key={reply.id} className={styles.reply}>
                    <div className={styles.metadata}>
                      {reply.id} · {metadata(reply.author, reply.at)}
                    </div>
                    <p className={styles.text}>{reply.text}</p>
                  </div>
                ))}
                {!answered && block.outcomeReason && (
                  <p className={styles.text}>{block.outcomeReason}</p>
                )}
                <TaskWrite
                  eligible={mine && question}
                  label={`Answer ${block.id}`}
                  kind="answer"
                  superseded={followed.has(block.id)}
                  unavailable={unavailable}
                  createIntent={(text) => answerIntent(taskKey, block.id, text)}
                  refreshTask={refreshTask}
                />
                {answered && (
                  <TaskWrite
                    label={`Follow-up on ${block.id}`}
                    kind="followup"
                    unavailable={unavailable}
                    onOpen={() => {
                      setFollowed((ids) => new Set(ids).add(block.id));
                    }}
                    createIntent={(text) => followUpIntent(taskKey, block.id, text)}
                    refreshTask={refreshTask}
                  />
                )}
              </article>
            );
          })}
        </div>
      </CollapsibleSection>
      <CollapsibleSection title="Comments" count={comments.length}>
        <div className={styles.items}>
          {comments.length === 0 && <p className={styles.empty}>No comments on this task.</p>}
          {comments.map((comment) => (
            <article key={comment.id} className={`${quiet} ${styles.item ?? ''}`}>
              <div className={styles.metadata}>
                {comment.id} · {metadata(comment.author, comment.at)}
              </div>
              <p className={styles.text}>{comment.text}</p>
            </article>
          ))}
          <div className={`${quiet} ${styles.item ?? ''}`}>
            <TaskWrite
              label="Comment"
              kind="comment"
              unavailable={unavailable}
              createIntent={(text) => commentIntent(taskKey, text)}
              refreshTask={refreshTask}
            />
          </div>
        </div>
      </CollapsibleSection>
    </>
  );
}
