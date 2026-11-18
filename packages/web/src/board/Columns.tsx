import { useId, useState, type ReactNode } from 'react';
import { Button, focusRing, Icon, quiet, Skeleton } from '../ds/index.ts';
import { age } from './card.ts';
import {
  matchesFilter,
  openHref,
  shortKey,
  sortRows,
  type BoardColumn,
  type BoardRow,
  type ColumnSort,
} from './model.ts';
import { Card, open } from './Card.tsx';
import styles from './Columns.module.css';

/** What the board area shows; a first-load failure shows nothing here, only its banner. */
export type ColumnsView =
  | { kind: 'failed' }
  /** Skeleton columns: the chosen project's column ids, or unnamed ones before config. */
  | { kind: 'loading'; names: readonly (string | undefined)[] }
  | { kind: 'empty'; project: string }
  | { kind: 'columns'; columns: readonly BoardColumn[]; unknown: readonly BoardRow[] };

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

/** The stored order of each column of the shown project, read once and written on each click. */
export interface ColumnSorts {
  get: (column: string) => ColumnSort;
  set: (column: string, sort: ColumnSort) => void;
}

const SORT_HINT: Record<ColumnSort, string> = {
  'entered-asc': 'Longest in the column first',
  'entered-desc': 'Newest in the column first',
  'key-asc': 'Lowest key first',
  'key-desc': 'Highest key first',
};

/** Two quiet buttons in a column head: the field, T time in the column or K key, and the direction. */
function SortControl({
  id,
  sort,
  onChange,
}: {
  id: string;
  sort: ColumnSort;
  onChange: (sort: ColumnSort) => void;
}) {
  const byKey = sort.startsWith('key');
  const asc = sort.endsWith('-asc');
  const direction = asc ? 'asc' : 'desc';
  return (
    <div role="group" aria-label={`Sort ${id}`} className={styles.sort}>
      <button
        type="button"
        className={classes(styles.sortButton, focusRing)}
        aria-label={byKey ? 'Sorted by key' : 'Sorted by time in the column'}
        title={
          byKey
            ? 'K: sorted by key. Click for T, time in the column.'
            : 'T: sorted by time in the column. Click for K, key.'
        }
        onClick={() => {
          onChange(byKey ? `entered-${direction}` : `key-${direction}`);
        }}
      >
        {byKey ? 'K' : 'T'}
      </button>
      <button
        type="button"
        className={classes(styles.sortButton, focusRing)}
        aria-label={SORT_HINT[sort]}
        title={`${SORT_HINT[sort]}. Click to reverse.`}
        onClick={() => {
          onChange(`${byKey ? 'key' : 'entered'}-${asc ? 'desc' : 'asc'}`);
        }}
      >
        {asc ? '↑' : '↓'}
      </button>
    </div>
  );
}

/** A done row: a link to `?open=<key>`, dimmed, never removed, when the filter misses. */
function TaskLink({
  row,
  filter,
  onOpen,
  className,
  children,
}: {
  row: BoardRow;
  filter: string;
  onOpen: (key: string) => void;
  className: string | undefined;
  children: ReactNode;
}) {
  const title = row.ticket?.title;
  return (
    <a
      className={classes(className, quiet, focusRing)}
      href={openHref(row.key)}
      title={row.key}
      aria-label={title === undefined ? row.key : `${row.key} ${title}`}
      data-dimmed={matchesFilter(row, filter) ? undefined : ''}
      onClick={(event) => {
        open(event, row.key, onOpen);
      }}
    >
      {children}
    </a>
  );
}

function Column({
  column,
  sorts,
  filter,
  stale,
  now,
  spurUiOrigin,
  ticketBrowseBase,
  onOpen,
}: {
  column: BoardColumn;
  sorts: ColumnSorts;
  filter: string;
  stale: boolean;
  now: number | undefined;
  spurUiOrigin: string | null;
  ticketBrowseBase: string | null;
  onOpen: (key: string) => void;
}) {
  const [sort, setSort] = useState(() => sorts.get(column.id));
  if (column.rows.length === 0)
    return (
      <section
        className={classes(styles.spine, quiet)}
        data-stale={stale ? '' : undefined}
        title={`${column.id}: empty · ${column.executor}`}
      >
        <span className={styles.count}>0</span>
        <h2 className={classes(styles.label, styles.spineName)}>{column.id}</h2>
      </section>
    );
  const rows = sortRows(column.rows, sort);
  return (
    <section className={styles.column} data-stale={stale ? '' : undefined}>
      <div className={classes(styles.head, quiet)}>
        <div className={styles.name}>
          <h2 className={styles.label}>{column.id}</h2>
          <span className={styles.count}>{column.rows.length}</span>
        </div>
        <div className={styles.exec}>
          <span className={styles.execText}>{column.executor}</span>
          <SortControl
            id={column.id}
            sort={sort}
            onChange={(next) => {
              sorts.set(column.id, next);
              setSort(next);
            }}
          />
        </div>
      </div>
      {column.id === 'done' ? (
        <ul className={classes(styles.body, styles.done, quiet)}>
          {rows.map((row) => (
            <li key={row.key}>
              <TaskLink row={row} filter={filter} onOpen={onOpen} className={styles.doneRow}>
                <span className={styles.check}>
                  <Icon name="check" />
                </span>
                <b className={styles.doneKey}>{shortKey(row.key)}</b>
                {row.ticket && <span className={styles.doneTitle}>{row.ticket.title}</span>}
                {row.columnEnteredAt !== null && (
                  <span className={styles.entered}>{age(row.columnEnteredAt, now)}</span>
                )}
              </TaskLink>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.body}>
          {rows.map((row) => (
            <Card
              key={row.key}
              row={row}
              filter={filter}
              now={now}
              spurUiOrigin={spurUiOrigin}
              ticketBrowseBase={ticketBrowseBase}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The board area inside `main`: skeleton columns, the empty message, or the columns. Ages count
 * to `now`, the time of the last good read; session links start at `spurUiOrigin`.
 */
export function Columns({
  view,
  sorts,
  filter,
  stale,
  now,
  spurUiOrigin,
  ticketBrowseBase,
  onOpen,
}: {
  view: ColumnsView;
  /** Each column's order; a click reorders that column only. */
  sorts: ColumnSorts;
  filter: string;
  stale: boolean;
  now: number | undefined;
  spurUiOrigin: string | null;
  /** `config.get` `projects[].ticketBrowseBase`: Jira ticket links start there. */
  ticketBrowseBase: string | null;
  /** A card asks to open its task. */
  onOpen: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  switch (view.kind) {
    case 'failed':
      return null;
    case 'loading':
      return view.names.map((name, index) => (
        // A skeleton column has no identity besides its position.
        <section key={index} className={styles.column} data-skeleton="">
          <div className={styles.head}>
            <div className={styles.name}>
              <span className={styles.label}>{name ?? ' '}</span>
            </div>
            <div className={styles.exec}>{' '}</div>
          </div>
          <div className={styles.body}>
            {Array.from({ length: 3 - (index % 2) }, (_, card) => (
              <Skeleton key={card} />
            ))}
          </div>
        </section>
      ));
    case 'empty':
      return (
        <div className={styles.blank}>
          <p className={styles.blankTitle}>No tasks in {view.project} yet</p>
          <p className={styles.blankText}>
            A task appears here when the board sees a ticket for this project. Columns show up with
            the first task.
          </p>
        </div>
      );
    case 'columns':
      return (
        <>
          {view.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              sorts={sorts}
              filter={filter}
              stale={stale}
              now={now}
              spurUiOrigin={spurUiOrigin}
              ticketBrowseBase={ticketBrowseBase}
              onOpen={onOpen}
            />
          ))}
          {view.unknown.length > 0 && (
            <div className={classes(styles.unknown, quiet)} data-stale={stale ? '' : undefined}>
              <Button
                expanded={expanded}
                controls={listId}
                onClick={() => {
                  setExpanded(!expanded);
                }}
              >
                <span className={styles.unknownLabel}>
                  {view.unknown.length} {view.unknown.length === 1 ? 'task' : 'tasks'} in unknown
                  columns
                </span>
              </Button>
              <ul id={listId} hidden={!expanded} className={styles.unknownList}>
                {view.unknown.map((row) => (
                  <li key={row.key}>
                    <TaskLink
                      row={row}
                      filter={filter}
                      onOpen={onOpen}
                      className={styles.unknownRow}
                    >
                      <b className={styles.doneKey}>{shortKey(row.key)}</b>
                      {row.ticket && <span>{row.ticket.title}</span>}
                      <span className={styles.unknownLabel}>{row.column}</span>
                    </TaskLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
  }
}
