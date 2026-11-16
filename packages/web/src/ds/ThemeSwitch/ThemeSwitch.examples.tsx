import { useState } from 'react';
import { ThemeSwitch, type ThemePreference } from './ThemeSwitch.tsx';

// The menu opens upward, so each example reserves room above the switch.
function Controlled({ initial, open = false }: { initial: ThemePreference; open?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        This switch is a demo; the page theme is set above.
      </p>
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
