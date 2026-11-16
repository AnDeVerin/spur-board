import { Chip } from './Chip.tsx';

export function Default() {
  return <Chip>healthy</Chip>;
}
export function Warn() {
  return <Chip tone="warn">stale</Chip>;
}
export function You() {
  return <Chip tone="you">you</Chip>;
}
export function Ghost() {
  return <Chip tone="ghost">no owner</Chip>;
}
export function Link() {
  return (
    <Chip href="https://example.com/" label="PR #12, acme/app">
      PR #12
    </Chip>
  );
}
export function LinkFocused() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Hover it, or press Tab for the focus ring
      </p>
      <Chip href="https://example.com/" label="PR #12, acme/app">
        PR #12
      </Chip>
    </div>
  );
}
