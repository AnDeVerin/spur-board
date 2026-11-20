import { useId, useRef, useState } from 'react';
import { Banner, focusRing, Icon, Popover, quiet, Tabs } from '../ds/index.ts';
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
 * A column head: label, count, then the executor and the sort buttons. A group part's label is an
 * `h3` under the band's `h2`, and its second line names where its tasks come from. That line is
 * the trigger of the column help panel, which sits right after the head and follows it. Focus
 * moving anywhere outside the head and its panel closes the panel: a keyboard user tabbing to
 * the Inbox button or to another column's trigger leaves no panel open behind them, so at most
 * one panel is open and none stays over the Inbox.
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
}: {
  column: BoardColumn;
  part: boolean;
  sort: ColumnSort;
  onSort: (sort: ColumnSort) => void;
  columns: ColumnsState | undefined;
  now: number | undefined;
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
            title={title}
            data-warn={warn === undefined ? undefined : ''}
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
            <Icon name={actorIcon(column.kind, part, column.source)} />
            <span className={styles.execText}>{part ? partSource(column) : column.executor}</span>
            {warn !== undefined && <span className={styles.execWarn}>{warn}</span>}
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
          now={now}
          spurUiOrigin={spurUiOrigin}
        />
      </Popover>
    </div>
  );
}
