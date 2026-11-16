import { Button } from '../Button/Button.tsx';
import { IconButton } from './IconButton.tsx';

export function Close() {
  return <IconButton icon="x" size="small" label="Close" />;
}
export function InActions() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <Button variant="primary">Send follow-up</Button>
      <IconButton icon="x" size="control" label="Cancel" />
    </div>
  );
}
export function Disabled() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <IconButton icon="x" label="Close" disabled />
      <span style={{ color: 'var(--color-text-tertiary)' }}>
        Dimmed and skipped by Tab; hovering changes nothing
      </span>
    </div>
  );
}
export function Focused() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab: each size shows the focus ring
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <IconButton icon="x" size="small" label="Close" />
        <IconButton icon="x" size="control" label="Cancel" />
      </div>
    </div>
  );
}
