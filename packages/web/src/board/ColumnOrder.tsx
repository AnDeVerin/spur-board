import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type DragEvent,
  type ReactNode,
} from 'react';
import { Banner, Button, focusRing, type HoverMenuItem } from '../ds/index.ts';
import type { CardDrag, CardMove, CardMoves, CardOrder } from './Card.tsx';
import type { BoardData } from './data.ts';
import { BoardUnavailableError } from './intents.ts';
import { ProblemError } from '../lib/api.ts';
import { shortKey, sortRows, type BoardColumn, type BoardRow, type ColumnSort } from './model.ts';
import styles from './Columns.module.css';

type OrderIntent = BoardData['orderIntent'];
type OrderInput = Parameters<OrderIntent>[0];
type ColumnId = BoardColumn['id'];

/** How long a card moved elsewhere stays tinted: `--duration-pulse` in `tokens.css`. */
export const ORDER_TINT_MS = 2000;
const PENDING = 'Wait until the Board shows the last reorder.';
const HINT = 'Cards keep the chosen sort. To reorder by hand, ';
const MOVED = 'moved by operator';

/**
 * The reorder that puts `from` into gap `gap` (0 before the first card, `keys.length` after the
 * last) of the manual order `keys`: before the card it lands on, after the one above when it
 * moves down. Nothing at its own place, outside the list or for an unknown key.
 */
function placement(keys: readonly string[], from: string, gap: number): OrderInput | undefined {
  const at = keys.indexOf(from);
  if (at === -1 || gap < 0 || gap > keys.length || gap === at || gap === at + 1) return undefined;
  const anchor = gap < at ? keys[gap] : keys[gap - 1];
  if (anchor === undefined) return undefined;
  return { mode: gap < at ? 'before' : 'after', task: from, anchor };
}

/**
 * The keys that moved between two manual orders: `skip` leaves both orders first, then the keys
 * in both outside the longest run kept in order are moved. Of equal runs the one with the lowest
 * old places is kept, so an adjacent swap names the card that went up. Arrivals and departures
 * never count.
 */
export function movedKeys(
  before: readonly string[],
  after: readonly string[],
  skip: ReadonlySet<string>,
): Set<string> {
  const old = new Map(before.filter((key) => !skip.has(key)).map((key, index) => [key, index]));
  const shared = after.filter((key) => !skip.has(key) && old.has(key));
  const seq = shared.map((key) => old.get(key) ?? 0);
  // longest[i]: the longest increasing run of old places that starts at i.
  const longest = seq.map(() => 1);
  for (let i = seq.length - 1; i >= 0; i--)
    for (let j = i + 1; j < seq.length; j++)
      if ((seq[j] ?? 0) > (seq[i] ?? 0))
        longest[i] = Math.max(longest[i] ?? 1, (longest[j] ?? 1) + 1);
  const kept = new Set<number>();
  let need = Math.max(0, ...longest);
  let at = -1;
  let last = -1;
  for (; need > 0; need--) {
    let best = -1;
    for (let i = at + 1; i < seq.length; i++)
      if (
        longest[i] === need &&
        (seq[i] ?? 0) > last &&
        (best === -1 || (seq[i] ?? 0) < (seq[best] ?? 0))
      )
        best = i;
    kept.add(best);
    last = seq[best] ?? 0;
    at = best;
  }
  return new Set(shared.filter((_, index) => !kept.has(index)));
}

/** Whether two manual orders hold the same keys in the same places: no key moved. */
export function sameOrder(before: readonly string[], after: readonly string[]) {
  return before.length === after.length && before.every((key, index) => key === after[index]);
}

/** The failure line under a column head for a reorder the daemon refused or never took. */
function causeText(cause: unknown) {
  if (cause instanceof ProblemError && cause.code === 'order_anchor_invalid')
    return 'The order changed on the board while you dragged.';
  if (cause instanceof ProblemError && cause.code !== 'unexpected') return cause.message;
  if (cause instanceof BoardUnavailableError) return 'The board is unavailable.';
  return 'The board did not answer.';
}

interface ColumnState {
  /** This tab's reorder from its gesture until the Board shows it; other gestures wait. */
  pending: { key: string } | undefined;
  /** A released reorder's row from the read that released it: no tint while that row shows. */
  released: Map<string, BoardRow>;
  /** The last refused reorder, until Dismiss or a newer refusal in the column. */
  failed: { key: string; cause: string } | undefined;
  /** The card whose drag in Time or Key shows how to reorder, until a drag start or sort change. */
  hint: string | undefined;
  /** The drop line's gap while an own card hovers over the manual list. */
  line: number | undefined;
  /** The hidden status line: where the last own reorder put the card. */
  live: string;
  /** A card link to focus at its next render. */
  refocus: string | undefined;
  /** Cards moved elsewhere, each with the timer that ends its tint. */
  tints: Map<string, ReturnType<typeof setTimeout>>;
  /** The manual order of the last rows seen. */
  order: string[] | undefined;
}
const fresh = (): ColumnState => ({
  pending: undefined,
  released: new Map(),
  failed: undefined,
  hint: undefined,
  line: undefined,
  live: '',
  refocus: undefined,
  tints: new Map(),
  order: undefined,
});

/** Card wrappers of a card list, top to bottom; the gap is before the first below the pointer. */
function gapAt(list: Element, y: number) {
  const wrappers = [...list.children].filter((child) => child.hasAttribute('data-key'));
  const index = wrappers.findIndex((wrapper) => {
    const rect = wrapper.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return index === -1 ? wrappers.length : index;
}

type Handlers = Partial<
  Record<'onDragOver' | 'onDragLeave' | 'onDrop', (event: DragEvent) => void>
>;
/** One element's drop handlers: the band's (`zone`) first, then the order's. */
export function mergeZone<T extends Handlers>(band: T, order: Required<Handlers>) {
  return {
    ...band,
    onDragOver: (event: DragEvent) => {
      band.onDragOver?.(event);
      order.onDragOver(event);
    },
    onDragLeave: (event: DragEvent) => {
      band.onDragLeave?.(event);
      order.onDragLeave(event);
    },
    onDrop: (event: DragEvent) => {
      band.onDrop?.(event);
      order.onDrop(event);
    },
  };
}

/** What `cards()` merges into a card: its order, menu, drag and open form. */
export interface OrderCardProps {
  order: CardOrder | undefined;
  moves: CardMoves | undefined;
  drag: CardDrag;
  children: ReactNode;
}
/** A Backlog card's band props (`bandProps`), as `cards()` passes them. */
interface BandCard {
  moves: { items: readonly HoverMenuItem<ColumnId>[]; onSelect: (part: ColumnId) => void };
  drag: { onStart: () => void; onEnd: () => void; dragging: boolean };
  children: ReactNode;
}

/**
 * The manual order of every column the Board shows, held above the columns so a fold keeps it:
 * drags inside a column, `Alt+Up`/`Alt+Down` and the card menu each send one `task.order`; the
 * column then waits, its card dimmed, until a read shows the result. A reorder seen in a read
 * that this tab did not make tints the moved card for `ORDER_TINT_MS`.
 */
export function useOrders(orderIntent: OrderIntent, columns: readonly BoardColumn[] | undefined) {
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  const store = useRef({
    columns: new Map<string, ColumnState>(),
    drag: null as { key: string; from: ColumnId } | null,
  });
  const state = (id: string) => {
    let found = store.current.columns.get(id);
    if (!found) {
      found = fresh();
      store.current.columns.set(id, found);
    }
    return found;
  };
  const tint = (id: string, key: string) => {
    const tints = state(id).tints;
    clearTimeout(tints.get(key));
    tints.set(
      key,
      setTimeout(() => {
        tints.delete(key);
        bump();
      }, ORDER_TINT_MS),
    );
  };
  // Compare each column's manual order with the last one seen, before the paint.
  useLayoutEffect(() => {
    if (columns === undefined) return;
    let changed = false;
    for (const column of columns) {
      if (column.id === 'done') continue;
      const entry = state(column.id);
      const rows = sortRows(column.rows, 'manual');
      const skip = new Set<string>();
      if (entry.pending) skip.add(entry.pending.key);
      for (const [key, row] of entry.released)
        if (rows.includes(row)) skip.add(key);
        else entry.released.delete(key);
      const now = rows.map((row) => row.key);
      if (entry.order && !sameOrder(entry.order, now))
        for (const key of movedKeys(entry.order, now, skip)) {
          tint(column.id, key);
          changed = true;
        }
      entry.order = now;
    }
    if (changed) bump();
  }, [columns]);
  useEffect(
    () => () => {
      for (const entry of store.current.columns.values())
        for (const timer of entry.tints.values()) clearTimeout(timer);
    },
    [],
  );

  const release = (
    id: string,
    key: string,
    rows: readonly BoardRow[] | undefined,
    step: boolean,
  ) => {
    const entry = state(id);
    entry.pending = undefined;
    const row = rows?.find((item) => item.key === key);
    if (rows && row) {
      entry.released.set(key, row);
      if (row.column === id) {
        const order = sortRows(
          rows.filter((item) => item.column === id),
          'manual',
        );
        entry.live = `${shortKey(key)} moved to ${String(order.indexOf(row) + 1)} of ${String(order.length)}`;
        if (step) entry.refocus = key;
      }
    }
    bump();
  };
  const send = (id: string, input: OrderInput | undefined, step = false) => {
    const entry = state(id);
    if (input === undefined || entry.pending) return;
    entry.pending = { key: input.task };
    entry.line = undefined;
    entry.live = '';
    bump();
    void orderIntent(input)
      .run()
      .then(
        ({ shown }) =>
          shown.then((rows) => {
            release(id, input.task, rows, step);
          }),
        (cause: unknown) => {
          entry.pending = undefined;
          entry.failed = { key: input.task, cause: causeText(cause) };
          bump();
        },
      );
  };
  const clearHints = () => {
    for (const entry of store.current.columns.values()) entry.hint = undefined;
  };

  return {
    /**
     * One column's order: `rows` as shown in `sort`, `setSort` the column's own; `banded` when
     * its cards belong to a Backlog band, which keeps their drag in any sort.
     */
    column({
      id,
      rows,
      sort,
      setSort,
      banded,
    }: {
      id: ColumnId;
      rows: readonly BoardRow[];
      sort: ColumnSort;
      setSort: (sort: ColumnSort) => void;
      banded: boolean;
    }) {
      const entry = state(id);
      const manual = sort === 'manual';
      const keys = rows.map((row) => row.key);
      // Only a drag that started in this column; any other is left to the band's zone.
      const own = () => store.current.drag?.from === id;
      const zone: Required<Handlers> = {
        onDragOver: (event) => {
          if (!own()) return;
          if (!manual) {
            if (entry.hint === undefined) {
              entry.hint = store.current.drag?.key ?? '';
              bump();
            }
            return;
          }
          if (entry.pending) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const gap = gapAt(event.currentTarget, event.clientY);
          if (entry.line !== gap) {
            entry.line = gap;
            bump();
          }
        },
        onDragLeave: (event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          if (entry.line === undefined) return;
          entry.line = undefined;
          bump();
        },
        onDrop: (event) => {
          const drag = store.current.drag;
          if (drag?.from !== id || !manual || entry.pending) return;
          event.preventDefault();
          const gap = gapAt(event.currentTarget, event.clientY);
          entry.line = undefined;
          bump();
          send(id, placement(keys, drag.key, gap));
        },
      };
      const { failed, hint } = entry;
      const dismiss = (key: string, button: HTMLElement) => {
        const section = button.closest('section');
        const card = [...(section?.querySelectorAll('[data-key]') ?? [])].find(
          (item) => item.getAttribute('data-key') === key,
        );
        const target =
          card?.querySelector('a') ?? section?.querySelector('[aria-label^="Sort "] button');
        if (target instanceof HTMLElement) target.focus();
        entry.failed = undefined;
        bump();
      };
      return {
        zone,
        busy: entry.pending !== undefined,
        line: manual ? entry.line : undefined,
        /** Under the column head: the failure until Dismiss, then the hint until its end. */
        notice: (
          <>
            {failed && (
              <div className={styles.notice}>
                <Banner
                  variant="error"
                  icon="back"
                  detail={`${failed.cause} The card stays where it was.`}
                  action={
                    <Button
                      onClick={(event) => {
                        dismiss(failed.key, event.currentTarget);
                      }}
                    >
                      Dismiss
                    </Button>
                  }
                >
                  {shortKey(failed.key)} not moved
                </Banner>
              </div>
            )}
            {hint !== undefined && (
              <p role="status" className={styles.hint}>
                {HINT}
                <button
                  type="button"
                  className={`${styles.hintAction ?? ''} ${focusRing}`}
                  onClick={() => {
                    entry.hint = undefined;
                    entry.refocus = hint;
                    setSort('manual');
                    bump();
                  }}
                >
                  switch to Manual
                </button>
                .
              </p>
            )}
          </>
        ),
        /** The hidden status line of a Manual column, mounted while it shows Manual. */
        live: manual && (
          <p className={styles.hidden} role="status">
            {entry.live}
          </p>
        ),
        /** A sort change ends the column's hint. */
        sorted() {
          if (entry.hint === undefined) return;
          entry.hint = undefined;
          bump();
        },
        /** The order props of card `row`, at `index` of `rows`, merged with its band's. */
        card(row: BoardRow, index: number, band: BandCard | undefined): OrderCardProps {
          const ends = (end: boolean) =>
            entry.pending ? { disabled: true, cause: PENDING } : end ? { disabled: true } : {};
          const items: HoverMenuItem<CardMove>[] = [
            ...(manual
              ? [
                  {
                    value: 'top' as const,
                    label: 'Move to top',
                    group: 'order',
                    ...ends(index === 0),
                  },
                  {
                    value: 'bottom' as const,
                    label: 'Move to bottom',
                    group: 'order',
                    ...ends(index === rows.length - 1),
                  },
                ]
              : []),
            ...(band?.moves.items ?? []),
          ];
          const focus = entry.refocus === row.key;
          return {
            order: manual
              ? {
                  moved: entry.tints.has(row.key) ? MOVED : undefined,
                  pending: entry.pending?.key === row.key,
                  onStep: (step) => {
                    const at = keys.indexOf(row.key);
                    send(id, placement(keys, row.key, step < 0 ? at - 1 : at + 2), true);
                  },
                  focused: focus
                    ? () => {
                        entry.refocus = undefined;
                      }
                    : undefined,
                }
              : undefined,
            moves:
              items.length === 0
                ? undefined
                : {
                    items,
                    onSelect: (value) => {
                      if (value === 'top' || value === 'bottom')
                        send(id, entry.pending ? undefined : { mode: value, task: row.key });
                      else band?.moves.onSelect(value);
                    },
                  },
            drag: {
              onStart: (event) => {
                band?.drag.onStart();
                clearHints();
                if (!manual && !banded) {
                  // Outside a band a Time or Key card has nowhere to go: say how to reorder.
                  event.preventDefault();
                  entry.hint = row.key;
                } else store.current.drag = { key: row.key, from: id };
                bump();
              },
              onEnd: () => {
                band?.drag.onEnd();
                store.current.drag = null;
                entry.line = undefined;
                bump();
              },
              dragging:
                band?.drag.dragging === true || (manual && store.current.drag?.key === row.key),
            },
            children: band?.children,
          };
        },
      };
    },
  };
}
