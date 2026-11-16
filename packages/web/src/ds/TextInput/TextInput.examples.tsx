import { useState } from 'react';
import { TextInput } from './TextInput.tsx';

function Filter({ initial, disabled = false }: { initial: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <TextInput
      icon="search"
      label="Filter tasks"
      placeholder="Task key, session or block id"
      value={value}
      onChange={setValue}
      disabled={disabled}
    />
  );
}
export function Empty() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Tab in to see focus: the border turns primary
      </p>
      <Filter initial="" />
    </div>
  );
}
export function WithValue() {
  return <Filter initial="B89" />;
}
export function Disabled() {
  return <Filter initial="B89" disabled />;
}
