import { useState, type ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { HoverMenu, type HoverMenuItem } from './HoverMenu.tsx';

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];
const icons: Record<Choice, IconName> = { light: 'sun', dark: 'moon', auto: 'auto' };

// The menu opens end-aligned, so each example reserves room on the side it opens to.
function Demo({
  caption,
  initial,
  open = false,
  opens = 'up',
  children,
}: {
  caption: string;
  initial?: Choice;
  open?: boolean;
  opens?: 'up' | 'down';
  children?: ReactNode;
}) {
  const [value, setValue] = useState<Choice | undefined>(initial);
  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'calc(var(--space-8) + var(--space-8) + var(--space-8) + var(--space-8))',
          maxWidth: 'var(--size-column)',
          [opens === 'up' ? 'paddingBlockStart' : 'paddingBlockEnd']:
            'calc(var(--size-control) * 4)',
        }}
      >
        <HoverMenu
          label="Theme"
          icon={value === undefined ? 'auto' : icons[value]}
          items={items}
          value={value}
          onSelect={setValue}
          defaultOpen={open}
          opens={opens}
        />
        {children}
      </div>
    </div>
  );
}
type Accent = 'warm' | 'cool' | 'plain';
const accents: readonly HoverMenuItem<Accent>[] = [
  { value: 'warm', label: 'Warm', icon: 'diamond' },
  { value: 'cool', label: 'Cool', icon: 'pulse' },
  { value: 'plain', label: 'Plain', icon: 'shadow' },
];

function AccentMenu() {
  const [value, setValue] = useState<Accent>('warm');
  return (
    <HoverMenu label="Accent" icon="diamond" items={accents} value={value} onSelect={setValue} />
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
export function TwoMenus() {
  return (
    <Demo
      caption="Click the first trigger, then hover the second: Escape closes the focused menu, a second Escape the other"
      initial="light"
    >
      <AccentMenu />
    </Demo>
  );
}
export function OpensDown() {
  return (
    <Demo
      caption="Opens downward, end-aligned, touching the trigger"
      initial="dark"
      open
      opens="down"
    />
  );
}
