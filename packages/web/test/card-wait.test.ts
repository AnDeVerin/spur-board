import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import { turnView, waitText } from '../src/board/card.ts';
import type { BoardRow } from '../src/board/model.ts';
import { row, status, turn } from './board-fixtures.ts';

/** The turn of a fixture row parsed as `status.get` returns it. */
function parsedTurn(extra: Record<string, unknown>): BoardRow['turn'] {
  const [parsed] = browserOperations['status.get'].output.parse(
    status([row('ex/repo#7', 'dev', { turn: turn(extra) })]),
  ).tasks;
  if (parsed === undefined) throw new Error('no row');
  return parsed.turn;
}
const NOW = Date.parse('2026-11-15T14:05:00.000Z');
const minutes = (n: number) => new Date(NOW - n * 60_000).toISOString();
const view = (extra: Record<string, unknown>) => turnView(parsedTurn(extra), NOW);
const taken = { taken: { by: 'agent:stand-worker/crew-ada', at: minutes(5) } };

describe('task card turn wait', () => {
  it('a wait keeps the tail wording and adds the wake, reason and full label', () => {
    const wait = { reason: 'a free stand', since: minutes(5), wakesAt: '2026-11-15T08:30:00.000Z' };
    const waiting = 'waiting: a free stand, wakes 08:30';
    expect(view({ ...taken, wait })).toEqual({
      ...view(taken),
      tail: waiting,
      waiting: true,
      wake: 'wakes 08:30',
      reason: 'a free stand',
      label: 'Waiting: a free stand. Wakes 08:30 (now)',
    });
    expect(view(taken)).not.toHaveProperty('waiting');
    expect(view(taken)).not.toHaveProperty('label');
    expect(view({ ...taken, wait, stalledSince: minutes(40) })).not.toHaveProperty('waiting');
    expect(view({ ...taken, wait, stalledSince: minutes(40) })).not.toHaveProperty('label');
    expect(view({ ...taken, wait, stalledSince: minutes(40) })?.tail).toBe('stalled · 40m');
    // Without `now` the label drops the relative wake.
    expect(turnView(parsedTurn({ ...taken, wait }), undefined)).toMatchObject({
      tail: waiting,
      label: 'Waiting: a free stand. Wakes 08:30',
    });
    // Your turn wins over a wait; an operator session that holds it waits like an agent.
    const yours = { addressee: 'operator', taken: { by: 'operator', at: minutes(5) }, wait };
    expect(view(yours)).toEqual(view({ ...yours, wait: undefined }));
    expect(view(yours)).not.toHaveProperty('waiting');
    expect(view(yours)).not.toHaveProperty('label');
    expect(
      view({ addressee: 'operator', taken: { by: 'agent:ops/ops-1', at: minutes(5) }, wait }),
    ).toMatchObject({ kind: 'agent', tail: waiting, waiting: true });
  });

  it('the card line reads wake time first, with the relative wake in the label', () => {
    const waitView = (reason: string) =>
      view({ ...taken, wait: { reason, since: minutes(5), wakesAt: '2026-11-15T14:25:00.000Z' } });
    expect(waitView('a free stand')).toMatchObject({
      tail: 'waiting: a free stand, wakes 14:25',
      wake: 'wakes 14:25',
      reason: 'a free stand',
      label: 'Waiting: a free stand. Wakes 14:25 (in 20m)',
    });
    const long = 'r'.repeat(300);
    expect(waitView(long)).toMatchObject({
      reason: long,
      label: `Waiting: ${long}. Wakes 14:25 (in 20m)`,
    });
    expect(waitView('CI · then QA')).toMatchObject({
      reason: 'CI · then QA',
      label: 'Waiting: CI · then QA. Wakes 14:25 (in 20m)',
    });
    // A whitespace-only reason leaves the reason out.
    const blank = waitView('   ');
    expect(blank).toMatchObject({ wake: 'wakes 14:25', label: 'Waiting. Wakes 14:25 (in 20m)' });
    expect(blank).not.toHaveProperty('reason');
    // The Turn section's wording stays as it was.
    expect(waitText({ reason: 'a free stand', wakesAt: '2026-11-15T14:25:00.000Z' })).toBe(
      'waiting: a free stand, wakes 14:25',
    );
  });
});
