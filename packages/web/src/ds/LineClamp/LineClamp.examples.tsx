import { useState } from 'react';
import { LineClamp } from './LineClamp.tsx';

const long =
  'The migration renames the session table and moves the run history into its own table. ' +
  'Before it runs, the agent needs to know which order the two steps take, since the board ' +
  'reads both tables while it polls, and a wrong order leaves the history empty for a poll. ' +
  'Pick the order, or say to stop the poller first.';

function Clamped({ text, note }: { text: string; note?: string }) {
  const [overflows, setOverflows] = useState<boolean | undefined>(undefined);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', width: 'var(--size-column)' }}>
      <LineClamp onOverflowChange={setOverflows}>{text}</LineClamp>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        {`overflows: ${overflows === undefined ? '…' : overflows ? 'yes' : 'no'}`}
        {note === undefined ? null : ` · ${note}`}
      </p>
    </div>
  );
}

export function Short() {
  return <Clamped text="Pick a migration order." />;
}
export function Long() {
  return <Clamped text={long} />;
}
export function Overflowing() {
  return (
    <Clamped
      text={`${long}\n\nA second paragraph that the fold hides.`}
      note="Measured only while clamped: a screen that shows the full text keeps the last yes"
    />
  );
}
