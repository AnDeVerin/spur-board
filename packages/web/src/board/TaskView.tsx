import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Chip,
  CollapsibleSection,
  FormRow,
  TextArea,
  quiet,
  KeyValueBox,
  Modal,
  Skeleton,
  TabPanel,
  Tabs,
} from '../ds/index.ts';
import type { BoardConfig, BoardData, BoardTask, TaskState } from './data.ts';
import { shortKey } from './model.ts';
import { age, linkChips, timeInColumn, whyRows, whySummary } from './task-model.ts';
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
  spurUiOrigin,
  now,
  offline,
  onClose,
  onRetry,
  config,
  unavailable,
  answerIntent,
  commentIntent,
  refreshTask,
}: {
  task: TaskState;
  config: BoardConfig | undefined;
  unavailable: string | undefined;
  answerIntent: BoardData['answerIntent'];
  commentIntent: BoardData['commentIntent'];
  refreshTask: BoardData['refreshTask'];
  title: TaskTitle;
  /** Enabled column ids of the task's project in `config.get` order. */
  columns: readonly string[];
  /** `config.get` `web.spurUiOrigin`: session chips link there; null keeps them plain. */
  spurUiOrigin: string | null;
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
                        {linkChips(value.links, spurUiOrigin).map((chip, index) =>
                          // A link has no id of its own; its position in the list stays put.
                          chip.href === null ? (
                            <Chip key={index}>{chip.text}</Chip>
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
              {value !== undefined && (
                <TaskDiscussion
                  value={value}
                  taskKey={task.key}
                  config={config}
                  now={now}
                  unavailable={unavailable}
                  answerIntent={answerIntent}
                  commentIntent={commentIntent}
                  refreshTask={refreshTask}
                />
              )}
            </>
          )}
        </div>
        {tab === 'history' && <p className={styles.note}>History arrives in a later version.</p>}
      </TabPanel>
    </Modal>
  );
}

/** Each caller keeps its draft and retry intent through canonical data refreshes. */
function SendForm({
  label,
  answer = false,
  unavailable,
  createIntent,
  refreshTask,
}: {
  label: string;
  answer?: boolean;
  unavailable: string | undefined;
  createIntent: (text: string) => ReturnType<BoardData['commentIntent']>;
  refreshTask: BoardData['refreshTask'];
}) {
  const [draft, setDraft] = useState('');
  const revision = useRef(0);
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'sending' | 'refreshing' | 'refresh-failed'>('idle');
  const busy = useRef(false);
  const confirmed = useRef(false);
  const mounted = useRef(true);
  const intent = useRef<
    { text: string; value: ReturnType<BoardData['commentIntent']> } | undefined
  >(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reconcile = async (refresh: Promise<boolean>, submittedRevision: number) => {
    const ok = await refresh;
    if (!mounted.current) return;
    if (!ok) {
      setPhase('refresh-failed');
      return;
    }
    if (revision.current === submittedRevision) setDraft('');
    confirmed.current = false;
    busy.current = false;
    intent.current = undefined;
    setPhase('idle');
  };
  const submittedRevision = useRef(0);
  const success = answer ? 'Answer sent.' : 'Comment added.';
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || confirmed.current || unavailable) return;
        if (!draft.trim() || draft.length > 20_000) {
          setError(
            !draft.trim()
              ? 'Enter text before sending.'
              : 'Text must be 20,000 characters or fewer.',
          );
          return;
        }
        busy.current = true;
        submittedRevision.current = revision.current;
        if (intent.current?.text !== draft)
          intent.current = { text: draft, value: createIntent(draft) };
        setPhase('sending');
        setError(undefined);
        void intent.current.value.run().then(
          (result) => {
            if (!mounted.current) return;
            confirmed.current = true;
            setPhase('refreshing');
            void reconcile(result.refresh, submittedRevision.current);
          },
          (cause: unknown) => {
            if (!mounted.current) return;
            busy.current = false;
            setPhase('idle');
            setError(cause instanceof Error ? cause.message : 'Could not send. Retry your text.');
          },
        );
      }}
    >
      <FormRow
        label={label}
        error={error}
        hint={unavailable}
        actions={
          <Button
            type="submit"
            variant={answer ? 'primary' : 'outlined'}
            disabled={unavailable !== undefined}
            busy={phase !== 'idle'}
          >
            {phase === 'sending' ? 'Sending' : answer ? 'Send answer' : 'Add comment'}
          </Button>
        }
      >
        <TextArea
          value={draft}
          onChange={(text) => {
            revision.current++;
            setDraft(text);
            setError(undefined);
          }}
          disabled={unavailable !== undefined}
        />
      </FormRow>
      {(phase === 'refreshing' || phase === 'refresh-failed') && (
        <p role="status" className={styles.feedback}>
          {success} {phase === 'refreshing' ? 'Refreshing task…' : 'Could not refresh the task.'}
        </p>
      )}
      {phase === 'refresh-failed' && (
        <Button
          onClick={() => {
            setPhase('refreshing');
            void reconcile(refreshTask(), submittedRevision.current);
          }}
        >
          Refresh task
        </Button>
      )}
    </form>
  );
}

function TaskDiscussion({
  value,
  taskKey,
  config,
  now,
  unavailable,
  answerIntent,
  commentIntent,
  refreshTask,
}: {
  value: BoardTask;
  taskKey: string;
  config: BoardConfig | undefined;
  now: number;
  unavailable: string | undefined;
  answerIntent: BoardData['answerIntent'];
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
  return (
    <>
      <CollapsibleSection
        title="Blocks"
        count={blocks.length}
        summary={`${String(blocks.filter((block) => block.state === 'open').length)} open`}
      >
        <div className={styles.items}>
          {blocks.length === 0 && <p className={styles.note}>No blocks on this task.</p>}
          {blocks.map((block) => {
            const question = block.type === 'needs_input';
            const mine = block.state === 'open' && block.addressee === 'operator';
            const reply = value.comments.filter((comment) => comment.block === block.id).at(-1);
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
                        ? `answered${block.answeredVia ? ` via ${block.answeredVia === 'slack' ? 'Slack' : 'web'}` : ''}`
                        : (block.outcome ?? 'closed')}
                  </Chip>
                </div>
                <p className={styles.text}>{block.reason}</p>
                {reply && (
                  <div className={styles.reply}>
                    <div className={styles.metadata}>
                      {reply.id} · {metadata(reply.author, reply.at)}
                    </div>
                    <p className={styles.text}>{reply.text}</p>
                  </div>
                )}
                {!answered && block.outcomeReason && (
                  <p className={styles.text}>{block.outcomeReason}</p>
                )}
                {mine && question && (
                  <SendForm
                    label={`Answer ${block.id}`}
                    answer
                    unavailable={unavailable}
                    createIntent={(text) => answerIntent(taskKey, block.id, text)}
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
          {comments.map((comment) => (
            <article key={comment.id} className={`${quiet} ${styles.item ?? ''}`}>
              <div className={styles.metadata}>
                {comment.id} · {metadata(comment.author, comment.at)}
              </div>
              <p className={styles.text}>{comment.text}</p>
            </article>
          ))}
          <div className={`${quiet} ${styles.item ?? ''}`}>
            <SendForm
              label="Comment"
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
