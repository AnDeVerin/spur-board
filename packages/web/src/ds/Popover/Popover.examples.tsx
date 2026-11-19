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

/** A help panel with Who and Rules tabs in its header; `lines` sets the body length. */
function HelpPopover({
  open,
  onClose,
  anchor,
  lines,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
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
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', ...style }}>
      <p style={caption}>{children}</p>
      <div ref={anchor} style={{ justifySelf: end ? 'end' : 'start' }}>
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
  const head = useRef<HTMLDivElement>(null);
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
            <div key={name} ref={head} style={column}>
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
        anchor={head}
        lines={4}
      />
    </div>
  );
}

export function LongContent() {
  return (
    <Demo lines={60}>
      Starts closed. Scroll so the button sits in the lower third of the window and open it: the
      panel stays under the button, its bottom edge keeps inside the window, and the body scrolls.
      It never flips above.
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
