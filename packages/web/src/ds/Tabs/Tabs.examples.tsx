import { useId, useState } from 'react';
import { TabPanel, Tabs, type TabItem, type TabsVariant } from './Tabs.tsx';

function Controlled({
  variant,
  label,
  tabs,
  initial,
  disabled = false,
}: {
  variant: TabsVariant;
  label: string;
  tabs: readonly TabItem[];
  initial: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const tablist = (
    <Tabs
      id={id}
      label={label}
      variant={variant}
      tabs={tabs}
      value={value}
      onChange={setValue}
      disabled={disabled}
    />
  );
  return (
    <div>
      {variant === 'underline' ? (
        <div
          style={{
            display: 'flex',
            height: 'var(--size-header)',
            borderBottom: 'var(--size-hairline) solid var(--color-border-default)',
          }}
        >
          {tablist}
        </div>
      ) : (
        tablist
      )}
      <TabPanel tabsId={id} value={value}>
        <p>{`Showing ${value}.`}</p>
      </TabPanel>
    </div>
  );
}

const views: TabItem[] = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History', count: 12 },
];
const filters: TabItem[] = [
  { value: 'all', label: 'all', count: 7 },
  { value: 'spur-board', label: 'spur-board', count: 3 },
  { value: 'system', label: 'system', count: 4 },
];

export function Underline() {
  return <Controlled variant="underline" label="Task view" tabs={views} initial="now" />;
}
export function Segmented() {
  return <Controlled variant="segmented" label="Filter" tabs={filters} initial="spur-board" />;
}
export function Focused() {
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab to reach the selected tab, then the arrow keys, Home and End; Tab again reaches
        the panel.
      </p>
      <Controlled variant="underline" label="Task view" tabs={views} initial="history" />
      <Controlled variant="segmented" label="Filter" tabs={filters} initial="all" />
    </div>
  );
}
export function Disabled() {
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Disabled list: dimmed; arrow keys, Home, End, clicks and hover do nothing; Tab skips the
        tabs to the panel.
      </p>
      <Controlled variant="underline" label="Task view" tabs={views} initial="now" disabled />
      <Controlled variant="segmented" label="Filter" tabs={filters} initial="all" disabled />
    </div>
  );
}
const bases: TabItem[] = [
  { value: 'tested', label: 'Tested' },
  { value: 'carried', label: 'Carried', disabled: true },
  { value: 'skipped', label: 'Skipped' },
];
export function DisabledTab() {
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Carried is disabled: the arrow keys skip it and a click on it does nothing.
      </p>
      <Controlled variant="segmented" label="Basis" tabs={bases} initial="tested" />
    </div>
  );
}
