import type { ReactNode } from 'react';
import { quiet } from '../Quiet/Quiet.tsx';
import { focusRing } from './FocusRing.tsx';

function Shown({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div
      className={quiet}
      style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      {children}
    </div>
  );
}
function CardLink({ hash }: { hash: string }) {
  return (
    <a
      className={focusRing}
      href={hash}
      style={{
        display: 'block',
        padding: 'var(--space-2-5) var(--space-3)',
        border: 'var(--size-hairline) solid var(--color-border-default)',
        color: 'var(--color-text-primary)',
        textDecoration: 'none',
      }}
    >
      Open task 42
    </a>
  );
}
export function Rest() {
  return (
    <Shown caption="Not focused: the link shows no ring">
      <CardLink hash="#FocusRing-Rest" />
    </Shown>
  );
}
export function Focused() {
  return (
    <Shown caption="Press Tab to the link: it shows the focus ring">
      <CardLink hash="#FocusRing-Focused" />
    </Shown>
  );
}
