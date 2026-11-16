import { useId, useState } from 'react';
import { TabPanel, Tabs, type TabItem, type TabsVariant } from './Tabs.tsx';

function Controlled({
  variant,
  label,
  tabs,
  initial,
}: {
  variant: TabsVariant;
  label: string;
  tabs: readonly TabItem[];
  initial: string;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const tablist = (
    <Tabs id={id} label={label} variant={variant} tabs={tabs} value={value} onChange={setValue} />
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
