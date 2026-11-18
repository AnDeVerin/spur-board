import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import { nextColumn, whyRows } from '../src/board/task-model.ts';
import { taskGet } from './board-fixtures.ts';

const NOW = Date.parse('2026-11-15T14:00:00.000Z');
const COLUMNS: Parameters<typeof nextColumn>[1] = [
  { id: 'todo' },
  { id: 'dev' },
  { id: 'review' },
  { id: 'done' },
];
const condition = (name: string, state: string, reason: string | null = null) => ({
  condition: name,
  state,
  reason,
});
const gate = (column: string, conditions: unknown[], enabled = true) => ({
  column,
  enabled,
  ok: false,
  blockedIn: null,
  conditions,
});
const base = taskGet();
/** A parsed `task.get` answer; `why` fields and top-level fields override the fixture. */
function task(why: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return browserOperations['task.get'].output.parse({
    ...base,
    turn: null,
    why: { ...base.why, ...why },
    ...extra,
  });
}
const allMet = gate('dev', [condition('pr_open', 'met'), condition('checks_green', 'met')]);

describe('next column', () => {
  const why = (column: string, gates: unknown[]) => task({ column, gates }).why;

  it('shows the next config column only when every condition of why.column is met', () => {
    expect(nextColumn(why('dev', [allMet]), COLUMNS)).toBe('review');
    for (const state of ['waiting', 'failed', 'unchecked']) {
      const gates = [gate('dev', [condition('pr_open', 'met'), condition('checks_green', state)])];
      expect(nextColumn(why('dev', gates), COLUMNS)).toBeUndefined();
    }
    expect(nextColumn(why('dev', []), COLUMNS)).toBeUndefined();
    expect(nextColumn(why('dev', [gate('review', [])]), COLUMNS)).toBeUndefined();
    expect(nextColumn(undefined, COLUMNS)).toBeUndefined();
  });

  it('hides it after the last column and for a column config does not list', () => {
    const doneMet = gate('done', [condition('merged', 'met')]);
    expect(nextColumn(why('done', [doneMet]), COLUMNS)).toBeUndefined();
    const qaMet = gate('qa', [condition('submit_on_head', 'met')]);
    expect(nextColumn(why('qa', [qaMet]), COLUMNS)).toBeUndefined();
  });

  it('shows it for a known gate with no exit conditions', () => {
    expect(nextColumn(why('dev', [gate('dev', [])]), COLUMNS)).toBe('review');
  });

  it('never names a Todo-group column from a Todo-group column', () => {
    const g = (column: string) => why(column, [gate(column, [])]);
    const whole: Parameters<typeof nextColumn>[1] = [
      { id: 'todo', group: 'todo' },
      { id: 'triage', group: 'todo' },
      { id: 'ready-for-dev', group: 'todo' },
      { id: 'dev' },
      { id: 'review' },
      { id: 'done' },
    ];
    for (const column of ['todo', 'triage', 'ready-for-dev'])
      expect(nextColumn(g(column), whole), column).toBe('dev');
    expect(nextColumn(g('dev'), whole)).toBe('review');
    expect(
      whyRows(task({ column: 'triage', gates: [gate('triage', [])] }), whole, NOW).at(-1),
    ).toEqual({ key: 'When triage exit conditions pass', value: '→ dev' });

    const noTriage: Parameters<typeof nextColumn>[1] = [
      { id: 'todo', group: 'todo' },
      { id: 'ready-for-dev', group: 'todo' },
      { id: 'dev' },
      { id: 'done' },
    ];
    for (const column of ['todo', 'ready-for-dev'])
      expect(nextColumn(g(column), noTriage), column).toBe('dev');

    const groupOnly: Parameters<typeof nextColumn>[1] = [
      { id: 'todo', group: 'todo' },
      { id: 'triage', group: 'todo' },
    ];
    for (const column of ['todo', 'triage']) {
      expect(nextColumn(g(column), groupOnly), column).toBeUndefined();
      const value = task({ column, gates: [gate(column, [])] });
      expect(whyRows(value, groupOnly, NOW).filter((row) => row.key.startsWith('When '))).toEqual(
        [],
      );
    }
  });

  it('follows the shadow column in shadow mode', () => {
    const reviewMet = gate('review', [condition('review_on_head', 'met')]);
    const value = task({ column: 'review', dispatcher: 'shadow', gates: [allMet, reviewMet] });
    expect(value.task.column).toBe('dev');
    expect(nextColumn(value.why, COLUMNS)).toBe('done');
  });
});
