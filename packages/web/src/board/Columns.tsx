import type { MouseEvent, ReactNode } from 'react';
import { focusRing, Icon, quiet, Skeleton } from '../ds/index.ts';
import { matchesFilter, openHref, shortKey, type BoardColumn, type BoardRow } from './model.ts';
import styles from './Columns.module.css';

/** What the board area shows; a first-load failure shows nothing here, only its banner. */
export type ColumnsView =
  | { kind: 'failed' }
  /** Skeleton columns: the chosen project's column ids, or unnamed ones before config. */
  | { kind: 'loading'; names: readonly (string | undefined)[] }
  | { kind: 'empty'; project: string }
  | { kind: 'columns'; columns: readonly BoardColumn[] };

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

/** A plain left click opens the task in place; modified clicks keep the browser's new tab. */
function open(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  history.pushState(null, '', event.currentTarget.getAttribute('href'));
}

/** A card or done row: a link to `?open=<key>`, dimmed, never removed, when the filter misses. */
function TaskLink({
  row,
  filter,
  className,
  children,
}: {
  row: BoardRow;
  filter: string;
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
      onClick={open}
    >
      {children}
    </a>
  );
}

function Column({
  column,
  filter,
  stale,
}: {
  column: BoardColumn;
  filter: string;
  stale: boolean;
}) {
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
  const head = (
    <div className={classes(styles.head, quiet)}>
      <div className={styles.name}>
        <h2 className={styles.label}>{column.id}</h2>
        <span className={styles.count}>{column.rows.length}</span>
      </div>
      <div className={styles.exec}>{column.executor}</div>
    </div>
  );
  if (column.id === 'done')
    return (
      <section className={styles.column} data-stale={stale ? '' : undefined}>
        {head}
        <ul className={classes(styles.body, styles.done, quiet)}>
          {column.rows.map((row) => (
            <li key={row.key}>
              <TaskLink row={row} filter={filter} className={styles.doneRow}>
                <span className={styles.check}>
                  <Icon name="check" />
                </span>
                <b className={styles.doneKey}>{shortKey(row.key)}</b>
                {row.ticket && <span className={styles.doneTitle}>{row.ticket.title}</span>}
              </TaskLink>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <section className={styles.column} data-stale={stale ? '' : undefined}>
      {head}
      <div className={styles.body}>
        {column.rows.map((row) => (
          <TaskLink key={row.key} row={row} filter={filter} className={styles.card}>
            <span className={styles.key}>{shortKey(row.key)}</span>
            {row.ticket && <span className={styles.title}>{row.ticket.title}</span>}
          </TaskLink>
        ))}
      </div>
    </section>
  );
}

/** The board area inside `main`: skeleton columns, the empty message, or the columns. */
export function Columns({
  view,
  filter,
  stale,
}: {
  view: ColumnsView;
  filter: string;
  stale: boolean;
}) {
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
      return view.columns.map((column) => (
        <Column key={column.id} column={column} filter={filter} stale={stale} />
      ));
  }
}
