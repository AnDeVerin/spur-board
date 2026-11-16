import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Banner, Button } from '../ds/index.ts';
import type { BoardData, BoardSnapshot, TaskState } from './data.ts';
import { banners, boardColumns, chosenProject, indicator, openHref } from './model.ts';
import { Columns, type ColumnsView } from './Columns.tsx';
import { Header } from './Header.tsx';
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
  return { kind: 'columns', columns: boardColumns(project?.columns ?? [], snapshot.status.tasks) };
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

/**
 * The board screen: header, banners, the columns of the chosen project and the task view that
 * `?open=<task key>` names, on load, on Back and Forward, and on a card click.
 */
export function Board({ data }: { data: BoardData }) {
  const snapshot = useSyncExternalStore(data.subscribe, data.snapshot);
  const [filter, setFilter] = useState('');
  const [openKey, setOpenKey] = useState(() => taskParam(location.search));
  // The task key whose card takes focus after close when the task view returned it nowhere.
  const closed = useRef<string | null>(null);
  useEffect(() => {
    const onPop = () => {
      setOpenKey(taskParam(location.search));
    };
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('popstate', onPop);
    };
  }, []);
  useEffect(() => {
    data.open(openKey);
  }, [data, openKey]);
  const { task } = snapshot;
  // Runs after the task view's layer returned focus to its opener on unmount.
  useEffect(() => {
    const key = closed.current;
    if (task !== undefined || key === null) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const href = openHref(key);
    [...document.querySelectorAll<HTMLElement>('main a[href]')]
      .find((link) => link.getAttribute('href') === href)
      ?.focus();
  }, [task]);
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
          view={view}
          filter={filter}
          stale={list[0]?.variant === 'error'}
          onOpen={(key) => {
            history.pushState(null, '', openHref(key));
            setOpenKey(key);
          }}
        />
      </main>
      {task !== undefined && (
        <TaskView
          key={task.key}
          task={task}
          title={taskTitle(snapshot, task)}
          columns={project?.columns.map(({ id }) => id) ?? []}
          now={data.now()}
          offline={snapshot.stream === 'offline'}
          onClose={() => {
            closed.current = task.value?.task.key ?? task.key;
            history.pushState(null, '', withoutOpen());
            setOpenKey(null);
          }}
          onRetry={() => {
            data.retryTask();
          }}
        />
      )}
    </>
  );
}
