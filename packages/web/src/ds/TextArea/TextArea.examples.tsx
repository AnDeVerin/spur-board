import { useState } from 'react';
import { TextArea } from './TextArea.tsx';

function Controlled({ initial, disabled = false }: { initial: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <TextArea
      label="Answer"
      value={value}
      onChange={setValue}
      placeholder="Your answer goes to the agent"
      disabled={disabled}
    />
  );
}
export function Empty() {
  return <Controlled initial="" />;
}
export function Typing() {
  return <Controlled initial="Use the staging database for the migration test" />;
}
export function Disabled() {
  return <Controlled initial="" disabled />;
}
export function Focused() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab: the border turns primary
      </p>
      <Controlled initial="" />
    </div>
  );
}
