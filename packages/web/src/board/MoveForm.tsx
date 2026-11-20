import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { Button, FormRow, TextArea } from '../ds/index.ts';
import { ProblemError } from '../lib/api.ts';
import type { BoardData } from './data.ts';
import { openHref, shortKey, type BoardColumn, type BoardRow } from './model.ts';
import styles from './MoveForm.module.css';

type ColumnId = BoardColumn['id'];
type MoveIntent = ReturnType<BoardData['moveIntent']>;

const HINT = 'Required. It goes to the task history.';
const TOO_LONG = 'Reason must be 20,000 characters or fewer.';
const FAILED = 'Could not move the task. Send again to retry.';

/**
 * The reason form of a move to another Backlog part; sending it is the confirmation. A refusal
 * shows the daemon's hint as sent. After the daemon accepts, the send stays busy as `Moving`
 * until the caller closes the form, once a read shows the task in `to`. One intent per reason
 * text: a resend of the same text keeps its key. Cancel closes the form and aborts nothing.
 */
function MoveForm({
  name,
  to,
  createIntent,
  unavailable,
  onSent,
  onCancel,
  view = false,
}: {
  /** The task's short key. */
  name: string;
  to: ColumnId;
  createIntent: (reason: string) => MoveIntent;
  /** Why moves cannot be sent now; undefined while they can. */
  unavailable: string | undefined;
  /** The daemon accepted the move. */
  onSent: () => void;
  onCancel: () => void;
  /** In the task view rather than under a card. */
  view?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<'idle' | 'sending' | 'moving'>('idle');
  const busy = useRef(false);
  const intent = useRef<{ text: string; value: MoveIntent }>(undefined);
  const mounted = useRef(true);
  const area = useRef<HTMLFormElement>(null);
  useEffect(() => {
    mounted.current = true;
    area.current?.querySelector('textarea')?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  const suffix = unavailable === undefined ? '' : ` ${unavailable}`;
  return (
    <form
      ref={area}
      className={view ? styles.view : styles.under}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || unavailable !== undefined || reason.trim() === '') return;
        if (reason.length > 20_000) {
          setError(TOO_LONG);
          return;
        }
        busy.current = true;
        if (intent.current?.text !== reason)
          intent.current = { text: reason, value: createIntent(reason) };
        setPhase('sending');
        setError(undefined);
        intent.current.value.run().then(
          () => {
            if (!mounted.current) return;
            setPhase('moving');
            onSent();
          },
          (cause: unknown) => {
            if (!mounted.current) return;
            busy.current = false;
            setPhase('idle');
            setError(cause instanceof ProblemError ? cause.hint : FAILED);
          },
        );
      }}
    >
      <FormRow
        label={`Move ${name} to ${to}: reason`}
        hint={`${HINT}${suffix}`}
        error={error === undefined ? undefined : `${error}${suffix}`}
        actions={
          <>
            <Button
              type="submit"
              variant="primary"
              busy={phase !== 'idle'}
              disabled={phase === 'idle' && (reason.trim() === '' || unavailable !== undefined)}
            >
              {phase === 'idle' ? `Move to ${to}` : 'Moving'}
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        }
      >
        <TextArea
          value={reason}
          onChange={(text) => {
            setReason(text);
            setError(undefined);
          }}
        />
      </FormRow>
    </form>
  );
}

/** An open move form: from which part to which, and whether the daemon accepted it. */
export interface Moving {
  key: string;
  from: ColumnId;
  to: ColumnId;
  sent: boolean;
}

/**
 * The task view's move: `Move to` and a button per other Backlog part, then the form for the
 * chosen one. The form closes when the task leaves its part; after an accepted move, focus goes
 * to the first part button.
 */
export function TaskMove({
  taskKey,
  name,
  from,
  parts,
  moveIntent,
  unavailable,
}: {
  /** The task's full key, as `task.move` takes it. */
  taskKey: string;
  name: string;
  from: ColumnId;
  /** The other enabled Backlog parts, in config order. */
  parts: readonly ColumnId[];
  moveIntent: BoardData['moveIntent'];
  unavailable: string | undefined;
}) {
  const [moving, setMoving] = useState<Moving | null>(null);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moving === null || moving.from === from) return;
    setMoving(null);
    if (moving.sent) row.current?.querySelector('button')?.focus();
  }, [from, moving]);
  return (
    <>
      <div ref={row} className={styles.row}>
        <span className={styles.label}>Move to</span>
        {parts.map((part) => (
          <Button
            key={part}
            onClick={() => {
              setMoving({ key: taskKey, from, to: part, sent: false });
            }}
          >
            {part}…
          </Button>
        ))}
      </div>
      {moving !== null && (
        <MoveForm
          key={moving.to}
          name={name}
          to={moving.to}
          view
          createIntent={(reason) => moveIntent(taskKey, moving.to, reason)}
          unavailable={unavailable}
          onSent={() => {
            setMoving((open) => (open === null ? open : { ...open, sent: true }));
          }}
          onCancel={() => {
            setMoving(null);
          }}
        />
      )}
    </>
  );
}

/**
 * A Backlog band's move state, shared by its parts: the open reason form, the card in the hand
 * and the part under it.
 */
export interface Band {
  parts: readonly BoardColumn[];
  moving: Moving | null;
  drag: { key: string; from: ColumnId } | null;
  over: ColumnId | null;
  setMoving: (moving: Moving | null) => void;
  setDrag: (drag: { key: string; from: ColumnId } | null) => void;
  setOver: (over: ColumnId | null | ((over: ColumnId | null) => ColumnId | null)) => void;
  /** A drag of this band's card from another part is over `part`. */
  dropping: (part: ColumnId) => boolean;
  moveIntent: BoardData['moveIntent'];
  moveUnavailable: string | undefined;
}

/**
 * The move state of the band in `root`. The form closes once its card leaves its part; when the
 * daemon moved it, the card's link in the target part takes focus.
 */
export function useBand(
  parts: readonly BoardColumn[],
  root: RefObject<HTMLElement | null>,
  moveIntent: BoardData['moveIntent'],
  moveUnavailable: string | undefined,
): Band {
  const [moving, setMoving] = useState<Moving | null>(null);
  const [drag, setDrag] = useState<Band['drag']>(null);
  const [over, setOver] = useState<ColumnId | null>(null);
  const at = moving && parts.find(({ rows }) => rows.some(({ key }) => key === moving.key))?.id;
  useEffect(() => {
    if (moving === null || at === moving.from) return;
    setMoving(null);
    if (!moving.sent || at !== moving.to) return;
    const href = openHref(moving.key);
    [...(root.current?.querySelectorAll<HTMLElement>('a[href]') ?? [])]
      .find((link) => link.getAttribute('href') === href)
      ?.focus();
  }, [at, moving, root]);
  return {
    parts,
    moving,
    drag,
    over,
    setMoving,
    setDrag,
    setOver,
    dropping: (part) => drag !== null && drag.from !== part && over === part,
    moveIntent,
    moveUnavailable,
  };
}

/**
 * The drop zone props of a part: it takes only a card of its band from another part. A drop
 * opens the reason form under the card, which stays in its part until the daemon accepts.
 */
export function zone(band: Band | undefined, part: ColumnId) {
  if (band === undefined) return {};
  const takes = () => band.drag !== null && band.drag.from !== part;
  return {
    'data-drop': band.dropping(part) ? 'part' : undefined,
    onDragOver: (event: DragEvent) => {
      if (!takes()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      band.setOver(part);
    },
    onDragLeave: (event: DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      band.setOver((over) => (over === part ? null : over));
    },
    onDrop: (event: DragEvent) => {
      const { drag } = band;
      if (drag === null || drag.from === part) return;
      event.preventDefault();
      band.setDrag(null);
      band.setOver(null);
      band.setMoving({ key: drag.key, from: drag.from, to: part, sent: false });
    },
  };
}

/** A Backlog card's menu, drag and open form while it sits in `part` of its band. */
export function bandProps(row: BoardRow, band: Band, part: ColumnId) {
  const { moving } = band;
  return {
    moves: {
      items: band.parts
        .filter(({ id }) => id !== part)
        .map(({ id }) => ({ value: id, label: `Move to ${id}…`, group: 'part' })),
      onSelect: (to: ColumnId) => {
        band.setMoving({ key: row.key, from: part, to, sent: false });
      },
    },
    drag: {
      onStart: () => {
        band.setDrag({ key: row.key, from: part });
      },
      onEnd: () => {
        band.setDrag(null);
        band.setOver(null);
      },
      dragging: band.drag?.key === row.key,
    },
    children: moving?.key === row.key && moving.from === part && (
      <MoveForm
        key={moving.to}
        name={shortKey(row.key)}
        to={moving.to}
        createIntent={(reason) => band.moveIntent(row.key, moving.to, reason)}
        unavailable={band.moveUnavailable}
        onSent={() => {
          band.setMoving({ ...moving, sent: true });
        }}
        onCancel={() => {
          band.setMoving(null);
        }}
      />
    ),
  };
}
