import { useState } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { HoverMenu, type HoverMenuItem } from './HoverMenu.tsx';

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];
const icons: Record<Choice, IconName> = { light: 'sun', dark: 'moon', auto: 'auto' };

// The menu opens upward and end-aligned, so each example reserves room above the trigger.
function Demo({
  caption,
  initial,
  open = false,
}: {
  caption: string;
  initial?: Choice;
  open?: boolean;
}) {
  const [value, setValue] = useState<Choice | undefined>(initial);
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          maxWidth: 'var(--size-column)',
          paddingBlockStart: 'calc(var(--size-control) * 4)',
        }}
      >
        <HoverMenu
          label="Theme"
          icon={value === undefined ? 'auto' : icons[value]}
          items={items}
          value={value}
          onSelect={setValue}
          defaultOpen={open}
        />
      </div>
    </div>
  );
}
export function Closed() {
  return <Demo caption="Hover, click or tap the trigger" initial="dark" />;
}
export function Open() {
  return <Demo caption="Open with no choice checked" open />;
}
export function Selected() {
  return <Demo caption="Open with Dark checked" initial="dark" open />;
}
export function Focused() {
  return (
    <Demo
      caption="Tab to the trigger, press ArrowDown; arrows move, Escape returns to the trigger"
      initial="light"
    />
  );
}
export function Touch() {
  return (
    <Demo
      caption="On a touch screen or with touch emulation (hover: none): tap opens, tap again closes"
      initial="auto"
    />
  );
}
