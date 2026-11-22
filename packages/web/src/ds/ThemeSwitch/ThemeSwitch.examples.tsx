import { useState } from 'react';
import { quiet } from '../Quiet/Quiet.tsx';
import { ThemeSwitch, type ThemePreference } from './ThemeSwitch.tsx';

// The menu opens upward, so each example reserves room above the switch.
function Controlled({
  initial,
  open = false,
  caption = 'This switch is a demo; the page theme is set above.',
}: {
  initial: ThemePreference;
  open?: boolean;
  caption?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className={quiet}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      <div style={{ paddingBlockStart: 'calc(var(--size-control) * 4)' }}>
        <ThemeSwitch value={value} onChange={setValue} defaultOpen={open} />
      </div>
    </div>
  );
}
export function Dark() {
  return <Controlled initial="dark" />;
}
export function Light() {
  return <Controlled initial="light" />;
}
export function Auto() {
  return <Controlled initial="auto" />;
}
export function Open() {
  return <Controlled initial="dark" open />;
}
export function Focused() {
  return (
    <Controlled
      initial="dark"
      caption="Press Tab to reach the switch, then ArrowDown; arrows move, Escape returns to the switch"
    />
  );
}
