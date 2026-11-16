import type { KeyboardEvent, ReactNode } from 'react';
import styles from './Tabs.module.css';

export type TabsVariant = 'underline' | 'segmented';

/** One tab. With a count, the tab's name is `<label> <count>`. */
export type TabItem = { value: string; label: string; count?: number | undefined };

const tabId = (id: string, value: string) => `${id}-tab-${encodeURIComponent(value)}`;
const panelId = (id: string, value: string) => `${id}-panel-${encodeURIComponent(value)}`;

/**
 * A tablist, `underline` (a view switch in a header) or `segmented` (a filter). Controlled: a
 * click or key only calls `onChange`; the selection changes when the caller passes the new
 * `value`. Selection follows focus: ArrowLeft and ArrowRight move and wrap, Home and End jump;
 * with Shift, Alt, Ctrl or Meta held they do nothing. Only one tab is a Tab stop: the selected
 * one, or the first when `value` matches no tab.
 *
 * Tab and panel ids derive from `id`, so give each tablist an id unique on the page. Only the
 * selected tab points at its panel: the screen renders one `TabPanel`, for the selected value.
 * Renders nothing when `tabs` is empty.
 */
export function Tabs({
  id,
  label,
  variant = 'underline',
  tabs,
  value,
  onChange,
}: {
  id: string;
  label: string;
  variant?: TabsVariant | undefined;
  tabs: readonly TabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (tabs.length === 0) return null;
  const selected = tabs.findIndex((tab) => tab.value === value);
  const stop = selected === -1 ? 0 : selected;
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    const target = next === undefined ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.value);
    document.getElementById(tabId(id, target.value))?.focus();
  };
  return (
    <div
      className={`${styles.tablist ?? ''} ${styles[variant] ?? ''}`}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          id={tabId(id, tab.value)}
          className={styles.tab}
          type="button"
          role="tab"
          aria-selected={index === selected}
          aria-controls={index === selected ? panelId(id, tab.value) : undefined}
          aria-label={tab.count === undefined ? undefined : `${tab.label} ${String(tab.count)}`}
          tabIndex={index === stop ? 0 : -1}
          onClick={() => {
            onChange(tab.value);
          }}
          onKeyDown={(event) => {
            keyDown(event, index);
          }}
        >
          {tab.label}
          {tab.count !== undefined && <span className={styles.count}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The panel of the selected tab, labelled by it. It lives with `Tabs` because both build their
 * ids from the same `Tabs` `id`. A filter screen renders one `TabPanel` around the filtered list,
 * with the selected value. The panel is a tab stop, as the WAI-ARIA tabs pattern asks, so Tab from
 * the selected tab reaches panel content that holds no control of its own.
 */
export function TabPanel({
  tabsId,
  value,
  children,
}: {
  tabsId: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div
      id={panelId(tabsId, value)}
      role="tabpanel"
      aria-labelledby={tabId(tabsId, value)}
      tabIndex={0}
      className={styles.panel}
    >
      {children}
    </div>
  );
}
