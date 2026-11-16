import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import {
  actorName,
  age,
  linkChips,
  nextColumn,
  taskParam,
  timeInColumn,
  whyRows,
  whySummary,
} from '../src/board/task-model.ts';
import { taskGet } from './board-fixtures.ts';

const NOW = Date.parse('2026-11-15T14:00:00.000Z');
const COLUMNS = ['todo', 'dev', 'review', 'done'];
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
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
const rows = (value: ReturnType<typeof task>) => whyRows(value, COLUMNS, NOW);
const allMet = gate('dev', [condition('pr_open', 'met'), condition('checks_green', 'met')]);

describe('why rows', () => {
  it.each([
    ['met', null, { key: 'PR open', value: 'met', status: 'pass' }],
    ['failed', 'no_pr', { key: 'PR open', value: 'no PR', status: 'fail' }],
    ['failed', null, { key: 'PR open', value: undefined, status: 'fail' }],
    ['waiting', 'checks_pending', { key: 'PR open', value: 'checks pending', status: 'wait' }],
    ['unchecked', null, { key: 'PR open', status: 'unchecked' }],
  ])('a %s condition (reason %s) maps to %j', (state, reason, row) => {
    const value = task({ gates: [gate('dev', [condition('pr_open', state, reason)])] });
    expect(rows(value)[0]).toEqual(row);
  });

  it('names a condition the prototype map lacks in words', () => {
    const value = task({
      gates: [gate('dev', [condition('comment_history_read', 'met')])],
    });
    expect(rows(value)[0]?.key).toBe('Comment history read');
  });

  it('reads only the gate of why.column', () => {
    const gates = [
      gate('todo', [condition('pr_open', 'failed', 'no_pr')]),
      allMet,
      gate('review', [condition('review_on_head', 'waiting', 'no_review_on_head')]),
      gate('qa', [condition('submit_on_head', 'failed', 'no_submit_on_head')], false),
    ];
    const dev = task({ column: 'dev', gates });
    expect(rows(dev)).toEqual([
      { key: 'PR open', value: 'met', status: 'pass' },
      { key: 'Checks green', value: 'met', status: 'pass' },
      { key: 'Open turn', value: 'none' },
      { key: 'Open blocks', value: 'none', status: 'pass' },
      { key: 'When dev exit conditions pass', value: '→ review' },
    ]);
    expect(whySummary(dev)).toBe('all pass');
    const todo = task({ column: 'todo', gates });
    expect(rows(todo)[0]).toEqual({ key: 'PR open', value: 'no PR', status: 'fail' });
    expect(rows(todo).some((row) => row.key.startsWith('When'))).toBe(false);
    expect(whySummary(todo)).toBe('1 failed');
    const none = task({ column: 'ready-for-dev', gates });
    expect(rows(none)[0]).toEqual({ key: 'Exit conditions unknown', status: 'unchecked' });
    expect(whySummary(none)).toBe('unknown');
  });

  it('gates [] or no why is unknown; a gate without conditions says so and has a next row', () => {
    for (const value of [task({ gates: [] }), task({}, { why: undefined })]) {
      expect(rows(value)[0]).toEqual({ key: 'Exit conditions unknown', status: 'unchecked' });
      expect(rows(value).some((row) => row.key.startsWith('When'))).toBe(false);
      expect(whySummary(value)).toBe('unknown');
    }
    const empty = task({ gates: [gate('dev', [])] });
    expect(rows(empty)[0]).toEqual({ key: 'No exit conditions in dev' });
    expect(rows(empty).at(-1)).toEqual({ key: 'When dev exit conditions pass', value: '→ review' });
    expect(whySummary(empty)).toBe('all pass');
  });

  it('turn row: not taken, taken, the operator, none', () => {
    const turn = {
      id: 'T4',
      column: 'dev',
      addressee: 'worker',
      at: at(129),
      taken: null,
      handed: [],
      closed: null,
    };
    const turnRow = (value: unknown) =>
      rows(task({}, { turn: value })).find((row) => row.key.startsWith('Open turn'));
    expect(turnRow(turn)).toEqual({
      key: 'Open turn T4',
      value: 'worker · not taken · 2h 9m',
      status: 'wait',
    });
    expect(
      turnRow({
        ...turn,
        addressee: 'orchestrator:review',
        taken: { by: 'agent:rev/rev-1', at: at(5) },
      }),
    ).toEqual({ key: 'Open turn T4', value: 'orchestrator rev-1 · taken · 5m' });
    expect(turnRow({ ...turn, addressee: 'operator', at: at(120) })).toEqual({
      key: 'Open turn T4',
      value: 'yours · open · 2h',
      status: 'wait',
    });
    expect(turnRow(null)).toEqual({ key: 'Open turn', value: 'none' });
  });

  it('holds, open blocks and the summary', () => {
    const block = (id: string, state: string) => ({
      id,
      task: 'ex/repo#7',
      type: 'needs_input',
      state,
      author: 'operator',
      addressee: 'worker',
      reason: 'Which?',
      at: at(10),
      outcome: state === 'open' ? null : 'done',
      outcomeReason: null,
      unblockedBy: state === 'open' ? null : 'operator',
      unblockedAt: state === 'open' ? null : at(5),
      answeredVia: null,
    });
    const value = task(
      { holds: ['pr_snapshot_missing'] },
      { blocks: [block('B89', 'open'), block('B90', 'open'), block('B91', 'unblocked')] },
    );
    expect(rows(value)).toContainEqual({
      key: 'Hold',
      value: 'PR snapshot missing',
      status: 'wait',
    });
    expect(rows(value)).toContainEqual({ key: 'Open blocks', value: 'B89, B90', status: 'fail' });
    expect(whySummary(value)).toBe('1 failed · 2 open blocks');
    const one = task({}, { blocks: [block('B89', 'open')] });
    expect(whySummary(one)).toBe('1 failed · 1 open block');
    const waiting = task({
      gates: [gate('dev', [condition('checks_green', 'waiting', 'checks_pending')])],
    });
    expect(whySummary(waiting)).toBe('1 waiting');
  });
});

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

  it('follows the shadow column in shadow mode', () => {
    const reviewMet = gate('review', [condition('review_on_head', 'met')]);
    const value = task({ column: 'review', dispatcher: 'shadow', gates: [allMet, reviewMet] });
    expect(value.task.column).toBe('dev');
    expect(nextColumn(value.why, COLUMNS)).toBe('done');
  });
});

describe('header facts', () => {
  it.each([
    [5, '5m'],
    [120, '2h'],
    [129, '2h 9m'],
    [3 * 1440 + 7, '3d'],
    [-3, '0m'],
  ])('age %d minutes reads %s', (minutes, text) => {
    expect(age(at(minutes), NOW)).toBe(text);
  });

  it('time in column skips shadow moves and is absent without a move into the column', () => {
    const move = (kind: string, to: string, minutesAgo: number) => ({
      at: at(minutesAgo),
      kind,
      actor: 'system',
      from: 'todo',
      to,
      reason: 'gate_passed',
      gate: [],
      text: null,
    });
    const value = task({
      moves: [move('task_moved', 'dev', 300), move('task_shadow_moved', 'dev', 5)],
    });
    expect(timeInColumn(value, NOW)).toBe('5h');
    expect(timeInColumn(task({ moves: [move('task_moved', 'review', 5)] }), NOW)).toBeUndefined();
    expect(timeInColumn(task({}, { why: undefined }), NOW)).toBeUndefined();
  });

  it('actor names and the ?open= task param', () => {
    expect(actorName('agent:web/web-7')).toBe('web-7');
    expect(actorName('operator')).toBe('operator');
    expect(taskParam('?open=ex%2Frepo%237')).toBe('ex/repo#7');
    for (const search of ['', '?open=', '?open=inbox', '?open=services', '?theme=dark'])
      expect(taskParam(search)).toBeNull();
  });
});

describe('link chips', () => {
  it('groups ticket, pr, session; links GitHub refs, keeps Jira plain, sessions plain without an origin', () => {
    const link = (kind: string, ref: string) => ({
      kind,
      ref,
      role: kind === 'session' ? 'worker' : null,
    });
    const value = task(
      {},
      {
        links: [
          link('session', 's1'),
          link('pr', 'ex/repo#7'),
          link('ticket', 'ABC-3'),
          link('pr', 'repo#8'),
          link('ticket', 'ex/repo#5'),
        ],
      },
    );
    expect(linkChips(value.links, null)).toEqual([
      { text: 'ticket ABC-3', href: null, label: undefined },
      {
        text: 'ticket #5',
        href: 'https://github.com/ex/repo/issues/5',
        label: 'ticket #5, ex/repo',
      },
      {
        text: 'PR #7',
        href: 'https://github.com/ex/repo/pull/7',
        label: 'PR #7, ex/repo',
      },
      { text: 'PR repo#8', href: null, label: undefined },
      { text: 'session s1', href: null, label: undefined },
    ]);
  });
  it('links a session to the Spur UI when the origin is set', () => {
    const value = task({}, { links: [{ kind: 'session', ref: 'sb-1234', role: 'worker' }] });
    expect(linkChips(value.links, 'https://spur.example')).toEqual([
      {
        text: 'session sb-1234',
        href: 'https://spur.example/sessions/sb-1234',
        label: 'session sb-1234, Spur session',
      },
    ]);
  });
});
