import { useRef, useState, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { quiet } from '../Quiet/Quiet.tsx';
import { SidePanel, type SidePanelSide } from './SidePanel.tsx';

function Demo({
  side,
  icon,
  title,
  detail,
  caption = `Open it: the ${side} panel and its scrim sit between the header band and the status bar band; those bands stay undimmed but inert, so a click or Tab there reaches nothing. At the narrow breakpoint it fills the screen.`,
  children,
}: {
  side: SidePanelSide;
  icon: IconName;
  title: string;
  detail: string;
  caption?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={quiet}
      style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>{caption}</p>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        {`Open ${side} panel`}
      </Button>
      <SidePanel
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        side={side}
        icon={icon}
        title={title}
        detail={detail}
      >
        {children}
      </SidePanel>
    </div>
  );
}

function Inbox() {
  return (
    <>
      <div>
        <Button>Mark all read</Button>
      </div>
      <div>
        {Array.from({ length: 40 }, (_, index) => (
          <p key={index} style={{ margin: 0 }}>{`Inbox item, line ${String(index + 1)}`}</p>
        ))}
      </div>
    </>
  );
}

export function Right() {
  return (
    <Demo side="right" icon="inbox" title="Inbox" detail="3 wait for you">
      <Inbox />
    </Demo>
  );
}

export function Focused() {
  return (
    <Demo
      side="right"
      icon="inbox"
      title="Inbox"
      detail="3 wait for you"
      caption="Press Tab to reach the button and Enter to open the panel: focus lands on Close. Tab moves to the body, then Mark all read, each with the focus ring; Shift+Tab goes back and Escape closes it."
    >
      <Inbox />
    </Demo>
  );
}

export function Left() {
  return (
    <Demo side="left" icon="pulse" title="Services" detail="5 sources">
      <p style={{ margin: 0 }}>Daemon, Slack, GitHub, Spur and Jira.</p>
    </Demo>
  );
}

export function LiveBar() {
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  return (
    <div
      className={quiet}
      style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Click Services in the bar: the left panel opens and the bar stays live, so a second click
        closes it. Tab stays inside the panel; Escape and Close close it too.
      </p>
      <div
        ref={bar}
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          padding: 'var(--space-2)',
          border: 'var(--size-hairline) solid var(--color-border-default)',
        }}
      >
        <Button
          expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          Services
        </Button>
      </div>
      <SidePanel
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        side="left"
        icon="pulse"
        title="Services"
        detail="5 sources"
        keepLive={bar}
      >
        <p style={{ margin: 0 }}>Daemon, Slack, GitHub, Spur and Jira.</p>
      </SidePanel>
    </div>
  );
}
