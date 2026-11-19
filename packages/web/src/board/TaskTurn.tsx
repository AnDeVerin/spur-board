import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  CollapsibleSection,
  focusRing,
  FormRow,
  StatusDot,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
} from '../ds/index.ts';
import { ProblemError } from '../lib/api.ts';
import type { BoardConfig, BoardData, BoardTask } from './data.ts';
import type { BoardColumnConfig, BoardRow } from './model.ts';
import { actorDisplayName, age } from './task-model.ts';
import type { TurnIntent, TurnPhase } from './turn-intent.ts';
import {
  ARCHIVED,
  BASES,
  BASIS_ID,
  boundSummary,
  closedDetail,
  closedNotice,
  commitDefault,
  isBasis,
  NOTE,
  openSummary,
  orchestrated,
  PHASE,
  reasonError,
  RETURNABLE,
  shaError,
  submitConfirmation,
  UNAVAILABLE,
  STALE,
  type Basis,
} from './turn-model.ts';
import styles from './TaskTurn.module.css';

type Turn = NonNullable<BoardTask['turn']>;
type Form = 'submit' | 'return';
type FieldErrors = Partial<Record<'sha' | 'from' | 'reason', string | undefined>>;
/** The turn a form opened on; the section keeps it until a form opens on a newer turn. */
interface Bound {
  turn: Turn;
  /**
   * This section closed it, by a submit or a return. `column` is the task's column in the write's
   * answer: the line names it only while the current read still shows the turn open, and the
   * read's column once the read shows the close.
   */
  own: { outcome: 'submitted' | 'returned'; column: string } | undefined;
  /** A write answered that the turn is closed, whatever the last read says. */
  refusedClosed: boolean;
}

/**
 * The Turn section of the task view: the open orchestrator turn, which the operator can take and
 * submit or return to Dev. A form binds to the turn it opened on; when that turn closes elsewhere
 * the section says how, and who closed it for a submit or a return. Renders nothing without an
 * orchestrator turn or a bound one.
 */
export function TaskTurn({
  value,
  taskKey,
  row,
  columns,
  config,
  now,
  unavailable,
  submitTurnIntent,
  returnTurnIntent,
}: {
  value: BoardTask;
  /** The key the task view opened, which its writes are bound to. */
  taskKey: string;
  row: BoardRow | undefined;
  columns: readonly BoardColumnConfig[];
  config: BoardConfig | undefined;
  now: number;
  /** Why the board cannot send now; undefined while it can. */
  unavailable: string | undefined;
  submitTurnIntent: BoardData['submitTurnIntent'];
  returnTurnIntent: BoardData['returnTurnIntent'];
}) {
  const [bound, setBound] = useState<Bound>();
  const [form, setForm] = useState<Form>();
  const [sha, setSha] = useState('');
  const [basis, setBasis] = useState<Basis>('tested');
  const [from, setFrom] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [refusal, setRefusal] = useState<string>();
  const [phase, setPhase] = useState<TurnPhase | 'idle'>('idle');
  // The re-read after a take or a close failed: the section claims no holder until a read answers.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
  }, [value]);
  const intent = useRef<{ signature: string; value: TurnIntent }>(undefined);
  const mounted = useRef(true);
  const actions = useRef<HTMLSpanElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const cancelRow = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const newerActions = useRef<HTMLSpanElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<'field' | Form | 'status'>(undefined);
  /** The form control that last lost focus to nothing; disabled, the browser left focus on the body. */
  const lostFocus = useRef<(Element & { disabled?: boolean }) | null>(null);
  // A native listener: React ignores the blur a control fires while React's commit disables it.
  const watchForm = useCallback((node: HTMLFormElement | null) => {
    formRef.current = node;
    if (node === null) return;
    const out = (event: FocusEvent) => {
      lostFocus.current =
        event.relatedTarget === null && event.target instanceof Element ? event.target : null;
    };
    const into = () => {
      lostFocus.current = null;
    };
    node.addEventListener('focusout', out);
    node.addEventListener('focusin', into);
    return () => {
      node.removeEventListener('focusout', out);
      node.removeEventListener('focusin', into);
      formRef.current = null;
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = orchestrated(value.turn);
  const inFlight = phase !== 'idle';
  const boundOpen = bound !== undefined && !bound.refusedClosed && open?.id === bound.turn.id;
  const closed = bound !== undefined && !boundOpen && !inFlight;
  const blocked =
    value.task.membership === 'archived'
      ? ARCHIVED
      : unavailable === undefined
        ? undefined
        : UNAVAILABLE;
  const sendOff = closed || blocked !== undefined || stale;
  const fieldsOff = inFlight || sendOff;
  /** An open turn other than the bound one: the next turn a close opened. */
  const newer =
    bound !== undefined && open !== undefined && open.id !== bound.turn.id ? open : undefined;

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    if (target === 'field') formRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
    else if (target === 'status') {
      if (statusRef.current?.closest('[hidden]') === null) statusRef.current.focus();
    } else {
      // Cancel goes back to the opening action; once its turn closed elsewhere that action is
      // disabled, so focus goes to the newer turn's first action, else to the closed notice.
      const usable = (button: HTMLButtonElement | null | undefined) =>
        button && !button.disabled ? button : undefined;
      (
        usable(actions.current?.querySelectorAll('button')[target === 'submit' ? 0 : 1]) ??
        usable(newerActions.current?.querySelector('button')) ??
        noticeRef.current
      )?.focus();
    }
  });
  useLayoutEffect(() => {
    const lost = lostFocus.current?.disabled === true;
    lostFocus.current = null;
    if (!sendOff && !inFlight) return;
    // Chrome blurs a focused control as it becomes disabled, before this effect runs. Focus goes
    // to Cancel once the turn cannot be sent, else to the busy primary button.
    if (lost || formRef.current?.contains(document.activeElement))
      cancelRow.current?.querySelectorAll('button')[sendOff ? 1 : 0]?.focus();
  }, [sendOff, inFlight]);

  if (open === undefined && bound === undefined) return null;
  const record = bound && value.turns?.find((turn) => turn.id === bound.turn.id);
  const name = (actor: string) => actorDisplayName(actor, config);
  const executor = (column: string) => {
    const entry = columns.find((candidate) => candidate.id === column)?.executor;
    if (entry === undefined) return undefined;
    return entry.name === null ? entry.kind : `${entry.kind} ${entry.name}`;
  };
  const outcome = record?.closed?.outcome;
  const closer =
    outcome === 'submitted' || outcome === 'returned'
      ? record?.taken
        ? name(record.taken.by)
        : 'the board'
      : undefined;

  const start = (next: Form, turn: Turn) => {
    setBound({ turn, own: undefined, refusedClosed: false });
    setSha(commitDefault(row, value.why, turn.id));
    setBasis('tested');
    setFrom('');
    setReason('');
    setErrors({});
    setRefusal(undefined);
    intent.current = undefined;
    setForm(next);
    pendingFocus.current = 'field';
  };
  const cancel = () => {
    if (form !== undefined) pendingFocus.current = form;
    setForm(undefined);
    setErrors({});
    setRefusal(undefined);
    intent.current = undefined;
  };
  const send = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (inFlight || !bound || !boundOpen || blocked !== undefined || !form) return;
    const commit = sha.trim();
    const source = from.trim();
    const found: FieldErrors =
      form === 'submit'
        ? {
            sha: shaError(commit, 'the commit you tested'),
            from:
              basis === 'carried'
                ? shaError(source, 'the commit the tested work comes from')
                : undefined,
            reason: basis === 'tested' ? undefined : reasonError(reason, 2000),
          }
        : { reason: reasonError(reason, 20_000) };
    setErrors(found);
    if (Object.values(found).some((error) => error !== undefined)) return;
    const input = {
      sha: commit,
      basis,
      ...(basis === 'carried' ? { from: source } : {}),
      ...(basis === 'tested' ? {} : { reason }),
    };
    const turn = bound.turn;
    const signature = JSON.stringify(form === 'submit' ? [form, input] : [form, reason]);
    if (intent.current?.signature !== signature)
      intent.current = {
        signature,
        value:
          form === 'submit'
            ? submitTurnIntent(taskKey, turn.id, input)
            : returnTurnIntent(taskKey, turn.id, reason),
      };
    const sent = intent.current.value;
    setRefusal(undefined);
    const watch = (refresh: Promise<boolean>) => {
      void refresh.then((read) => {
        if (!read && mounted.current) setStale(true);
      });
    };
    let closing = false;
    void sent
      .run((next) => {
        closing ||= next === 'closing';
        setPhase(next);
      })
      .then(
        (done) => {
          if (!mounted.current) return;
          setPhase('idle');
          setForm(undefined);
          const outcome = form === 'submit' ? 'submitted' : 'returned';
          setBound({ turn, own: { outcome, column: done.column }, refusedClosed: false });
          pendingFocus.current = 'status';
          watch(done.refresh);
        },
        (cause: unknown) => {
          if (!mounted.current) return;
          setPhase('idle');
          if (
            cause instanceof ProblemError &&
            (cause.code === 'turn_closed' || cause.code === 'not_found')
          ) {
            setBound((current) =>
              current?.turn.id === turn.id ? { ...current, refusedClosed: true } : current,
            );
            watch(sent.refresh());
            return;
          }
          setRefusal(
            cause instanceof Error ? cause.message : 'Could not close the turn. Try again.',
          );
          // The take landed (or was already held) before the close was refused: the read then
          // says who holds the turn.
          if (closing) watch(sent.refresh());
        },
      );
  };
  const edit = (set: (text: string) => void, field: keyof FieldErrors) => (text: string) => {
    set(text);
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const line = (turn: Turn, state: string, buttons: ReactNode) => (
    <div className={styles.line}>
      <StatusDot
        tone={stale ? 'unknown' : turn.taken ? 'working' : 'warn'}
        hollow={stale || !turn.taken}
      />
      <span className={styles.id}>{turn.id}</span>
      <span>{[turn.column, executor(turn.column), state].filter(Boolean).join(' · ')}</span>
      {buttons}
    </div>
  );
  const triggers = (turn: Turn, disabled: boolean, primary: boolean) => (
    <span className={styles.actions} ref={primary ? actions : newerActions}>
      <Button
        disabled={disabled}
        onClick={() => {
          start('submit', turn);
        }}
      >
        Submit…
      </Button>
      {RETURNABLE.has(turn.column) && (
        <Button
          disabled={disabled}
          onClick={() => {
            start('return', turn);
          }}
        >
          Return to dev…
        </Button>
      )}
    </span>
  );
  const openBox = (turn: Turn, primary: boolean) => {
    const formOpen = primary && form !== undefined;
    const earlierForm = !primary && form !== undefined;
    return (
      <div className={styles.turn} key={turn.id}>
        {line(
          turn,
          stale
            ? ''
            : turn.taken === null
              ? `not taken · ${age(turn.at, now)}`
              : `taken by ${name(turn.taken.by)} · ${age(turn.taken.at, now)}`,
          !formOpen &&
            triggers(turn, blocked !== undefined || inFlight || earlierForm || stale, primary),
        )}
        {stale && <p className={styles.note}>{STALE}</p>}
        {!stale && turn.taken?.by === 'operator' && (
          <p className={styles.note}>
            You hold {turn.id}; the orchestrator cannot submit or return it until you finish or it
            takes the turn back.
          </p>
        )}
        {!formOpen && !stale && <p className={styles.note}>{NOTE}</p>}
        {blocked !== undefined && <p className={styles.note}>{blocked}</p>}
        {formOpen && formElement(turn)}
      </div>
    );
  };
  const formElement = (turn: Turn) => {
    const reasonRow = (hint: string) => (
      <FormRow label="Reason" hint={hint} error={errors.reason}>
        <TextArea value={reason} onChange={edit(setReason, 'reason')} disabled={fieldsOff} />
      </FormRow>
    );
    return (
      <form
        // One key in the open and the closed box, so a close keeps the form and its focus.
        key="form"
        ref={watchForm}
        className={styles.form}
        aria-busy={inFlight || undefined}
        onSubmit={send}
      >
        {form === 'submit' ? (
          <>
            <FormRow
              label="Commit"
              hint="The head of the PR unless you tested another commit."
              error={errors.sha}
            >
              <TextInput
                value={sha}
                onChange={edit(setSha, 'sha')}
                label="Commit"
                disabled={fieldsOff}
              />
            </FormRow>
            <Tabs
              id={BASIS_ID}
              label="Basis"
              tabs={BASES}
              value={basis}
              onChange={(chosen) => {
                if (fieldsOff || !isBasis(chosen)) return;
                setBasis(chosen);
                setErrors({});
              }}
            />
            <TabPanel tabsId={BASIS_ID} value={basis}>
              {basis === 'tested' ? (
                <p className={styles.note}>
                  Tested on the commit above. No source or reason is needed.
                </p>
              ) : (
                <div className={styles.fields}>
                  {basis === 'carried' && (
                    <FormRow
                      label="Carried from"
                      hint="A commit of this task with a tested submit."
                      error={errors.from}
                    >
                      <TextInput
                        value={from}
                        onChange={edit(setFrom, 'from')}
                        label="Carried from"
                        disabled={fieldsOff}
                      />
                    </FormRow>
                  )}
                  {reasonRow('Required. Shown on the card and in the history.')}
                </div>
              )}
            </TabPanel>
          </>
        ) : (
          reasonRow('Required. The worker reads it as the cause of the return.')
        )}
        {refusal !== undefined && (
          <Banner variant="error" icon="x">
            {refusal}
          </Banner>
        )}
        <p className={styles.confirm}>
          {form === 'submit'
            ? submitConfirmation(turn, columns)
            : `This closes ${turn.id} in your name and returns the task to dev. It cannot be undone, and it counts toward the cycle limit.`}
        </p>
        <div className={styles.buttons} ref={cancelRow}>
          <Button type="submit" variant="primary" disabled={sendOff} busy={inFlight}>
            {inFlight ? PHASE[phase] : form === 'submit' ? 'Submit' : 'Return to dev'}
          </Button>
          <Button disabled={inFlight} onClick={cancel}>
            Cancel
          </Button>
        </div>
        {inFlight && (
          <p role="status" className={styles.status}>
            {PHASE[phase]}…
          </p>
        )}
      </form>
    );
  };
  const closedBox = (entry: Bound) => {
    const { turn, own } = entry;
    return (
      <div className={styles.turn} key={turn.id}>
        {line(turn, 'closed', own === undefined && triggers(turn, true, true))}
        {own !== undefined ? (
          <p
            role="status"
            tabIndex={-1}
            ref={statusRef}
            className={`${styles.status ?? ''} ${focusRing}`}
          >
            {`${turn.id} ${own.outcome === 'submitted' ? 'submitted' : 'returned to dev'}. The task is in ${value.turn?.id === turn.id ? own.column : value.task.column}.`}
          </p>
        ) : (
          <div ref={noticeRef} tabIndex={-1} className={focusRing}>
            <Banner variant="info" icon="check" detail={closedDetail(record, now)}>
              {closedNotice(turn.id, closer, outcome)}
            </Banner>
          </div>
        )}
        {form !== undefined && formElement(turn)}
      </div>
    );
  };

  // While the re-read failed, an open turn's summary names no holder either.
  const openText = (turn: Turn) => (stale ? `${turn.id} · could not refresh` : openSummary(turn));
  const summary = [
    bound
      ? stale && boundOpen && !inFlight && bound.own === undefined
        ? openText(bound.turn)
        : boundSummary(bound.turn.id, {
            inFlight,
            own: bound.own?.outcome,
            open: boundOpen ? open : undefined,
            record,
            refused: refusal !== undefined,
          })
      : open && openText(open),
    newer && openText(newer),
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <CollapsibleSection title="Turn" summary={summary}>
      <div className={styles.turns}>
        {bound === undefined
          ? open && openBox(open, true)
          : bound.own === undefined && (boundOpen || inFlight)
            ? openBox(boundOpen ? open : bound.turn, true)
            : closedBox(bound)}
        {newer && openBox(newer, false)}
      </div>
    </CollapsibleSection>
  );
}
