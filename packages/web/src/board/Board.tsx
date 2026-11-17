import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Banner, Button } from '../ds/index.ts';
import type { BoardData, BoardSnapshot, TaskState } from './data.ts';
import { banners, boardColumns, chosenProject, indicator, openHref } from './model.ts';
import { Columns, type ColumnsView } from './Columns.tsx';
import { Header } from './Header.tsx';
import { InboxPanel } from './InboxPanel.tsx';
import { taskParam } from './task-model.ts';
import { TaskView, type TaskTitle } from './TaskView.tsx';
import styles from './Board.module.css';

/** Skeleton columns before `config.get` answers, as in the prototype. */
const UNNAMED = [undefined, undefined, undefined, undefined];

function columnsView(snapshot: BoardSnapshot): ColumnsView {
  const project = chosenProject(snapshot);
  if (snapshot.status === undefined) {
    if (snapshot.readFailed) return { kind: 'failed' };
    return { kind: 'loading', names: project?.columns.map(({ id }) => id) ?? UNNAMED };
  }
  if (snapshot.status.tasks.length === 0) return { kind: 'empty', project: snapshot.project ?? '' };
  const configured = project?.columns ?? [];
  const ids = new Set(configured.map(({ id }) => id));
  return {
    kind: 'columns',
    columns: boardColumns(configured, snapshot.status.tasks),
    unknown: snapshot.status.tasks.filter((row) => !ids.has(row.column)),
  };
}

/** The ticket title comes from the held `status.get` row; the task view reads no other. */
function taskTitle(snapshot: BoardSnapshot, task: TaskState): TaskTitle {
  if (snapshot.status === undefined)
    return snapshot.readFailed ? { state: 'none' } : { state: 'loading' };
  const key = task.value?.task.key ?? task.key;
  const text = snapshot.status.tasks.find((row) => row.key === key)?.ticket?.title;
  return text === undefined ? { state: 'none' } : { state: 'ready', text };
}

/** The current URL without `open`, keeping the other params and the hash. */
function withoutOpen(): string {
  const params = new URLSearchParams(location.search);
  params.delete('open');
  const search = params.toString();
  return `${location.pathname}${search === '' ? '' : `?${search}`}${location.hash}`;
}

function inboxBackground(): boolean {
  const state: unknown = history.state;
  return (
    new URLSearchParams(location.search).get('open') === 'inbox' ||
    (taskParam(location.search) !== null &&
      typeof state === 'object' &&
      state !== null &&
      'inbox' in state &&
      state.inbox === true)
  );
}

function inboxProject(): string | null {
  const state: unknown = history.state;
  return inboxBackground() &&
    typeof state === 'object' &&
    state !== null &&
    'project' in state &&
    typeof state.project === 'string'
    ? state.project
    : null;
}

/**
 * The board screen: header, banners, the columns of the chosen project and the task view that
 * `?open=<task key>` names, on load, on Back and Forward, and on a card click.
 */
export function Board({ data }: { data: BoardData }) {
  const snapshot = useSyncExternalStore(data.subscribe, data.snapshot);
  const [filter, setFilter] = useState('');
  const [openKey, setOpenKey] = useState(() => taskParam(location.search));
  const [inboxOpen, setInboxOpen] = useState(inboxBackground);
  const [pendingProject, setPendingProject] = useState(inboxProject);
  const inboxTrigger = useRef<HTMLSpanElement>(null);
  const wasInboxOpen = useRef(inboxOpen);
  // The task key whose card takes focus after close when the task view returned it nowhere.
  const closed = useRef<string | null>(null);
  useEffect(() => {
    const onPop = () => {
      setOpenKey(taskParam(location.search));
      setInboxOpen(inboxBackground());
      setPendingProject(inboxProject());
    };
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('popstate', onPop);
    };
  }, []);
  useEffect(() => {
    if (pendingProject === null) return;
    if (openKey === null || !inboxOpen) {
      setPendingProject(null);
      return;
    }
    if (snapshot.config === undefined) return;
    data.choose(pendingProject);
    setPendingProject(null);
  }, [data, openKey, inboxOpen, pendingProject, snapshot.config]);
  useEffect(() => {
    data.open(openKey);
  }, [data, openKey]);
  useEffect(() => {
    if (wasInboxOpen.current && !inboxOpen) inboxTrigger.current?.querySelector('button')?.focus();
    wasInboxOpen.current = inboxOpen;
  }, [inboxOpen]);
  const onHistory = useCallback(
    (shown: boolean) => {
      data.showHistory(shown);
    },
    [data],
  );
  const { task } = snapshot;
  // Runs after the task view's layer returned focus to its opener on unmount.
  useEffect(() => {
    const key = closed.current;
    if (task !== undefined || key === null || inboxOpen) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const href = openHref(key);
    [...document.querySelectorAll<HTMLElement>('main a[href]')]
      .find((link) => link.getAttribute('href') === href)
      ?.focus();
  }, [task, inboxOpen]);
  const list = banners(snapshot);
  const view = columnsView(snapshot);
  const project = snapshot.config?.projects.find(({ id }) => id === task?.value?.task.project);
  return (
    <>
      <Header
        projects={snapshot.config?.projects}
        project={chosenProject(snapshot)}
        onChoose={(project) => {
          data.choose(project);
        }}
        filter={filter}
        onFilter={setFilter}
        indicator={indicator(snapshot)}
        inbox={snapshot.inbox?.items.length}
        inboxTrigger={inboxTrigger}
        inboxOpen={inboxOpen}
        onInbox={() => {
          history.pushState(null, '', openHref('inbox'));
          setInboxOpen(true);
          setOpenKey(null);
        }}
      />
      {list.length > 0 && (
        <div className={styles.banners}>
          {list.map((banner) => (
            <Banner
              key={banner.variant}
              variant={banner.variant}
              icon={banner.icon}
              detail={banner.detail}
              action={
                banner.variant === 'error' ? (
                  <Button
                    busy={snapshot.retrying}
                    onClick={() => {
                      data.retry();
                    }}
                  >
                    {snapshot.retrying ? 'Retrying' : 'Retry now'}
                  </Button>
                ) : undefined
              }
            >
              {banner.text}
            </Banner>
          ))}
        </div>
      )}
      <main
        className={styles.main}
        aria-label="Board"
        aria-busy={view.kind === 'loading' || undefined}
      >
        <Columns
          key={snapshot.project}
          view={view}
          filter={filter}
          stale={list[0]?.variant === 'error'}
          now={snapshot.lastGoodAt}
          spurUiOrigin={snapshot.config?.web.spurUiOrigin ?? null}
          ticketBrowseBase={chosenProject(snapshot)?.ticketBrowseBase ?? null}
          onOpen={(key) => {
            history.pushState(null, '', openHref(key));
            setOpenKey(key);
          }}
        />
      </main>
      {inboxOpen && (
        <InboxPanel
          snapshot={snapshot}
          now={data.now()}
          onClose={() => {
            history.pushState(null, '', withoutOpen());
            setInboxOpen(false);
            setOpenKey(null);
          }}
          onOpen={(entry) => {
            if (entry.task === null) return;
            setPendingProject(entry.project);
            history.pushState({ inbox: true, project: entry.project }, '', openHref(entry.task));
            setOpenKey(entry.task);
          }}
        />
      )}
      {task !== undefined && (
        <TaskView
          key={task.key}
          task={task}
          history={snapshot.history}
          title={taskTitle(snapshot, task)}
          columns={project?.columns.map(({ id }) => id) ?? []}
          spurUiOrigin={snapshot.config?.web.spurUiOrigin ?? null}
          ticketBrowseBase={project?.ticketBrowseBase ?? null}
          now={data.now()}
          offline={snapshot.stream === 'offline'}
          config={snapshot.config}
          unavailable={
            snapshot.readFailed
              ? 'The board daemon does not answer. Answers and comments cannot be sent.'
              : snapshot.stream === 'offline'
                ? 'Live updates are lost. Answers and comments cannot be sent.'
                : undefined
          }
          answerIntent={data.answerIntent}
          followUpIntent={data.followUpIntent}
          commentIntent={data.commentIntent}
          refreshTask={data.refreshTask}
          onClose={() => {
            closed.current = task.value?.task.key ?? task.key;
            history.pushState(null, '', inboxOpen ? openHref('inbox') : withoutOpen());
            setOpenKey(null);
          }}
          onRetry={() => {
            data.retryTask();
          }}
          onHistory={onHistory}
          onRetryHistory={() => {
            data.retryHistory();
          }}
        />
      )}
    </>
  );
}
