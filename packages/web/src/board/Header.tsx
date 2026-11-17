import { useEffect, useId, useRef, useState } from 'react';
import { Button, Chip, Icon, Logo, StatusDot, TextInput, type StatusDotTone } from '../ds/index.ts';
import { openHref, type BoardProject } from './model.ts';
import styles from './Header.module.css';

/**
 * Project switcher: a ds Button disclosing a plain list of projects. Escape, an outside
 * pointerdown, focus moving to an element outside it and a history move close it; Escape and a
 * choice return focus to the trigger, which ds Button reaches only through this wrapper. The
 * history move matters because a panel can open from the address while the list is open.
 */
function Switcher({
  projects,
  project,
  onChoose,
}: {
  projects: readonly BoardProject[] | undefined;
  project: BoardProject | undefined;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const listId = useId();
  const focusTrigger = () => wrapper.current?.querySelector('button')?.focus();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrapper.current?.contains(event.target))
        setOpen(false);
    };
    const close = () => {
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('popstate', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('popstate', close);
    };
  }, [open]);
  return (
    <div
      ref={wrapper}
      className={styles.switcher}
      onBlur={(event) => {
        // Focus that leaves for no element (a click on the list's padding, a window switch)
        // keeps it open; the outside pointerdown covers clicks elsewhere.
        const next = event.relatedTarget;
        if (open && next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        setOpen(false);
        focusTrigger();
      }}
    >
      <Button
        disabled={projects === undefined}
        expanded={open}
        controls={listId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className={styles.label}>
          <span className={styles.id}>{project?.id ?? '–'}</span>
          <Icon name="caret" />
        </span>
      </Button>
      <ul id={listId} className={styles.list} hidden={!open} aria-label="Projects">
        {projects?.map((candidate) => (
          <li key={candidate.id} className={styles.item}>
            <Button
              onClick={() => {
                onChoose(candidate.id);
                setOpen(false);
                focusTrigger();
              }}
            >
              <span className={styles.label}>
                <span className={styles.id}>{candidate.id}</span>
                {` · dispatcher ${candidate.dispatcher.mode}`}
                {candidate.id === project?.id && <Icon name="check" label="current" />}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Board header: logo, switcher, mode, filter, live indicator and the inbox button. */
export function Header({
  projects,
  project,
  onChoose,
  filter,
  onFilter,
  indicator,
  inbox,
}: {
  projects: readonly BoardProject[] | undefined;
  project: BoardProject | undefined;
  onChoose: (id: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  indicator: { tone: StatusDotTone; word: string };
  inbox: number | undefined;
}) {
  const mode = project?.dispatcher.mode;
  return (
    <header className={styles.header}>
      <span className={styles.brand} title="spur-board">
        <Logo label="spur-board" />
      </span>
      <Switcher projects={projects} project={project} onChoose={onChoose} />
      {mode !== undefined && (
        <span className={styles.mode} data-mode={mode} title="Dispatcher mode">
          <StatusDot tone={mode === 'on' ? 'ok' : 'warn'} hollow={mode !== 'on'} />
          dispatcher {mode}
        </span>
      )}
      <div className={styles.filter}>
        <TextInput
          value={filter}
          onChange={onFilter}
          label="Filter tasks"
          placeholder="Task key, session or block id"
          icon="search"
        />
      </div>
      <span className={styles.spacer} />
      <span
        className={styles.live}
        data-tone={indicator.tone}
        title="Live updates"
        aria-live="polite"
      >
        <StatusDot tone={indicator.tone} />
        {indicator.word}
      </span>
      <Button
        onClick={() => {
          history.pushState(null, '', openHref('inbox'));
        }}
      >
        <span className={styles.label}>
          <Icon name="inbox" />
          inbox
          <Chip tone={inbox !== undefined && inbox > 0 ? 'you' : 'default'}>
            {inbox === undefined ? '–' : String(inbox)}
          </Chip>
        </span>
      </Button>
    </header>
  );
}
