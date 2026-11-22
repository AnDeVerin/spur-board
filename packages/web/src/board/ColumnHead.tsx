import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { Banner, focusRing, Icon, Popover, quiet, Tabs } from '../ds/index.ts';
import {
  actorIcon,
  ColumnHelp,
  describedColumn,
  noLiveSession,
  useHelpScope,
  type HelpRequest,
  type HelpTab,
  type OldestTurn,
} from './ColumnHelp.tsx';
import type { ColumnsState } from './columns-data.ts';
import {
  frozenDetail,
  mirrorFrozen,
  partSource,
  type BoardColumn,
  type ColumnSort,
} from './model.ts';
import { SortControl } from './SortControl.tsx';
import styles from './Columns.module.css';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

const HELP_TABS = [
  { value: 'who', label: 'Who' },
  { value: 'rules', label: 'Rules' },
];

/** The warning under a frozen mirrored part's head, above its cards; nothing for any other. */
export function MirrorNotice({ column }: { column: BoardColumn }) {
  const mirror = mirrorFrozen(column);
  if (mirror === undefined) return null;
  return (
    <div className={styles.notice}>
      <Banner variant="warning" icon="pulse" detail={frozenDetail(mirror, column)}>
        Mirror not readable: frozen
      </Banner>
    </div>
  );
}

/**
 * The one header surface open on the board: a column help panel or a column's sort menu, keyed by
 * the head's instance id, so a head that remounts matches nothing and opens neither by itself.
 */
export type HeadSurface = { owner: string; kind: 'help' | 'sort' } | null;

/**
 * A column head: label, count, then the executor and the sort buttons. A group part's label is an
 * `h3` under the band's `h2`, and its second line names where its tasks come from. That line is
 * the trigger of the column help panel, which sits right after the head and follows it. Focus
 * moving anywhere outside the head and its panel closes the panel: a keyboard user tabbing to
 * the Inbox button or to another column's trigger leaves no panel open behind them, so at most
 * one panel is open and none stays over the Inbox. A `helpRequest` for this column, from an inbox
 * row, opens the panel on Who as the trigger would, scrolls the head into view and links the
 * request's oldest waiting turn; `onHelpTaken` then clears the request.
 *
 * `surface` holds the one help panel or sort menu open on the board: opening either, by any
 * trigger, hover included, closes the other, and a close clears only its own surface. Help sits at
 * the panel layer, under the sort menu. When another surface closes this help while focus was
 * inside its panel and that focus is lost, focus moves to the trigger; a menu opened by click or
 * key then moves it on to its checked item.
 */
export function ColumnHead({
  column,
  part,
  sort,
  onSort,
  columns,
  now,
  spurUiOrigin,
  onHelpOpen,
  helpRequest,
  onHelpTaken,
  onOpen,
  surface,
  setSurface,
}: {
  column: BoardColumn;
  part: boolean;
  sort: ColumnSort;
  onSort: (sort: ColumnSort) => void;
  columns: ColumnsState | undefined;
  now: number | undefined;
  spurUiOrigin: string | null;
  onHelpOpen: () => void;
  helpRequest: HelpRequest | null;
  onHelpTaken: () => void;
  onOpen: (key: string) => void;
  surface: HeadSurface;
  setSurface: Dispatch<SetStateAction<HeadSurface>>;
}) {
  const Label = part ? 'h3' : 'h2';
  const head = useRef<HTMLDivElement>(null);
  const actor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = surface?.owner === id && surface.kind === 'help';
  const sortOpen = surface?.owner === id && surface.kind === 'sort';
  // An open takes the slot; a close clears it only while it still holds this surface.
  const change = useCallback(
    (kind: 'help' | 'sort', next: boolean) => {
      setSurface((current) =>
        next
          ? { owner: id, kind }
          : current?.owner === id && current.kind === kind
            ? null
            : current,
      );
    },
    [id, setSurface],
  );
  const setOpen = useCallback(
    (next: boolean) => {
      change('help', next);
    },
    [change],
  );
  const scope = useHelpScope(open, setOpen);
  // Whether the last focus inside the scope was in the panel rather than the head.
  const inPanel = useRef(false);
  const wasOpen = useRef(open);
  // Before the passive effects: a menu opened by click or key moves focus on after this.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      wasOpen.current &&
      !open &&
      surface !== null &&
      inPanel.current &&
      (active === null || active === document.body || !active.isConnected)
    )
      actor.current?.focus({ preventScroll: true });
    wasOpen.current = open;
    if (!open) inPanel.current = false;
  }, [open, surface]);
  const [tab, setTab] = useState<HelpTab>('who');
  const tabsId = useId();
  const [oldest, setOldest] = useState<OldestTurn | undefined>(undefined);
  useEffect(() => {
    if (helpRequest?.column !== column.id) return;
    // The trigger takes focus first, so the panel moves it on to Close as for a click.
    actor.current?.focus({ preventScroll: true });
    head.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setTab('who');
    setOldest({ task: helpRequest.task, turn: helpRequest.turn });
    setOpen(true);
    onHelpOpen();
    onHelpTaken();
  }, [helpRequest, column.id, onHelpOpen, onHelpTaken]);
  const frozen = part ? mirrorFrozen(column) : undefined;
  let title = `How ${column.id} works: who acts and the rules`;
  let warn: string | undefined;
  if (noLiveSession(describedColumn(columns, column.id)?.column, part)) {
    warn = ' · no live session';
    title += warn;
  } else if (frozen !== undefined) {
    warn = ' · frozen';
    title = `Mirror not readable${frozen.error === undefined ? '' : `: ${frozen.error.message}`}. Click for details.`;
  }
  return (
    <div
      ref={scope}
      className={styles.helpScope}
      onFocus={(event) => {
        inPanel.current = !(head.current?.contains(event.target) ?? false);
      }}
    >
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
            title={title}
            data-warn={warn === undefined ? undefined : ''}
            onClick={() => {
              if (open) {
                setOpen(false);
                return;
              }
              setTab('who');
              setOldest(undefined);
              setOpen(true);
              onHelpOpen();
            }}
          >
            <Icon name={actorIcon(column.kind, part, column.source)} />
            <span className={styles.execText}>{part ? partSource(column) : column.executor}</span>
            {warn !== undefined && <span className={styles.execWarn}>{warn}</span>}
          </button>
          {column.rows.length > 0 && (
            <SortControl
              id={column.id}
              sort={sort}
              onChange={onSort}
              open={sortOpen}
              onOpenChange={(next) => {
                change('sort', next);
              }}
            />
          )}
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
        layer="panel"
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
          now={now}
          spurUiOrigin={spurUiOrigin}
          oldest={oldest}
          onOpen={onOpen}
        />
      </Popover>
    </div>
  );
}
