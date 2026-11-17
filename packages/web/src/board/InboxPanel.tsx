import { useEffect, useId, useRef, useState } from 'react';
import { focusRing, quiet, SidePanel, TabPanel, Tabs } from '../ds/index.ts';
import type { BoardSnapshot } from './data.ts';
import { open } from './Card.tsx';
import { openHref, shortKey } from './model.ts';
import { age } from './task-model.ts';
import styles from './InboxPanel.module.css';

type Inbox = NonNullable<BoardSnapshot['inbox']>;
type Entry = Inbox['items'][number];

/** The operator query is already scoped across projects; filtering is local to this panel. */
export function InboxPanel({
  snapshot,
  now,
  onClose,
  onOpen,
}: {
  snapshot: BoardSnapshot;
  now: number;
  onClose: () => void;
  onOpen: (entry: Entry) => void;
}) {
  const [selected, select] = useState('all');
  const id = useId();
  const filters = useRef<HTMLDivElement>(null);
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
  const row = (entry: Entry, handled = false) => {
    const suffix = entry.action === undefined ? undefined : `: ${entry.action}`;
    const description =
      suffix !== undefined && entry.text.endsWith(suffix)
        ? entry.text.slice(0, -suffix.length)
        : entry.text;
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
          <span className={styles.age}>{age(entry.at, now)}</span>
        </span>
        <span>{description}</span>
        {entry.action !== undefined && <span className={styles.action}>{entry.action}</span>}
      </>
    );
    const className = `${styles.row ?? ''} ${quiet} ${focusRing}`;
    return entry.task === null ? (
      <div
        key={entry.id}
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
  return (
    <SidePanel
      open
      title="Inbox"
      icon="inbox"
      detail={items === undefined ? '– wait for you' : `${String(items.length)} wait for you`}
      onClose={onClose}
    >
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
            <div className={styles.box}>
              {visible.length ? (
                visible.map((entry) => row(entry))
              ) : (
                <p className={styles.empty}>Nothing waits for you here.</p>
              )}
            </div>
            <section className={`${styles.handled ?? ''} ${quiet}`} aria-label="Recently handled">
              <h2 className={styles.heading}>Recently handled</h2>
              <div className={styles.box}>
                {handled.length ? (
                  handled.map((entry) => row(entry, true))
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
