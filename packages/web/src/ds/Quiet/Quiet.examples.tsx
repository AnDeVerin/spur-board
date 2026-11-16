import { useState, type ReactNode } from 'react';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { quiet } from './Quiet.tsx';

const tertiary = { color: 'var(--color-text-tertiary)' };
function Block({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div
      className={quiet}
      style={{
        display: 'grid',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border-default)',
      }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>{caption}</p>
      {children}
    </div>
  );
}
export function Rest() {
  return (
    <Block caption="Leave this block alone: the grey text stays tertiary">
      <span style={tertiary}>Updated 4 minutes ago</span>
    </Block>
  );
}
export function HoverOrFocus() {
  return (
    <Block caption="Hover this block, or Tab into its button">
      <span style={tertiary}>
        <StatusDot tone="unknown" /> Source not polled yet
      </span>
      <button type="button" style={{ justifySelf: 'start', font: 'inherit' }}>
        Focus me
      </button>
    </Block>
  );
}
export function Brightening() {
  const [hot, setHot] = useState(false);
  const on = () => {
    setHot(true);
  };
  const off = () => {
    setHot(false);
  };
  return (
    <Block caption="Hover the link: it turns primary, not secondary">
      <a
        href="#Quiet-Brightening"
        style={{ color: hot ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}
        onMouseEnter={on}
        onMouseLeave={off}
        onFocus={on}
        onBlur={off}
      >
        Open the task
      </a>
    </Block>
  );
}
