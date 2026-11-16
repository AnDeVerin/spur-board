import { useState, useSyncExternalStore } from 'react';
import { Banner, Button } from '../ds/index.ts';
import type { BoardData, BoardSnapshot } from './data.ts';
import { banners, boardColumns, chosenProject, indicator } from './model.ts';
import { Columns, type ColumnsView } from './Columns.tsx';
import { Header } from './Header.tsx';
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

/** The board screen: header, banners and the columns of the chosen project. */
export function Board({ data }: { data: BoardData }) {
  const snapshot = useSyncExternalStore(data.subscribe, data.snapshot);
  const [filter, setFilter] = useState('');
  const list = banners(snapshot);
  const view = columnsView(snapshot);
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
          now={snapshot.lastGoodAt}
          spurUiOrigin={snapshot.config?.web.spurUiOrigin ?? null}
        />
      </main>
    </>
  );
}
