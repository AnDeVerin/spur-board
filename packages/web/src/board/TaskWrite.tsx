import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banner, Button, FormRow, IconButton, TextArea } from '../ds/index.ts';
import type { BoardData } from './data.ts';
import styles from './TaskView.module.css';

const TEXTS = {
  answer: { submit: 'Send answer', success: 'Answer sent.' },
  followup: { submit: 'Send follow-up', success: 'Follow-up sent.' },
  comment: { submit: 'Add comment', success: 'Comment added.' },
} as const;
/** The follow-up form's Cancel inside its wrapper. */
const cancelIn = (root: HTMLElement | null) =>
  root?.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]') ?? undefined;

/**
 * Each caller keeps its draft and retry intent through canonical data refreshes. A `followup`
 * starts closed as a `Follow up` button; its form closes on Cancel or once a send is reread.
 * `superseded` hides an answer's `sent` line while idle. `onHeldChange` hears whether the writer
 * holds text or a send its block must keep in view: a draft, a retained draft, an open follow-up
 * form or a send in flight. It is called only when that answer changes.
 */
export function TaskWrite({
  label,
  kind,
  eligible = true,
  unavailable,
  createIntent,
  refreshTask,
  onOpen,
  superseded = false,
  onHeldChange,
  drafts,
  draftId,
  subject = 'task',
}: {
  label: string;
  kind: 'answer' | 'followup' | 'comment';
  eligible?: boolean;
  unavailable: string | undefined;
  createIntent: (text: string) => ReturnType<BoardData['commentIntent']>;
  refreshTask: BoardData['refreshTask'];
  onOpen?: () => void;
  superseded?: boolean;
  onHeldChange?: ((held: boolean) => void) | undefined;
  /** Where the unsent text is kept across a reload after a board update. */
  drafts: BoardData['drafts'];
  draftId: string;
  /** What a confirmed send re-reads, named in the refresh texts. */
  subject?: 'task' | 'block' | undefined;
}) {
  const followUp = kind === 'followup';
  // Text kept across a reload comes back as unsent text, without its send's key.
  const [restored] = useState(() => drafts.restored(draftId));
  const [draft, setDraft] = useState(restored ?? '');
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(!followUp || restored !== undefined);
  const revision = useRef(0);
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'sending' | 'refreshing' | 'refresh-failed'>('idle');
  const busy = useRef(false);
  const confirmed = useRef(false);
  const mounted = useRef(true);
  const intent = useRef<
    { text: string; value: ReturnType<BoardData['commentIntent']> } | undefined
  >(undefined);
  // The follow-up's wrapper; focus moves inside it only after the commit that renders the target.
  const area = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<'field' | 'trigger'>(undefined);
  const focusAtSubmit = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    const field = area.current?.querySelector('textarea');
    (target === 'trigger'
      ? area.current?.querySelector('button')
      : field && !field.disabled
        ? field
        : cancelIn(area.current)
    )?.focus();
  });
  useLayoutEffect(() => {
    const cancel = cancelIn(area.current);
    if (unavailable === undefined || !cancel || cancel.disabled) return;
    if (area.current?.contains(document.activeElement)) cancel.focus();
  }, [unavailable]);
  const reconcile = async (refresh: Promise<boolean>, submittedRevision: number) => {
    const ok = await refresh;
    if (!mounted.current) return;
    if (!ok) {
      setPhase('refresh-failed');
      return;
    }
    if (revision.current === submittedRevision) {
      setDraft('');
      if (followUp) {
        if (focusAtSubmit.current && area.current?.contains(document.activeElement))
          pendingFocus.current = 'trigger';
        setOpen(false);
      }
    }
    confirmed.current = false;
    busy.current = false;
    intent.current = undefined;
    setPhase('idle');
  };
  const submittedRevision = useRef(0);
  const status =
    sent && !(superseded && phase === 'idle')
      ? `${TEXTS[kind].success}${phase === 'refreshing' ? ` Refreshing ${subject}…` : phase === 'refresh-failed' ? ` Could not refresh the ${subject}.` : ''}`
      : !eligible && phase === 'sending'
        ? 'Sending answer…'
        : undefined;
  const feedback = (
    <>
      {status && (
        <p role="status" className={styles.feedback}>
          {status}
        </p>
      )}
      {phase === 'refresh-failed' && (
        <Button
          onClick={() => {
            setPhase('refreshing');
            void reconcile(refreshTask(), submittedRevision.current);
          }}
        >
          Refresh {subject}
        </Button>
      )}
    </>
  );
  const unsent =
    draft !== '' &&
    (intent.current === undefined || revision.current !== submittedRevision.current);
  const unconfirmed = draft !== '' && !sent && !unsent;
  const held =
    phase !== 'idle' || (followUp && open) || (eligible ? draft !== '' : unsent || unconfirmed);
  const reportedHeld = useRef(false);
  useLayoutEffect(() => {
    if (reportedHeld.current === held) return;
    reportedHeld.current = held;
    onHeldChange?.(held);
  });
  // Only stores into the board's draft map; it publishes only when a deferred reload fires.
  useLayoutEffect(() => {
    drafts.report(draftId, {
      text: unsent || unconfirmed ? draft : '',
      busy: phase === 'sending' || phase === 'refreshing',
    });
  });
  useLayoutEffect(
    () => () => {
      drafts.release(draftId);
    },
    [drafts, draftId],
  );
  if (!eligible) {
    return (
      <>
        {(unsent || unconfirmed) && (
          <section aria-label={`Retained draft: ${label}`}>
            <strong>{unsent ? 'Unsent answer draft' : 'Answer draft (unconfirmed)'}</strong>
            <p className={styles.text}>{draft}</p>
            <p className={styles.feedback}>
              {unsent
                ? 'Answering is no longer available for this block. Copy this text before closing.'
                : 'The send is pending or its outcome is unknown. Copy this text before closing.'}
            </p>
          </section>
        )}
        {error && (
          <Banner variant="error" icon="x">
            {error}
          </Banner>
        )}
        {feedback}
      </>
    );
  }
  if (!open)
    return (
      <div ref={area}>
        <Button
          onClick={() => {
            setSent(false);
            setOpen(true);
            pendingFocus.current = 'field';
            onOpen?.();
          }}
        >
          Follow up
        </Button>
        {feedback}
      </div>
    );
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || confirmed.current || unavailable) return;
        if (!draft.trim() || draft.length > 20_000) {
          setError(
            !draft.trim()
              ? 'Enter text before sending.'
              : 'Text must be 20,000 characters or fewer.',
          );
          return;
        }
        busy.current = true;
        submittedRevision.current = revision.current;
        focusAtSubmit.current = area.current?.contains(document.activeElement) ?? false;
        if (intent.current?.text !== draft)
          intent.current = { text: draft, value: createIntent(draft) };
        setSent(false);
        setPhase('sending');
        setError(undefined);
        void intent.current.value.run().then(
          (result) => {
            if (!mounted.current) return;
            confirmed.current = true;
            setSent(true);
            setPhase('refreshing');
            void reconcile(result.refresh, submittedRevision.current);
          },
          (cause: unknown) => {
            if (!mounted.current) return;
            busy.current = false;
            setPhase('idle');
            setError(cause instanceof Error ? cause.message : 'Could not send. Retry your text.');
          },
        );
      }}
    >
      <FormRow
        label={label}
        error={error === undefined ? undefined : `${error}${unavailable ? ` ${unavailable}` : ''}`}
        hint={unavailable}
        actions={
          <>
            <Button
              type="submit"
              variant={kind === 'comment' ? 'outlined' : 'primary'}
              disabled={unavailable !== undefined}
              busy={phase !== 'idle'}
            >
              {phase === 'sending' ? 'Sending' : TEXTS[kind].submit}
            </Button>
            {followUp && (
              <IconButton
                icon="x"
                size="control"
                label="Cancel"
                disabled={phase !== 'idle'}
                onClick={() => {
                  // A failed send keeps its text, error and key, so an unchanged resend after
                  // reopening cannot post a landed follow-up twice.
                  if (intent.current === undefined) {
                    setDraft('');
                    setError(undefined);
                  }
                  setSent(false);
                  setOpen(false);
                  pendingFocus.current = 'trigger';
                }}
              />
            )}
          </>
        }
      >
        <TextArea
          value={draft}
          onChange={(text) => {
            revision.current++;
            setDraft(text);
            setError(undefined);
          }}
          disabled={unavailable !== undefined}
        />
      </FormRow>
      {feedback}
    </form>
  );
  return followUp ? <div ref={area}>{form}</div> : form;
}
