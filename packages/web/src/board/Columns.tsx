import { useId, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  focusRing,
  Icon,
  Popover,
  quiet,
  Skeleton,
  Tabs,
  TextToggle,
} from '../ds/index.ts';
import { age } from './card.ts';
import {
  actorIcon,
  ColumnHelp,
  describedColumn,
  noLiveSession,
  useHelpScope,
  type HelpTab,
} from './ColumnHelp.tsx';
import type { ColumnsState } from './columns-data.ts';
import {
  boardLayout,
  matchesFilter,
  openHref,
  PART_SOURCE,
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

/** The stored fold of each column group of the shown project, read once and written on each click. */
export interface ColumnFolds {
  get: (group: string) => boolean;
  set: (group: string, folded: boolean) => void;
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

const HELP_TABS = [
  { value: 'who', label: 'Who' },
  { value: 'rules', label: 'Rules' },
];

/** A column's order, read once from `sorts` and stored on each change. */
function useSort(id: string, sorts: ColumnSorts) {
  const [sort, setSort] = useState(() => sorts.get(id));
  const change = (next: ColumnSort) => {
    sorts.set(id, next);
    setSort(next);
  };
  return [sort, change] as const;
}

const cards = (rows: readonly BoardRow[], shared: Shared) =>
  rows.map((row) => (
    <Card
      key={row.key}
      row={row}
      filter={shared.filter}
      now={shared.now}
      spurUiOrigin={shared.spurUiOrigin}
      ticketBrowseBase={shared.ticketBrowseBase}
      onOpen={shared.onOpen}
    />
  ));

/**
 * A column head: label, count, then the executor and the sort buttons. A group part's label is an
 * `h3` under the band's `h2`, and its second line names where its tasks come from. That line is
 * the trigger of the column help panel, which sits right after the head and follows it. Focus
 * moving anywhere outside the head and its panel closes the panel: a keyboard user tabbing to
 * the Inbox button or to another column's trigger leaves no panel open behind them, so at most
 * one panel is open and none stays over the Inbox.
 */
function ColumnHead({
  column,
  part,
  sort,
  onSort,
  columns,
  spurUiOrigin,
  onHelpOpen,
}: {
  column: BoardColumn;
  part: boolean;
  sort: ColumnSort;
  onSort: (sort: ColumnSort) => void;
  columns: ColumnsState | undefined;
  spurUiOrigin: string | null;
  onHelpOpen: () => void;
}) {
  const Label = part ? 'h3' : 'h2';
  const head = useRef<HTMLDivElement>(null);
  const actor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const scope = useHelpScope(open, setOpen);
  const [tab, setTab] = useState<HelpTab>('who');
  const tabsId = useId();
  const warn = noLiveSession(describedColumn(columns, column.id)?.column, part);
  const title = `How ${column.id} works: who acts and the rules`;
  return (
    <div ref={scope} className={styles.helpScope}>
      <div ref={head} className={classes(styles.head, quiet)}>
        <div className={styles.name}>
          <Label className={classes(styles.label, part ? styles.partLabel : undefined)}>
            {column.id}
          </Label>
          <span className={styles.count}>{column.rows.length}</span>
        </div>
        <div className={styles.exec}>
          <button
            ref={actor}
            type="button"
            className={classes(styles.actor, focusRing)}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={warn ? `${title} · no live session` : title}
            data-warn={warn ? '' : undefined}
            onClick={() => {
              if (open) {
                setOpen(false);
                return;
              }
              setTab('who');
              setOpen(true);
              onHelpOpen();
            }}
          >
            <Icon name={actorIcon(column.kind, part)} />
            <span className={styles.execText}>{part ? PART_SOURCE : column.executor}</span>
            {warn && <span className={styles.execWarn}> · no live session</span>}
          </button>
          {column.rows.length > 0 && <SortControl id={column.id} sort={sort} onChange={onSort} />}
        </div>
      </div>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchor={head}
        trigger={actor}
        title={column.id}
        actions={
          <Tabs
            id={tabsId}
            label="Column help"
            tabs={HELP_TABS}
            value={tab}
            onChange={(value) => {
              setTab(value === 'rules' ? 'rules' : 'who');
            }}
          />
        }
      >
        <ColumnHelp
          column={column}
          part={part}
          tab={tab}
          tabsId={tabsId}
          columns={columns}
          spurUiOrigin={spurUiOrigin}
        />
      </Popover>
    </div>
  );
}

function Column({
  column,
  part = false,
  ...shared
}: { column: BoardColumn; part?: boolean } & Shared) {
  const [sort, setSort] = useSort(column.id, shared.sorts);
  const { filter, stale, now, onOpen } = shared;
  if (column.rows.length === 0) {
    const Name = part ? 'h3' : 'h2';
    return (
      <section
        className={classes(styles.spine, quiet)}
        data-stale={stale ? '' : undefined}
        title={`${column.id}: empty · ${part ? PART_SOURCE : column.executor}`}
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
        spurUiOrigin={shared.spurUiOrigin}
        onHelpOpen={shared.onHelpOpen}
      />
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
        <div className={styles.body}>{cards(rows, shared)}</div>
      )}
    </section>
  );
}

/** One part of a folded group: its head, then its cards or the word empty. */
function GroupSection({ column, ...shared }: { column: BoardColumn } & Shared) {
  const [sort, setSort] = useSort(column.id, shared.sorts);
  return (
    <section className={styles.groupSection} data-stale={shared.stale ? '' : undefined}>
      <ColumnHead
        column={column}
        part
        sort={sort}
        onSort={setSort}
        columns={shared.columns}
        spurUiOrigin={shared.spurUiOrigin}
        onHelpOpen={shared.onHelpOpen}
      />
      {column.rows.length === 0 ? (
        <p className={classes(styles.groupEmpty, quiet)}>empty</p>
      ) : (
        <div className={styles.groupCards}>{cards(sortRows(column.rows, sort), shared)}</div>
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
  ...shared
}: { id: string; label: string; parts: readonly BoardColumn[]; folds: ColumnFolds } & Shared) {
  const [folded, setFolded] = useState(() => folds.get(id));
  const titleId = useId();
  const total = parts.reduce((sum, part) => sum + part.rows.length, 0);
  return (
    <section
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
        <span className={styles.count}>{total}</span>
      </div>
      {folded ? (
        <div className={styles.stack}>
          {parts.map((part) => (
            <GroupSection key={part.id} column={part} {...shared} />
          ))}
        </div>
      ) : (
        <div className={styles.parts}>
          {parts.map((part) => (
            <Column key={part.id} column={part} part {...shared} />
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
