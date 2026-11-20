import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, focusRing, Icon, quiet, Skeleton, StatusDot, TextToggle } from '../ds/index.ts';
import { age } from './card.ts';
import { ColumnHead, MirrorNotice } from './ColumnHead.tsx';
import type { ColumnsState } from './columns-data.ts';
import {
  boardLayout,
  matchesFilter,
  mirrorFrozen,
  openHref,
  partSource,
  shortKey,
  sortRows,
  type BoardColumn,
  type BoardRow,
  type ColumnSort,
} from './model.ts';
import { Card, open } from './Card.tsx';
import type { BoardData } from './data.ts';
import { bandProps, useBand, zone, type Band } from './MoveForm.tsx';
import styles from './Columns.module.css';

type ColumnId = BoardColumn['id'];

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

/** The stored fold of each column group of the shown project, read once and written on each click. */
export interface ColumnFolds {
  get: (group: string) => boolean;
  set: (group: string, folded: boolean) => void;
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

/** What every column, part and folded section of the board reads. */
interface Shared {
  sorts: ColumnSorts;
  filter: string;
  stale: boolean;
  now: number | undefined;
  spurUiOrigin: string | null;
  ticketBrowseBase: string | null;
  onOpen: (key: string) => void;
  /** `columns.describe` of the shown project: column help and the no-live-session warning. */
  columns: ColumnsState | undefined;
  /** A column help panel opened: read `columns.describe` again. */
  onHelpOpen: () => void;
}

/** A column's order, read once from `sorts` and stored on each change. */
function useSort(id: string, sorts: ColumnSorts) {
  const [sort, setSort] = useState(() => sorts.get(id));
  const change = (next: ColumnSort) => {
    sorts.set(id, next);
    setSort(next);
  };
  return [sort, change] as const;
}

/** The first line of a zone while a card hovers over it: the move it takes, or why it refuses. */
function dropNote(band: Band | undefined, part: ColumnId) {
  const refusal = band?.refusal(part);
  if (refusal !== undefined) return <p className={styles.dropNote}>{refusal}</p>;
  return (
    band?.dropping(part) === true && (
      <p className={styles.dropNote}>Drop to move to {part}. A reason is asked.</p>
    )
  );
}

const cards = (rows: readonly BoardRow[], shared: Shared, band?: Band, part?: ColumnId) =>
  rows.map((row) => (
    <Card
      key={row.key}
      row={row}
      filter={shared.filter}
      now={shared.now}
      spurUiOrigin={shared.spurUiOrigin}
      ticketBrowseBase={shared.ticketBrowseBase}
      onOpen={shared.onOpen}
      {...(band && part !== undefined ? bandProps(row, band, part) : {})}
    />
  ));

function Column({
  column,
  part = false,
  band,
  ...shared
}: { column: BoardColumn; part?: boolean; band?: Band | undefined } & Shared) {
  const [sort, setSort] = useSort(column.id, shared.sorts);
  const { filter, stale, now, onOpen } = shared;
  // A frozen part keeps its head and notice even with no tasks.
  if (column.rows.length === 0 && !(part && mirrorFrozen(column))) {
    const Name = part ? 'h3' : 'h2';
    return (
      <section
        className={classes(styles.spine, quiet)}
        data-stale={stale ? '' : undefined}
        title={
          band?.refusal(column.id) ??
          `${column.id}: empty · ${part ? partSource(column) : column.executor}`
        }
        {...zone(band, column.id)}
      >
        <span className={styles.count}>0</span>
        <Name className={classes(styles.label, styles.spineName)}>{column.id}</Name>
      </section>
    );
  }
  const rows = sortRows(column.rows, sort);
  return (
    <section className={styles.column} data-stale={stale ? '' : undefined}>
      <ColumnHead
        column={column}
        part={part}
        sort={sort}
        onSort={setSort}
        columns={shared.columns}
        now={now}
        spurUiOrigin={shared.spurUiOrigin}
        onHelpOpen={shared.onHelpOpen}
      />
      {part && <MirrorNotice column={column} />}
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
        <div className={styles.body} {...zone(band, column.id)}>
          {dropNote(band, column.id)}
          {cards(rows, shared, band, column.id)}
        </div>
      )}
    </section>
  );
}

/** One part of a folded group: its head, then its cards or the word empty. */
function GroupSection({ column, band, ...shared }: { column: BoardColumn; band: Band } & Shared) {
  const [sort, setSort] = useSort(column.id, shared.sorts);
  return (
    <section
      className={styles.groupSection}
      data-stale={shared.stale ? '' : undefined}
      {...zone(band, column.id)}
    >
      <ColumnHead
        column={column}
        part
        sort={sort}
        onSort={setSort}
        columns={shared.columns}
        now={shared.now}
        spurUiOrigin={shared.spurUiOrigin}
        onHelpOpen={shared.onHelpOpen}
      />
      <MirrorNotice column={column} />
      {dropNote(band, column.id)}
      {column.rows.length === 0 ? (
        <p className={classes(styles.groupEmpty, quiet)}>empty</p>
      ) : (
        <div className={styles.groupCards}>
          {cards(sortRows(column.rows, sort), shared, band, column.id)}
        </div>
      )}
    </section>
  );
}

/**
 * A group band over its parts. The band renders outside the fold branch, so a fold keeps the
 * toggle and its focus. Unfolded, each part is a column; folded, one column with a section each.
 */
function ColumnGroup({
  id,
  label,
  parts,
  folds,
  moveIntent,
  moveUnavailable,
  ...shared
}: {
  id: string;
  label: string;
  parts: readonly BoardColumn[];
  folds: ColumnFolds;
  moveIntent: BoardData['moveIntent'];
  moveUnavailable: string | undefined;
} & Shared) {
  const [folded, setFolded] = useState(() => folds.get(id));
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const total = parts.reduce((sum, part) => sum + part.rows.length, 0);
  const band = useBand(parts, root, moveIntent, moveUnavailable);
  const frozen = parts.some((part) => mirrorFrozen(part) !== undefined);
  return (
    <section
      ref={root}
      className={styles.group}
      aria-labelledby={titleId}
      data-folded={folded ? '' : undefined}
    >
      <div className={classes(styles.groupHead, quiet)} data-stale={shared.stale ? '' : undefined}>
        <h2 id={titleId} className={styles.groupTitle}>
          <TextToggle
            caret
            expanded={!folded}
            onClick={() => {
              folds.set(id, !folded);
              setFolded(!folded);
            }}
          >
            <span className={classes(styles.label, styles.groupName)}>{label}</span>
          </TextToggle>
        </h2>
        {frozen && (
          <span className={styles.groupWarn} title="A mirror is not readable">
            <StatusDot tone="warn" />
            <span className={styles.hidden}>mirror frozen</span>
          </span>
        )}
        <span className={styles.count}>{total}</span>
      </div>
      {folded ? (
        <div className={styles.stack}>
          {parts.map((part) => (
            <GroupSection key={part.id} column={part} band={band} {...shared} />
          ))}
        </div>
      ) : (
        <div className={styles.parts}>
          {parts.map((part) => (
            <Column key={part.id} column={part} part band={band} {...shared} />
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
  folds,
  filter,
  stale,
  now,
  spurUiOrigin,
  ticketBrowseBase,
  onOpen,
  moveIntent,
  moveUnavailable,
  columns,
  onHelpOpen,
}: {
  view: ColumnsView;
  /** Each column's order; a click reorders that column only. */
  sorts: ColumnSorts;
  /** Each column group's fold; a click folds or unfolds that group only. */
  folds: ColumnFolds;
  filter: string;
  stale: boolean;
  now: number | undefined;
  spurUiOrigin: string | null;
  /** `config.get` `projects[].ticketBrowseBase`: Jira ticket links start there. */
  ticketBrowseBase: string | null;
  /** A card asks to open its task. */
  onOpen: (key: string) => void;
  /** Moves a task between the parts of the Backlog band. */
  moveIntent: BoardData['moveIntent'];
  /** Why moves cannot be sent now; undefined while they can. */
  moveUnavailable: string | undefined;
  /** `columns.describe` of the shown project. */
  columns: ColumnsState | undefined;
  /** A column help panel opened. */
  onHelpOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const shared = {
    sorts,
    filter,
    stale,
    now,
    spurUiOrigin,
    ticketBrowseBase,
    onOpen,
    columns,
    onHelpOpen,
  };
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
          {boardLayout(view.columns).map((item) =>
            item.kind === 'group' ? (
              <ColumnGroup
                key={`group:${item.id}`}
                id={item.id}
                label={item.label}
                parts={item.parts}
                folds={folds}
                moveIntent={moveIntent}
                moveUnavailable={moveUnavailable}
                {...shared}
              />
            ) : (
              <Column key={item.column.id} column={item.column} {...shared} />
            ),
          )}
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
