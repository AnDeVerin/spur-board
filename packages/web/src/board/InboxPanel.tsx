import { browserOperations } from '@spur-board/contracts/browser';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { focusRing, quiet, SidePanel, StatusDot, TabPanel, Tabs, TextToggle } from '../ds/index.ts';
import { safeExternalUrl } from '../lib/links.ts';
import { ProblemError } from '../lib/api.ts';
import { BoardUnavailableError, type BoardData, type BoardSnapshot } from './data.ts';
import { open } from './Card.tsx';
import { openHref, shortKey } from './model.ts';
import { age } from './task-model.ts';
import styles from './InboxPanel.module.css';

type Inbox = NonNullable<BoardSnapshot['inbox']>;
type Entry = Inbox['items'][number];
type CloseIntent = ReturnType<BoardData['closeItemIntent']>;
/** A Close in flight or confirmed, or the error of the last one; `unavailable` was refused. */
interface CloseState {
  phase: 'idle' | 'sending' | 'confirmed';
  error?: { text: string; unavailable: boolean } | undefined;
}

const closable = (entry: Entry) =>
  browserOperations['item.close'].input.safeParse({ item: entry.id }).success;
/** A column orchestrator with no live session to ring, read from its board observation text. */
interface NoSession {
  column: string;
  expects: string;
  waiting?: number;
  oldestAt?: string;
}
// The wording of core `turnsWithoutSession` (app/fromYou.ts) and `noSessionText`
// (app/operator-inbox.ts). Text that no longer matches falls back to the generic row.
const NO_SESSION = /^(\S+) (\S+): turns wait for a live session of Spur project (.+)$/;
const OLDEST = /^oldest T\d+ since (\S+)$/;
const WAITING = /^(\d+) waiting, no live session for \d+ min$/;

/** The no-session reading of an entry's description (action removed), or undefined. */
function noSession(entry: Entry, description: string): NoSession | undefined {
  if (entry.kind !== 'board_observation') return undefined;
  const [head = '', ...clauses] = description.split('; ');
  const match = NO_SESSION.exec(head);
  if (!match || match[1] !== entry.project) return undefined;
  const found: NoSession = { column: match[2] ?? '', expects: match[3] ?? '' };
  // Clauses come in any order; one the web does not know is left out.
  for (const clause of clauses) {
    const oldest = OLDEST.exec(clause)?.[1];
    if (oldest !== undefined && !Number.isNaN(Date.parse(oldest))) found.oldestAt = oldest;
    const waiting = WAITING.exec(clause)?.[1];
    if (waiting !== undefined) found.waiting = Number(waiting);
  }
  return found;
}
const turns = (count: number) => (count === 1 ? '1 turn waits' : `${String(count)} turns wait`);

const rowOf = (box: HTMLElement | null, id: string) =>
  [...(box?.querySelectorAll<HTMLElement>('[data-inbox-id]') ?? [])].find(
    (element) => element.dataset['inboxId'] === id,
  );

/** The operator query is already scoped across projects; filtering is local to this panel. */
export function InboxPanel({
  snapshot,
  notice,
  now,
  onClose,
  onOpen,
  closeItem,
}: {
  snapshot: BoardSnapshot;
  /** A board banner the panel repeats, since the board behind it is inert while it is open. */
  notice?: ReactNode;
  now: number;
  onClose: () => void;
  onOpen: (entry: Entry) => void;
  closeItem: BoardData['closeItemIntent'];
}) {
  const [selected, select] = useState('all');
  const id = useId();
  const filters = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // One intent per entry for the life of the panel, so a retry reuses its key.
  const intents = useRef(new Map<string, CloseIntent>());
  const [closes, setCloses] = useState<Record<string, CloseState>>({});
  // The active entry that holds focus, its element and its index in the visible list.
  const focused = useRef<{ id: string; element: Element; index: number } | undefined>(undefined);
  const available = !snapshot.readFailed && snapshot.stream !== 'offline';
  const items = snapshot.inbox?.items;
  const tabs = [
    { value: 'all', label: 'All', count: items?.length },
    ...(snapshot.config?.projects ?? []).map(({ id }) => ({
      value: `project:${id}`,
      label: id,
      count: items?.filter((item) => item.project === id).length,
    })),
    {
      value: 'system',
      label: 'System',
      count: items?.filter((item) => item.project === '_board').length,
    },
  ];
  const value = tabs.some((tab) => tab.value === selected) ? selected : 'all';
  useEffect(() => {
    if (selected !== value) select(value);
    filters.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, value]);
  const matches = (entry: Entry) =>
    value === 'all' ||
    entry.project === (value === 'system' ? '_board' : value.slice('project:'.length));
  const active = [...(items ?? [])].sort(
    (a, b) =>
      Number(b.severity === 'failure') - Number(a.severity === 'failure') ||
      b.at.localeCompare(a.at),
  );
  const close = (entry: Entry) => {
    if (closes[entry.id]?.phase === 'sending') return;
    let intent = intents.current.get(entry.id);
    if (intent === undefined) {
      intent = closeItem(entry.id);
      intents.current.set(entry.id, intent);
    }
    const unavailable = !available;
    const set = (state: CloseState) => {
      setCloses((current) => ({ ...current, [entry.id]: state }));
    };
    set({ phase: 'sending' });
    intent.run().then(
      () => {
        // The control gives way to a status line: keep focus in the entry, on its row.
        const element = rowOf(box.current, entry.id);
        const active = document.activeElement;
        if (element && active !== element && element.parentElement?.contains(active))
          element.focus();
        set({ phase: 'confirmed' });
      },
      (error: unknown) => {
        // Only daemon problems and the refusal have operator-facing text; a raw parse or network
        // error does not.
        const message =
          error instanceof ProblemError || error instanceof BoardUnavailableError
            ? error.message
            : 'the request failed.';
        set({
          phase: 'idle',
          error: { text: `Could not close ${entry.id}: ${message}`, unavailable },
        });
      },
    );
  };
  const footer = (entry: Entry) => {
    const state = closes[entry.id];
    const error = state?.error?.unavailable && available ? undefined : state?.error;
    return (
      <>
        {state?.phase === 'confirmed' ? (
          <p className={styles.status} role="status">
            Closed {entry.id}, waiting for the board.
          </p>
        ) : (
          <div className={styles.footer}>
            <TextToggle
              busy={state?.phase === 'sending'}
              onClick={() => {
                close(entry);
              }}
            >
              {state?.phase === 'sending' ? `Closing ${entry.id}` : `Close ${entry.id}`}
            </TextToggle>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error.text}
          </p>
        )}
      </>
    );
  };
  const entryOf = (entry: Entry, handled = false) => (
    <div key={entry.id} className={`${styles.entry ?? ''} ${quiet}`} data-inbox-entry={entry.id}>
      {row(entry, handled)}
      {!handled && closable(entry) && footer(entry)}
    </div>
  );
  const row = (entry: Entry, handled = false) => {
    const suffix = entry.action === undefined ? undefined : `: ${entry.action}`;
    const description =
      suffix !== undefined && entry.text.endsWith(suffix)
        ? entry.text.slice(0, -suffix.length)
        : entry.text;
    const known = noSession(entry, description);
    // A handled one keeps only its title and first sentence: the waiting turns are gone.
    const oldestAt = handled ? undefined : known?.oldestAt;
    const waiting = handled ? undefined : known?.waiting;
    const tail =
      waiting !== undefined && oldestAt !== undefined
        ? ` ${turns(waiting)}; the oldest for ${age(oldestAt, now)}.`
        : waiting !== undefined
          ? ` ${turns(waiting)}.`
          : oldestAt !== undefined
            ? ` The oldest turn waits for ${age(oldestAt, now)}.`
            : '';
    const body =
      known === undefined ? (
        <>
          <span>{description}</span>
          {entry.action !== undefined && <span className={styles.action}>{entry.action}</span>}
        </>
      ) : (
        <>
          <span className={styles.title}>
            <StatusDot tone="warn" />
            <span>No session to ring for {known.column}</span>
          </span>
          <span className={styles.description}>
            The {known.column} orchestrator is the Spur project{' '}
            <strong className={styles.expects}>{known.expects}</strong>, and it has no live session.
            {tail}
          </span>
          {!handled && entry.action !== undefined && (
            <span className={styles.action}>{entry.action}</span>
          )}
          {!handled && (
            <span className={styles.action}>It clears itself when a session appears.</span>
          )}
        </>
      );
    const content = (
      <>
        <span className={styles.meta}>
          <span className={styles.project}>
            {entry.project === '_board' ? 'System' : entry.project}
          </span>
          <span className={styles.kind} data-severity={entry.severity}>
            {entry.kind === 'turn'
              ? `your turn ${entry.id}`
              : entry.kind === 'block'
                ? `block ${entry.id}`
                : entry.kind.replace(/_/g, ' ')}{' '}
            · {entry.severity}
          </span>
          {entry.task !== null && <span title={entry.task}>{shortKey(entry.task)}</span>}
          {entry.column !== undefined && <span>{entry.column}</span>}
          {handled && (
            <span>Handled{entry.answeredVia ? ` · answered via ${entry.answeredVia}` : ''}</span>
          )}
          <span className={styles.age}>{age(oldestAt ?? entry.at, now)}</span>
        </span>
        {body}
      </>
    );
    const className = `${styles.row ?? ''} ${quiet} ${focusRing}`;
    const url = entry.url === undefined ? null : safeExternalUrl(entry.url);
    if (entry.task === null && url !== null)
      return (
        <a
          className={className}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-inbox-id={entry.id}
          data-handled={handled || undefined}
        >
          {content}
        </a>
      );
    return entry.task === null ? (
      <div
        className={className}
        tabIndex={0}
        data-inbox-id={entry.id}
        data-handled={handled || undefined}
      >
        {content}
      </div>
    ) : (
      <a
        key={entry.id}
        className={className}
        href={openHref(entry.task)}
        data-inbox-id={entry.id}
        data-handled={handled || undefined}
        onClick={(event) => {
          open(event, entry.task ?? '', () => {
            onOpen(entry);
          });
        }}
      >
        {content}
      </a>
    );
  };
  const visible = active.filter(matches);
  const handled = snapshot.inbox?.handled.filter(matches) ?? [];
  const ids = visible.map((entry) => entry.id).join(' ');
  useLayoutEffect(() => {
    const tracked = focused.current;
    if (tracked === undefined) return;
    const list = ids === '' ? [] : ids.split(' ');
    const index = list.indexOf(tracked.id);
    if (index !== -1) {
      tracked.index = index;
      return;
    }
    // The entry that held focus is gone: move on to its neighbour unless focus went elsewhere.
    const active = document.activeElement;
    if (tracked.element.isConnected && active !== null && active !== document.body) return;
    focused.current = undefined;
    const next = list[Math.min(tracked.index, list.length - 1)];
    const target =
      next === undefined
        ? box.current
            ?.closest('[role="dialog"]')
            ?.querySelector<HTMLElement>('[aria-label="Close"]')
        : rowOf(box.current, next);
    target?.focus();
  }, [ids]);
  return (
    <SidePanel
      open
      title="Inbox"
      icon="inbox"
      detail={items === undefined ? '– wait for you' : `${String(items.length)} wait for you`}
      onClose={onClose}
    >
      {notice}
      <div
        ref={filters}
        className={styles.filters}
        onFocus={(event) => {
          event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <Tabs
          id={id}
          label="Inbox projects"
          variant="segmented"
          tabs={tabs}
          value={value}
          onChange={select}
        />
      </div>
      <TabPanel tabsId={id} value={value}>
        {items === undefined ? (
          <p className={styles.empty}>Inbox data is not available yet.</p>
        ) : (
          <>
            <div
              ref={box}
              className={styles.box}
              onFocus={(event) => {
                const element = event.target.closest('[data-inbox-entry]');
                const entry = element?.getAttribute('data-inbox-entry');
                focused.current =
                  element && entry
                    ? { id: entry, element: event.target, index: ids.split(' ').indexOf(entry) }
                    : undefined;
              }}
              onBlur={(event) => {
                // Focus that moves out of the list ends tracking; a removed element blurs to null.
                const next = event.relatedTarget;
                if (next !== null && !event.currentTarget.contains(next))
                  focused.current = undefined;
              }}
            >
              {visible.length ? (
                visible.map((entry) => entryOf(entry))
              ) : (
                <p className={styles.empty}>Nothing waits for you here.</p>
              )}
            </div>
            <section className={`${styles.handled ?? ''} ${quiet}`} aria-label="Recently handled">
              <h2 className={styles.heading}>Recently handled</h2>
              <div className={styles.box}>
                {handled.length ? (
                  handled.map((entry) => entryOf(entry, true))
                ) : (
                  <p className={styles.empty}>Nothing yet.</p>
                )}
              </div>
            </section>
          </>
        )}
      </TabPanel>
    </SidePanel>
  );
}
