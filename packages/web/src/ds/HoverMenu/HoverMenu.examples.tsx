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
function Frame({
  caption,
  opens,
  rows = 4,
  children,
}: {
  caption: string;
  opens: 'up' | 'down';
  rows?: number;
  children: ReactNode;
}) {
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
            `calc(var(--size-control) * ${String(rows)})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
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
    <Frame caption={caption} opens={opens}>
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
    </Frame>
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

// The sort menu of a column head: the trigger shows the first letter of the chosen field.
type Field = 'time' | 'key' | 'manual';
const fields: readonly HoverMenuItem<Field>[] = [
  { value: 'time', label: 'Time' },
  { value: 'key', label: 'Key' },
  { value: 'manual', label: 'Manual' },
];
function SortDemo({ caption, open = false }: { caption: string; open?: boolean }) {
  const [value, setValue] = useState<Field>('time');
  return (
    <Frame caption={caption} opens="down">
      <HoverMenu
        label="Sort ready"
        text={(fields.find((field) => field.value === value)?.label ?? '').slice(0, 1)}
        items={fields}
        value={value}
        onSelect={setValue}
        opens="down"
        defaultOpen={open}
      />
    </Frame>
  );
}
// Two sort menus whose parent keeps one open at most, as the board's column heads do.
function SharedDemo() {
  const [shown, setShown] = useState<'a' | 'b' | null>(null);
  const [first, setFirst] = useState<Field>('time');
  const [second, setSecond] = useState<Field>('key');
  const letter = (value: Field) =>
    (fields.find((field) => field.value === value)?.label ?? '').slice(0, 1);
  const change = (menu: 'a' | 'b') => (open: boolean) => {
    setShown((current) => (open ? menu : current === menu ? null : current));
  };
  return (
    <Frame
      caption="Controlled: opening either menu by hover, click or key closes the other"
      opens="down"
    >
      <HoverMenu
        label="Sort todo"
        text={letter(first)}
        items={fields}
        value={first}
        onSelect={setFirst}
        opens="down"
        open={shown === 'a'}
        onOpenChange={change('a')}
      />
      <HoverMenu
        label="Sort ready"
        text={letter(second)}
        items={fields}
        value={second}
        onSelect={setSecond}
        opens="down"
        open={shown === 'b'}
        onOpenChange={change('b')}
      />
    </Frame>
  );
}
// The card menu: moves inside the manual order, then a rule and the moves to other parts.
const cardMoves: readonly HoverMenuItem<string>[] = [
  { value: 'top', label: 'Move to top', disabled: true },
  { value: 'bottom', label: 'Move to bottom' },
  { value: 'todo', label: 'Move to todo…', group: 'part' },
  { value: 'triage', label: 'Move to triage…', group: 'part' },
];
const mirrorMoves: readonly HoverMenuItem<string>[] = [
  { value: 'ready', label: 'Move to ready…', disabled: true, group: 'part' },
];
const causeMoves: readonly HoverMenuItem<string>[] = [
  {
    value: 'top',
    label: 'Move to top',
    disabled: true,
    cause: 'Already first in the manual order',
  },
  { value: 'bottom', label: 'Move to bottom' },
  { value: 'todo', label: 'Move to todo…', group: 'part' },
  {
    value: 'ready',
    label: 'Move to ready…',
    group: 'part',
    disabled: true,
    cause: 'Ready mirrors a GitHub Project; change the status there',
  },
];
// Each cause wraps to up to four micro lines at the menu's item width: about 240px of menu.
const causeRows = 10;
function CardDemo({
  caption,
  moves,
  note,
  open = false,
  rows = 7,
}: {
  caption: string;
  moves: readonly HoverMenuItem<string>[];
  note?: string;
  open?: boolean;
  rows?: number;
}) {
  return (
    <Frame caption={caption} opens="down" rows={rows}>
      <HoverMenu
        label="Move this task"
        text="⋯"
        variant="action"
        items={moves}
        note={note}
        onSelect={() => undefined}
        opens="down"
        defaultOpen={open}
      />
    </Frame>
  );
}

export function TextTrigger() {
  return <SortDemo caption="A text trigger: the letter of the chosen sort field; hover or click" />;
}
export function SortMenu() {
  return <SortDemo caption="The sort menu open downward from its letter, Time checked" open />;
}
export function Controlled() {
  return <SharedDemo />;
}
export function CardMenu() {
  return (
    <CardDemo
      caption="Card menu in a manual part: the first card cannot move up, a rule before the parts"
      moves={cardMoves}
      open
    />
  );
}
export function CardMenuMirror() {
  return (
    <CardDemo
      caption="Card menu in todo: the move into a mirrored part is disabled, the note says why"
      moves={mirrorMoves}
      note={'Ready mirrors the GitHub Project "Web roadmap". Change the status there.'}
      open
    />
  );
}
export function CauseLine() {
  return (
    <CardDemo
      caption="A cause line under each disabled item, named by its aria-describedby"
      moves={causeMoves}
      open
      rows={causeRows}
    />
  );
}
export function ActionsFocused() {
  return (
    <CardDemo
      caption="Tab to ⋯, press ArrowDown: focus lands on the disabled Move to top; Enter does nothing; ArrowDown moves on; Escape returns to the trigger"
      moves={causeMoves}
      rows={causeRows}
    />
  );
}
