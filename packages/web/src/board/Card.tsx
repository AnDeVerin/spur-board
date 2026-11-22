import {
  Fragment,
  useEffect,
  useId,
  useRef,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Chip,
  focusRing,
  HoverMenu,
  Icon,
  quiet,
  StatusDot,
  type HoverMenuItem,
} from '../ds/index.ts';
import { age, markers, prStatus, quickLinks, turnView, type PrStatus } from './card.ts';
import {
  matchesFilter,
  openHref,
  shortKey,
  type BoardColumnConfig,
  type BoardRow,
} from './model.ts';
import styles from './Card.module.css';

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * A plain left click, or Enter, opens the task in place; modified clicks keep the browser's new
 * tab. The card takes focus first, since Safari and Firefox do not focus a clicked link, so the
 * task view returns focus to it.
 */
export function open(
  event: MouseEvent<HTMLAnchorElement>,
  key: string,
  onOpen: (key: string) => void,
) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  event.currentTarget.focus();
  onOpen(key);
}

/** `+N` beside the cells: the other linked PRs. */
function WithMore({ status, id, children }: { status: PrStatus; id: string; children: ReactNode }) {
  if ((status.kind !== 'cells' && status.kind !== 'unobserved') || status.more === null)
    return children;
  return (
    <div className={styles.prRow}>
      {children}
      <span id={`${id}-more`} className={styles.more} title={status.more.title}>
        +{status.more.count}
      </span>
    </div>
  );
}

/** PR status: four cells of the first linked PR, the not-observed cells, or `no PR yet`. */
function PrArea({ status, id }: { status: PrStatus; id: string }) {
  switch (status.kind) {
    case 'none':
      return null;
    case 'placeholder':
      return (
        <div id={`${id}-pr`} className={styles.placeholder}>
          no PR yet
        </div>
      );
    case 'unobserved':
      return (
        <WithMore status={status} id={id}>
          <div
            id={`${id}-pr`}
            className={styles.cells}
            role="group"
            aria-label="PR status: not observed yet"
            title="The pull request is linked but not observed yet"
          >
            {[0, 1, 2, 3].map((cell) => (
              <span key={cell} className={styles.cell} aria-hidden="true">
                —
              </span>
            ))}
          </div>
        </WithMore>
      );
    case 'cells':
      return (
        <WithMore status={status} id={id}>
          <div
            className={styles.cells}
            role="group"
            aria-label="PR status"
            title={
              status.unconfirmed ? 'Not confirmed: the GitHub source is stale or blind' : undefined
            }
          >
            {status.cells.map((cell, index) => (
              <span
                // The four cells are fixed: checks, merge, threads, reviews.
                key={index}
                id={`${id}-cell${String(index)}`}
                className={styles.cell}
                data-tone={cell.tone}
                role="img"
                aria-label={cell.label}
                title={cell.title}
              >
                {cell.icons.map((icon) => (
                  <Icon key={icon} name={icon} />
                ))}
                {cell.text}
                {cell.suffix !== undefined && <span className={styles.suffix}>{cell.suffix}</span>}
              </span>
            ))}
          </div>
        </WithMore>
      );
  }
}

/** Ids the card link's description reads: the PR cells, `+N`, the markers and the turn. */
function describedBy(status: PrStatus, id: string, hasMarkers: boolean, hasTurn: boolean) {
  const ids: string[] = [];
  if (status.kind === 'placeholder' || status.kind === 'unobserved') ids.push(`${id}-pr`);
  if (status.kind === 'cells')
    ids.push(...status.cells.map((_, index) => `${id}-cell${String(index)}`));
  if ((status.kind === 'cells' || status.kind === 'unobserved') && status.more !== null)
    ids.push(`${id}-more`);
  if (hasMarkers) ids.push(`${id}-markers`);
  if (hasTurn) ids.push(`${id}-turn`);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** A card menu item: `top` and `bottom` of the manual order, or another Backlog part. */
export type CardMove = 'top' | 'bottom' | BoardColumnConfig['id'];
/**
 * A card's menu: Move to top and Move to bottom in Manual, then `Move to <part>…` for each other
 * part of a Backlog band.
 */
export interface CardMoves {
  items: readonly HoverMenuItem<CardMove>[];
  onSelect: (move: CardMove) => void;
}
/** A card's drag: its link is the drag source; the board marks the card while it moves. */
export interface CardDrag {
  /** May cancel the drag, as a Time or Key card outside a band does. */
  onStart: (event: DragEvent<HTMLAnchorElement>) => void;
  onEnd: () => void;
  dragging: boolean;
}
/** A card in a column shown in Manual order: the grip, its keys and its reorder state. */
export interface CardOrder {
  /** Who moved it elsewhere, while its tint lasts. */
  moved: string | undefined;
  /** This tab's reorder of the card waits for the Board to show it. */
  pending: boolean;
  /** `Alt+ArrowUp` (-1) or `Alt+ArrowDown` (1) on the card link. */
  onStep: (step: -1 | 1) => void;
  /** Present when the card link should take focus: called once it has. */
  focused: (() => void) | undefined;
}

/**
 * A task card: a link to `?open=<key>` holding the key, title, PR status, markers and turn line,
 * with the ticket, PR and Spur session links beside it, outside the card link. Dimmed, never
 * removed, when the filter misses. A card with `moves` adds its `⋯` menu as the last quick link;
 * `drag` drags it by its link; `order` adds the grip, the `Alt+Arrow` keys and the moved note of a
 * Manual column; `children` (an open move form) renders last in the wrapper, outside the link.
 */
export function Card({
  row,
  filter,
  now,
  spurUiOrigin,
  ticketBrowseBase,
  onOpen,
  moves,
  drag,
  order,
  children,
}: {
  row: BoardRow;
  filter: string;
  now: number | undefined;
  spurUiOrigin: string | null;
  /** `config.get` `projects[].ticketBrowseBase` of the card's project. */
  ticketBrowseBase: string | null;
  /** Asks the board to open the task. */
  onOpen: (key: string) => void;
  moves?: CardMoves | undefined;
  drag?: CardDrag | undefined;
  order?: CardOrder | undefined;
  children?: ReactNode;
}) {
  const id = useId();
  const link = useRef<HTMLAnchorElement>(null);
  const focused = order?.focused;
  useEffect(() => {
    if (!focused) return;
    link.current?.focus();
    focused();
  }, [focused]);
  const title = row.ticket?.title;
  const turn = turnView(row.turn, now);
  const status = prStatus(row);
  const marks = markers(row, spurUiOrigin);
  const links = quickLinks(row, spurUiOrigin, ticketBrowseBase);
  return (
    <div
      className={classes(styles.wrap, quiet)}
      data-dimmed={matchesFilter(row, filter) ? undefined : ''}
      data-turn={turn?.kind ?? 'none'}
      data-dragging={drag?.dragging === true ? '' : undefined}
      data-key={row.key}
      data-manual={order ? '' : undefined}
      data-moved={order?.moved === undefined ? undefined : ''}
      data-pending={order?.pending === true ? '' : undefined}
    >
      <a
        ref={link}
        className={classes(styles.card, focusRing)}
        href={openHref(row.key)}
        title={row.key}
        aria-label={title === undefined ? row.key : `${row.key} ${title}`}
        aria-describedby={describedBy(status, id, marks.length > 0, turn !== null)}
        onClick={(event) => {
          open(event, row.key, onOpen);
        }}
        onDragStart={drag?.onStart}
        onDragEnd={drag?.onEnd}
        onKeyDown={(event) => {
          if (!order || !event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          order.onStep(event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        <div className={styles.keyRow}>
          {order && (
            <span className={styles.grip}>
              <Icon name="grip" />
            </span>
          )}
          <span className={styles.key}>{shortKey(row.key)}</span>
          {row.columnEnteredAt !== null && (
            <span className={styles.entered} title="Time in this column">
              {age(row.columnEnteredAt, now)}
            </span>
          )}
          {order?.moved !== undefined && <span className={styles.moved}>{order.moved}</span>}
          {(links.length > 0 || moves) && (
            // Room for the quick links and the menu, which sit over the card's top right corner.
            <span className={styles.spacer} aria-hidden="true">
              {links.map(({ kind }) => (
                <span key={kind} className={styles.slot} />
              ))}
              {moves && <span className={styles.slot} />}
            </span>
          )}
        </div>
        {title !== undefined && <div className={styles.title}>{title}</div>}
        <PrArea status={status} id={id} />
        {marks.length > 0 && (
          <div id={`${id}-markers`} className={styles.markers}>
            {marks.map((marker, index) => (
              // A space between chips keeps the words apart in the description; flex drops it.
              <Fragment key={marker.text}>
                {index > 0 && ' '}
                <Chip tone={marker.tone} title={marker.title} wrap={marker.wrap}>
                  {marker.icon && <Icon name={marker.icon} />}
                  {marker.text}
                </Chip>
              </Fragment>
            ))}
          </div>
        )}
        {turn && (
          <div id={`${id}-turn`} className={styles.turn} data-waiting={turn.waiting}>
            <StatusDot tone={turn.tone} hollow={turn.hollow} />
            <span className={styles.who}>
              {turn.id}{' '}
              {turn.kind === 'you' ? (
                <b>your turn</b>
              ) : (
                <>
                  {turn.role} <b>{turn.name}</b>
                </>
              )}
            </span>{' '}
            <span className={styles.age} data-kind={turn.kind} title={turn.label}>
              {turn.waiting ? (
                // The visible line is hidden from assistive technology, which reads the full label.
                <>
                  <Icon name="clock" />
                  <span className={styles.wake} aria-hidden="true">
                    {turn.wake}
                    {turn.reason !== undefined && ' ·'}
                  </span>
                  {turn.reason !== undefined && (
                    <span className={styles.reason} aria-hidden="true">
                      {turn.reason}
                    </span>
                  )}
                  <span className={styles.hidden}>{turn.label}</span>
                </>
              ) : (
                turn.tail
              )}
            </span>
          </div>
        )}
      </a>
      {(links.length > 0 || moves) && (
        <span className={styles.links}>
          {links.map((link) => (
            <a
              key={link.kind}
              className={classes(styles.link, focusRing)}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.label}
              title={link.title}
            >
              <Icon name={link.icon} />
            </a>
          ))}
          {moves && (
            <span className={styles.slot}>
              <HoverMenu
                label={`Move ${shortKey(row.key)}`}
                text="⋯"
                variant="action"
                opens="down"
                items={moves.items}
                onSelect={moves.onSelect}
              />
            </span>
          )}
        </span>
      )}
      {children}
    </div>
  );
}
