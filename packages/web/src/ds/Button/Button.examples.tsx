import { useId, useState, type ReactNode } from 'react';
import { quiet } from '../Quiet/Quiet.tsx';
import { Button } from './Button.tsx';

function Shown({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div
      className={quiet}
      style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}
    >
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
export function Disclosure() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Shown caption="Disclosure: click it, or Tab to it and press Enter; aria-expanded follows the list">
      <div style={{ display: 'grid', gap: 'var(--space-1)', justifyItems: 'start' }}>
        <Button
          expanded={open}
          controls={id}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          stand
        </Button>
        <ul id={id} hidden={!open} style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          <li>stand · dispatcher on</li>
          <li>stand-jira · dispatcher shadow</li>
        </ul>
      </div>
    </Shown>
  );
}
export function DescribedBy() {
  const id = useId();
  return (
    <Shown caption="Described by the line above it: Tab to it and a screen reader reads the line after the name">
      <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
        <p id={id} style={{ margin: 0 }}>
          This closes T5 in your name and moves it to Done. It cannot be undone.
        </p>
        <Button variant="primary" describedBy={id}>
          Close the turn
        </Button>
      </div>
    </Shown>
  );
}
export function Focused() {
  return (
    <Shown caption="Press Tab: each button shows the focus ring">
      <Button variant="primary">Answer B89</Button>
      <Button>Retry now</Button>
    </Shown>
  );
}
