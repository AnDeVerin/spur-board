import { useState, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { SidePanel, type SidePanelSide } from './SidePanel.tsx';

function Demo({
  side,
  icon,
  title,
  detail,
  children,
}: {
  side: SidePanelSide;
  icon: IconName;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        {`Open it: the ${side} panel and its scrim sit between the header band and the status bar band; those bands stay undimmed but inert, so a click or Tab there reaches nothing. At the narrow breakpoint it fills the screen.`}
      </p>
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

export function Right() {
  return (
    <Demo side="right" icon="inbox" title="Inbox" detail="3 wait for you">
      <div>
        <Button>Mark all read</Button>
      </div>
      <div>
        {Array.from({ length: 40 }, (_, index) => (
          <p key={index} style={{ margin: 0 }}>{`Inbox item, line ${String(index + 1)}`}</p>
        ))}
      </div>
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
