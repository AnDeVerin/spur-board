import { useId, useState } from 'react';
import { Button } from '../Button/Button.tsx';
import { SidePanel } from '../SidePanel/SidePanel.tsx';
import { TabPanel, Tabs, type TabItem } from '../Tabs/Tabs.tsx';
import { Modal } from './Modal.tsx';

const views: TabItem[] = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History' },
];

const caption = { margin: 0, color: 'var(--color-text-tertiary)' };

function Lines({ what }: { what: string }) {
  return (
    <>
      {Array.from({ length: 40 }, (_, index) => (
        <p key={index} style={{ margin: 0 }}>{`${what}, line ${String(index + 1)}`}</p>
      ))}
    </>
  );
}

function TaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const [view, setView] = useState('now');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Task 509"
      detail="review · 2h"
      actions={
        <Tabs
          id={id}
          label="Task view"
          variant="underline"
          tabs={views}
          value={view}
          onChange={setView}
        />
      }
    >
      <TabPanel tabsId={id} value={view}>
        <Lines what={view === 'now' ? 'Now' : 'History'} />
      </TabPanel>
    </Modal>
  );
}

export function Default() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={caption}>
        Open it: focus lands on Close, Tab wraps inside, the page behind does not scroll; Escape,
        Close or a scrim click closes it and focus returns to the button.
      </p>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open modal
      </Button>
      <TaskModal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}

export function OverPanel() {
  const [panel, setPanel] = useState(false);
  const [task, setTask] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={caption}>
        Open the inbox, then the task: the modal sits over the panel, the first Escape closes only
        the modal and returns focus into the panel, the second closes the panel.
      </p>
      <Button
        onClick={() => {
          setPanel(true);
        }}
      >
        Open inbox
      </Button>
      <SidePanel
        open={panel}
        onClose={() => {
          setPanel(false);
        }}
        icon="inbox"
        title="Inbox"
        detail="3 wait for you"
      >
        <div>
          <Button
            onClick={() => {
              setTask(true);
            }}
          >
            Open task 509
          </Button>
        </div>
        <TaskModal
          open={task}
          onClose={() => {
            setTask(false);
          }}
        />
      </SidePanel>
    </div>
  );
}
