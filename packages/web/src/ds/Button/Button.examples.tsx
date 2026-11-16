import { useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';

function Shown({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>{children}</div>
    </div>
  );
}
export function Primary() {
  return (
    <Shown caption="Hover it, or Tab to it for the focus ring">
      <Button variant="primary">Answer B89</Button>
    </Shown>
  );
}
export function Outlined() {
  return (
    <Shown caption="Hover it, or Tab to it for the focus ring">
      <Button>Retry now</Button>
    </Shown>
  );
}
export function Disabled() {
  return (
    <Shown caption="Dimmed and skipped by Tab; hovering changes nothing">
      <Button variant="primary" disabled>
        Answer B89
      </Button>
      <Button disabled>Retry now</Button>
    </Shown>
  );
}
export function Busy() {
  const [clicks, setClicks] = useState(0);
  const count = () => {
    setClicks((value) => value + 1);
  };
  return (
    <Shown caption="Busy: the label names the action in flight; clicks and hover do nothing, Tab still reaches it">
      <Button variant="primary" busy onClick={count}>
        Sending
      </Button>
      <Button busy onClick={count}>
        Retrying
      </Button>
      <span>clicks received: {clicks}</span>
    </Shown>
  );
}
