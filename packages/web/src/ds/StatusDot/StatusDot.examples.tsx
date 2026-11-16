import type { ReactNode } from 'react';
import { StatusDot } from './StatusDot.tsx';

// A status dot always sits next to the word it stands for.
function Labeled({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      {children}
    </span>
  );
}
export function Ok() {
  return (
    <Labeled>
      <StatusDot tone="ok" />
      ok
    </Labeled>
  );
}
export function Warn() {
  return (
    <Labeled>
      <StatusDot tone="warn" />
      warn
    </Labeled>
  );
}
export function Error() {
  return (
    <Labeled>
      <StatusDot tone="error" />
      error
    </Labeled>
  );
}
export function Working() {
  return (
    <Labeled>
      <StatusDot tone="working" />
      working
    </Labeled>
  );
}
export function Unknown() {
  return (
    <Labeled>
      <StatusDot tone="unknown" />
      unknown
    </Labeled>
  );
}
export function Hollow() {
  return (
    <Labeled>
      <StatusDot tone="warn" hollow />
      warn, hollow
    </Labeled>
  );
}
