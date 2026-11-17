import { Fragment, useId, type MouseEvent, type ReactNode } from 'react';
import { Chip, focusRing, Icon, quiet, StatusDot } from '../ds/index.ts';
import { markers, prStatus, quickLinks, turnView, type PrStatus } from './card.ts';
import { matchesFilter, openHref, shortKey, type BoardRow } from './model.ts';
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
              >
                {cell.icons.map((icon) => (
                  <Icon key={icon} name={icon} />
                ))}
                {cell.text}
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

/**
 * A task card: a link to `?open=<key>` holding the key, title, PR status, markers and turn line,
 * with the ticket, PR and Spur session links beside it, outside the card link. Dimmed, never
 * removed, when the filter misses.
 */
export function Card({
  row,
  filter,
  now,
  spurUiOrigin,
  onOpen,
}: {
  row: BoardRow;
  filter: string;
  now: number | undefined;
  spurUiOrigin: string | null;
  /** Asks the board to open the task. */
  onOpen: (key: string) => void;
}) {
  const id = useId();
  const title = row.ticket?.title;
  const turn = turnView(row.turn, now);
  const status = prStatus(row);
  const marks = markers(row, spurUiOrigin);
  const links = quickLinks(row, spurUiOrigin);
  return (
    <div
      className={classes(styles.wrap, quiet)}
      data-dimmed={matchesFilter(row, filter) ? undefined : ''}
      data-turn={turn?.kind ?? 'none'}
    >
      <a
        className={classes(styles.card, focusRing)}
        href={openHref(row.key)}
        title={row.key}
        aria-label={title === undefined ? row.key : `${row.key} ${title}`}
        aria-describedby={describedBy(status, id, marks.length > 0, turn !== null)}
        onClick={(event) => {
          open(event, row.key, onOpen);
        }}
      >
        <div className={styles.keyRow}>
          <span className={styles.key}>{shortKey(row.key)}</span>
          {links.length > 0 && (
            // Room for the quick links, which sit over the card's top right corner.
            <span className={styles.spacer} aria-hidden="true">
              {links.map(({ kind }) => (
                <span key={kind} className={styles.slot} />
              ))}
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
                <Chip tone={marker.tone} title={marker.title}>
                  {marker.icon && <Icon name={marker.icon} />}
                  {marker.text}
                </Chip>
              </Fragment>
            ))}
          </div>
        )}
        {turn && (
          <div id={`${id}-turn`} className={styles.turn}>
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
            <span className={styles.age} data-kind={turn.kind}>
              {turn.tail}
            </span>
          </div>
        )}
      </a>
      {links.length > 0 && (
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
        </span>
      )}
    </div>
  );
}
