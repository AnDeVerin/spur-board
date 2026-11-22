import { useState } from 'react';
import { FormRow } from '../FormRow/FormRow.tsx';
import { quiet } from '../Quiet/Quiet.tsx';
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
    <div className={quiet} style={{ display: 'grid', gap: 'var(--space-2)' }}>
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
function Row({ label, hint, error }: { label: string; hint: string; error?: string }) {
  const [value, setValue] = useState('');
  return (
    <FormRow label={label} hint={hint} error={error}>
      <TextInput label={label} value={value} onChange={setValue} />
    </FormRow>
  );
}
export function InFormRow() {
  return (
    <div className={quiet} style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Click a label: focus lands in its field, which the row names and describes by its hint or
        error
      </p>
      <Row label="Commit" hint="The commit the tests ran on" />
      <Row
        label="Carried from"
        hint="The task whose tests cover this one"
        error="Name a task key, such as T5."
      />
    </div>
  );
}
export function Focused() {
  return (
    <div className={quiet} style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab: the border turns primary; press Tab again to reach Clear, which shows the focus
        ring
      </p>
      <Filter initial="B89" />
    </div>
  );
}
