// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { movedKeys, ORDER_TINT_MS, sameOrder } from '../src/board/ColumnOrder.tsx';
import { envelope, hello, status, type Daemon } from './board-fixtures.ts';
import { all, mountEachTest, settle } from './board-harness.ts';
import { link, wrap } from './board-move-helpers.ts';
import {
  A,
  B,
  C,
  drag,
  gate,
  keysOf,
  layout,
  list,
  manualBoard,
  MANUAL,
  placed,
  step,
} from './board-order-helpers.ts';

mountEachTest();

const tinted = () => all('main [data-moved]').map((item) => item.getAttribute('data-key'));
/** A stream `invalidate` of project `a`, then the 400 ms debounce and the reads it starts. */
async function invalidate(d: Daemon) {
  d.send(`event: invalidate\ndata: ${JSON.stringify({ projects: ['a'], tasks: [] })}\n\n`);
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(400));
  await settle();
}
/** A Manual board on the stream with fake timers; `hold()` holds the next status read. */
async function streamBoard() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let current = placed([A, B, C]);
  let held: ReturnType<typeof gate> | undefined;
  const mounted = await manualBoard([A, B, C], MANUAL, (d) => {
    d.routes['status.get'] = () => {
      // The read answers the rows of its own time, whenever it is let go.
      const rows = current;
      const wait = held?.opened ?? Promise.resolve();
      held = undefined;
      return wait.then(() => envelope(status(rows)));
    };
  });
  mounted.d.send(hello);
  await settle();
  return {
    ...mounted,
    order: (keys: readonly string[]) => {
      current = placed(keys);
    },
    hold: () => {
      held = gate();
      return held;
    },
  };
}

describe('manual order from elsewhere', () => {
  it("another viewer's reorder rearranges and tints the moved card", async () => {
    const { d, order } = await streamBoard();
    expect(tinted()).toEqual([]);
    order([C, A, B]);
    await invalidate(d);
    expect(keysOf('todo')).toEqual([C, A, B]);
    expect(tinted()).toEqual([C]);
    expect(wrap(C).textContent).toContain('moved by operator');
    expect(wrap(A).textContent).not.toContain('moved by operator');
    await act(() => vi.advanceTimersByTimeAsync(ORDER_TINT_MS));
    expect(tinted()).toEqual([]);
    expect(wrap(C).textContent).not.toContain('moved by operator');
  });

  it('an adjacent swap from elsewhere tints the card that moved up', async () => {
    const { d, order } = await streamBoard();
    order([B, A, C]);
    await invalidate(d);
    expect(tinted()).toEqual([B]);
  });

  it('an own drop gets no tint', async () => {
    const { orders, order } = await streamBoard();
    layout(list('todo'));
    order([C, A, B]);
    drag(link(C), 'dragstart');
    drag(list('todo'), 'dragover', 10);
    drag(list('todo'), 'drop', 10);
    drag(link(C), 'dragend');
    await settle();
    expect(orders).toHaveLength(1);
    expect(keysOf('todo')).toEqual([C, A, B]);
    expect(tinted()).toEqual([]);
  });

  it('an own Alt+Down with a status read in flight gets no tint', async () => {
    const { d, orders, order, hold } = await streamBoard();
    const held = hold();
    await invalidate(d);
    step(A, 'ArrowDown');
    await settle();
    expect(orders).toHaveLength(1);
    // The trailing read, issued after the confirm, shows the move.
    order([B, A, C]);
    held.open();
    await settle();
    expect(keysOf('todo')).toEqual([B, A, C]);
    expect(tinted()).toEqual([]);
    expect(all('main [data-pending]')).toHaveLength(0);
  });

  it('the lock releases after a concurrent reorder', async () => {
    const { orders, order } = await streamBoard();
    // The read after the confirm shows A one step down and C moved to the top elsewhere.
    order([C, B, A]);
    step(A, 'ArrowDown');
    await settle();
    expect(keysOf('todo')).toEqual([C, B, A]);
    expect(tinted()).toEqual([C]);
    expect(wrap(A).hasAttribute('data-pending')).toBe(false);
    step(A, 'ArrowUp');
    expect(orders.map((body) => body.input)).toEqual([
      { mode: 'after', task: A, anchor: B },
      { mode: 'before', task: A, anchor: B },
    ]);
  });
});

describe('movedKeys', () => {
  it('excludes first and breaks ties upward', () => {
    expect(movedKeys(['a', 'b', 'c'], ['b', 'a', 'c'], new Set())).toEqual(new Set(['b']));
    expect(movedKeys(['a', 'b', 'c'], ['b', 'a', 'c'], new Set(['a']))).toEqual(new Set());
    expect(movedKeys(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'], new Set())).toEqual(
      new Set(['d']),
    );
    expect(movedKeys(['a', 'b', 'c', 'd'], ['c', 'd', 'a', 'b'], new Set())).toEqual(
      new Set(['c', 'd']),
    );
    expect(movedKeys(['a', 'b'], ['b', 'c'], new Set())).toEqual(new Set());
    expect(movedKeys([], ['a'], new Set())).toEqual(new Set());
  });
});

describe('sameOrder', () => {
  it.each([
    [[], [], true],
    [['a', 'b'], ['a', 'b'], true],
    [['a', 'b'], ['b', 'a'], false],
    [['a', 'b'], ['a', 'b', 'c'], false],
    [['a', 'b', 'c'], ['a', 'b'], false],
    [['a'], ['b'], false],
  ])('%j and %j: %s', (before, after, same) => {
    expect(sameOrder(before, after)).toBe(same);
  });
});
