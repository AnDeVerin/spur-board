import { useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Button } from '../Button/Button.tsx';
import { TabPanel, Tabs, type TabItem } from '../Tabs/Tabs.tsx';
import { Popover } from './Popover.tsx';

const helpTabs: TabItem[] = [
  { value: 'who', label: 'Who' },
  { value: 'rules', label: 'Rules' },
];

const caption = { margin: 0, color: 'var(--color-text-tertiary)' };
const text = { margin: 0 };

/**
 * The anchor wrapper and the button inside it, kept by one ref callback on the wrapper: the ds
 * Button takes no ref, and its `<button>` is attached before the wrapper's ref runs.
 */
function useAnchor() {
  const anchor = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const hold = (wrapper: HTMLElement | null) => {
    anchor.current = wrapper;
    trigger.current = wrapper?.querySelector('button') ?? null;
  };
  return { anchor, trigger, hold };
}

/** A help panel with Who and Rules tabs in its header; `lines` sets the body length. */
function HelpPopover({
  open,
  onClose,
  anchor,
  trigger,
  lines,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  trigger: RefObject<HTMLElement | null>;
  lines: number;
}) {
  const id = useId();
  const [tab, setTab] = useState('who');
  const what = tab === 'who' ? 'Waits for the operator' : 'Moves on a quiet turn';
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      trigger={trigger}
      title="Review"
      actions={<Tabs id={id} label="Column help" tabs={helpTabs} value={tab} onChange={setTab} />}
    >
      <TabPanel tabsId={id} value={tab}>
        {Array.from({ length: lines }, (_, index) => (
          <p key={index} style={text}>{`${what}, line ${String(index + 1)}`}</p>
        ))}
      </TabPanel>
    </Popover>
  );
}

/**
 * A trigger in a wrapper the popover anchors to, with room reserved under it so an open panel
 * does not cover the next example.
 */
function Demo({
  children,
  defaultOpen = false,
  lines = 4,
  end = false,
  style,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  lines?: number;
  end?: boolean;
  style?: CSSProperties;
}) {
  const { anchor, trigger, hold } = useAnchor();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', ...style }}>
      <p style={caption}>{children}</p>
      <div ref={hold} style={{ justifySelf: end ? 'end' : 'start' }}>
        <Button
          expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          Help
        </Button>
      </div>
      <HelpPopover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchor={anchor}
        trigger={trigger}
        lines={lines}
      />
    </div>
  );
}

// Room for a short open panel under its anchor.
const reserved = { paddingBlockEnd: 'calc(var(--size-section-header) * 5)' };

export function Open() {
  return (
    <Demo defaultOpen style={reserved}>
      Starts open under the button: the title at the left, then the Who and Rules tabs, then Close.
      Escape, Close or a click outside closes it; the button opens it again.
    </Demo>
  );
}

export function FollowsColumn() {
  const { anchor, trigger, hold } = useAnchor();
  const [open, setOpen] = useState(true);
  const column: CSSProperties = {
    flex: 'none',
    width: 'var(--size-column)',
    borderRight: 'var(--size-hairline) solid var(--color-border-default)',
  };
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', ...reserved }}>
      <p style={caption}>
        Starts open under the third column head. Scroll the strip sideways: the panel follows the
        column, keeps inside the window while the column shows, and leaves the window with it. A
        touch scroll does not close it.
      </p>
      <div style={{ display: 'flex', overflowX: 'auto' }}>
        {['Todo', 'Working', 'Review', 'Waiting', 'Done', 'Archive'].map((name) =>
          name === 'Review' ? (
            <div key={name} ref={hold} style={column}>
              <Button
                expanded={open}
                onClick={() => {
                  setOpen(!open);
                }}
              >
                {name}
              </Button>
            </div>
          ) : (
            <div key={name} style={column}>
              <p style={text}>{name}</p>
            </div>
          ),
        )}
      </div>
      <HelpPopover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchor={anchor}
        trigger={trigger}
        lines={4}
      />
    </div>
  );
}

export function LongContent() {
  return (
    <Demo lines={60}>
      Starts closed; open it with the button in the lower third: the panel stays under it and
      shrinks down to its header and one control while the body scrolls, flips above with less room,
      and at 375px fills the width less a small space each side.
    </Demo>
  );
}

export function FlipsAbove() {
  return (
    <Demo lines={60} style={{ minHeight: '100dvh', alignContent: 'end' }}>
      Starts closed. Scroll until the button sits at the bottom of the window and open it: with less
      room under the button than its header and one control, the panel opens above it, its header
      and Close inside the window.
    </Demo>
  );
}

export function WindowEdge() {
  return (
    <Demo end>
      Starts closed. The button sits at the right end: open it and the panel keeps inside the
      window, its right edge one small space from the window edge.
    </Demo>
  );
}

export function Closed() {
  return (
    <Demo>
      Starts closed. Press Tab to reach the button and Enter to open the panel: focus lands on
      Close. Tab moves on to the tab panel; Escape closes the panel and focus returns to the button.
    </Demo>
  );
}
