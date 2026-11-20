import { useState } from 'react';
import { KeyValueBox } from '../KeyValueBox/KeyValueBox.tsx';
import { CollapsibleSection } from './CollapsibleSection.tsx';

export function Open() {
  return (
    <CollapsibleSection title="Blocks" count={3} summary="1 open on you · 2 answered by the agent">
      <KeyValueBox
        rows={[
          { key: 'Pick a migration order', value: 'open', status: 'wait' },
          { key: 'Confirm the schema name', value: 'answered' },
          { key: 'Rerun the flaky check', value: 'answered' },
        ]}
      />
    </CollapsibleSection>
  );
}
export function Collapsed() {
  return (
    <CollapsibleSection title="Comments" count={4} summary="2 open" defaultOpen={false}>
      <p>Four comments, two of them still open.</p>
    </CollapsibleSection>
  );
}
// Scroll the frame: each header stays on top until the end of its section pushes it away.
export function Sticky() {
  const lines = (label: string) =>
    Array.from({ length: 12 }, (_, index) => (
      <p key={index}>{`${label} line ${String(index + 1)}`}</p>
    ));
  return (
    <div style={{ height: 'calc(var(--size-control) * 8)', overflowY: 'auto' }}>
      <CollapsibleSection title="Why it is here" summary="3 of 4 met">
        {lines('Why')}
      </CollapsibleSection>
      <CollapsibleSection title="History" count={12} summary="last 2 hours ago">
        {lines('History')}
      </CollapsibleSection>
    </div>
  );
}
export function Focused() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab to reach the chevron; Enter or Space toggles the section
      </p>
      <CollapsibleSection title="Comments" count={4} summary="2 open">
        <p>Four comments, two of them still open.</p>
      </CollapsibleSection>
    </div>
  );
}
// Toggle it: the line below shows the last state the section reported.
export function OnOpenChange() {
  const [last, setLast] = useState<boolean | null>(null);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <CollapsibleSection
        title="Latest submission"
        summary="skipped"
        defaultOpen={false}
        onOpenChange={setLast}
      >
        <p>The rows of the latest submission.</p>
      </CollapsibleSection>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        {`Last reported: ${last === null ? 'none' : last ? 'open' : 'closed'}`}
      </p>
    </div>
  );
}
