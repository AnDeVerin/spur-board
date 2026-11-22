import type { KeyboardEvent, ReactNode } from 'react';
import styles from './Tabs.module.css';

export type TabsVariant = 'underline' | 'segmented';

/** One tab. With a count, the tab's name is `<label> <count>`. A disabled tab is inert. */
export type TabItem = {
  value: string;
  label: string;
  count?: number | undefined;
  disabled?: boolean | undefined;
};

const tabId = (id: string, value: string) => `${id}-tab-${encodeURIComponent(value)}`;
const panelId = (id: string, value: string) => `${id}-panel-${encodeURIComponent(value)}`;

/**
 * A tablist, `underline` (a view switch in a header) or `segmented` (a filter). Controlled: a
 * click or key only calls `onChange`; the selection changes when the caller passes the new
 * `value`. Selection follows focus: ArrowLeft and ArrowRight move and wrap, Home and End jump;
 * with Shift, Alt, Ctrl or Meta held they do nothing. Only one tab is a Tab stop: the selected
 * one, or the first enabled one when `value` matches no tab or names a disabled one.
 *
 * A disabled tab (`TabItem.disabled`) renders `aria-disabled`, is never a Tab stop and ignores
 * clicks; the keys skip it, and from a focused disabled tab they step to the nearest enabled one.
 * `disabled` on the list disables every tab: keys and clicks do nothing, no tab is a Tab stop and
 * Tab reaches the panel.
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
  disabled = false,
}: {
  id: string;
  label: string;
  variant?: TabsVariant | undefined;
  tabs: readonly TabItem[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
}) {
  if (tabs.length === 0) return null;
  const off = (tab: TabItem) => disabled || tab.disabled === true;
  const enabled = tabs.flatMap((tab, index) => (off(tab) ? [] : [index]));
  const selected = tabs.findIndex((tab) => tab.value === value);
  const stop = enabled.includes(selected) ? selected : enabled[0];
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    // Arrows step over enabled tabs in the key's direction and wrap, from a disabled tab too.
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = enabled.find((i) => i > index) ?? enabled[0];
    else if (event.key === 'ArrowLeft') next = enabled.findLast((i) => i < index) ?? enabled.at(-1);
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    else return;
    // A tab key never scrolls the page, even with no enabled tab to move to.
    event.preventDefault();
    const target = next === undefined ? undefined : tabs[next];
    if (!target) return;
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
          aria-disabled={off(tab) || undefined}
          tabIndex={index === stop ? 0 : -1}
          onClick={() => {
            if (off(tab)) return;
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
