import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  actorName,
  age,
  blockParam,
  historyRows,
  historyRuns,
  linkChips,
  taskParam,
  timeInColumn,
  until,
  whyRows,
  whySummary,
} from '../src/board/task-model.ts';
import {
  allMet,
  condition,
  gate,
  historyEvent,
  parsed,
  parsedTask as task,
  row as statusRow,
  status,
  T,
  T_TEXT,
  taskHistory,
} from './board-fixtures.ts';

const NOW = Date.parse('2026-11-15T14:00:00.000Z');
const COLUMNS: Parameters<typeof whyRows>[1] = [
  { id: 'todo' },
  { id: 'dev' },
  { id: 'review' },
  { id: 'done' },
];
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const rows = (value: ReturnType<typeof task>) => whyRows(value, COLUMNS, NOW);

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

  it('labels a Dev failed on checks not red under a checks gate right of Dev', () => {
    const value = task({
      column: 'dev',
      gates: [gate('dev', [condition('checks_not_red', 'failed', 'checks_red')])],
    });
    expect(rows(value)[0]).toEqual({ key: 'Checks not red', value: 'checks red', status: 'fail' });
  });

  it('shows checks green waiting on the external-review checks gate column', () => {
    const value = task({
      column: 'external-review',
      gates: [
        gate('dev', [condition('checks_not_red', 'met')]),
        gate('external-review', [
          condition('checks_green', 'waiting', 'checks_pending'),
          condition('approved', 'met'),
        ]),
      ],
    });
    expect(rows(value)[0]).toEqual({
      key: 'Checks green',
      value: 'checks pending',
      status: 'wait',
    });
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
    expect(
      turnRow({ ...turn, addressee: 'operator', taken: { by: 'operator', at: at(5) } }),
    ).toEqual({ key: 'Open turn T4', value: 'yours · taken · 5m' });
    expect(
      turnRow({ ...turn, addressee: 'operator', taken: { by: 'agent:ops/ops-1', at: at(5) } }),
    ).toEqual({ key: 'Open turn T4', value: 'operator ops-1 · taken · 5m' });
    expect(
      whyRows(task({}, { turn: { ...turn, addressee: 'operator' } }), COLUMNS, NOW, true).find(
        (row) => row.key.startsWith('Open turn'),
      ),
    ).toEqual({ key: 'Open turn T4', value: 'operator · holder unknown', status: 'unchecked' });
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

  it.each([
    [-20, 'in 20m'],
    [-65, 'in 1h 5m'],
    [-120, 'in 2h'],
    [-(2 * 1440 + 30), 'in 2d'],
    [-0.5, 'in 1m'],
    [0, 'now'],
    [10, 'now'],
  ])('a wake %d minutes ago reads %s', (minutes, text) => {
    expect(until(at(minutes), NOW)).toBe(text);
  });

  it('time in column reads the held row entry and is absent without one in the same column', () => {
    const held = (column: string, columnEnteredAt: string | null) =>
      browserOperations['status.get'].output.parse(
        status([statusRow('ex/repo#7', column, { columnEnteredAt })]),
      ).tasks[0];
    // A later correction into the column in why.moves does not move the row's entry time.
    const corrected = task({
      moves: [
        {
          at: at(5),
          kind: 'task_corrected',
          actor: 'operator',
          from: 'todo',
          to: 'dev',
          reason: 'corrected',
          gate: [],
          text: 'Operator correction',
        },
      ],
    });
    expect(timeInColumn(corrected.task.column, held('dev', at(300)), NOW)).toBe('5h');
    expect(timeInColumn('dev', held('dev', null), NOW)).toBeUndefined();
    expect(timeInColumn('dev', undefined, NOW)).toBeUndefined();
    expect(timeInColumn('dev', held('review', at(300)), NOW)).toBeUndefined();
    // With no good status read yet there is no clock to count to, so no time.
    expect(timeInColumn('dev', held('dev', at(300)), undefined)).toBeUndefined();
  });

  it('actor names and the ?open= task param', () => {
    expect(actorName('agent:web/web-7')).toBe('web-7');
    expect(actorName('operator')).toBe('operator');
    expect(taskParam('?open=ex%2Frepo%237')).toBe('ex/repo#7');
    for (const search of [
      '',
      '?open=',
      '?open=inbox',
      '?open=services',
      '?theme=dark',
      '?open=block%3AB5',
      '?open=block:B5',
    ])
      expect(taskParam(search)).toBeNull();
    expect(blockParam('?open=block%3AB5')).toBe('B5');
    expect(blockParam('?open=block:x')).toBe('x');
    expect(blockParam('?open=block:')).toBe('');
    for (const search of ['', '?open=inbox', '?open=ex%2Frepo%237', '?open=B5'])
      expect(blockParam(search)).toBeNull();
  });
});

describe('link chips', () => {
  it('inserts the held current ticket once with the card destination and matching icons', () => {
    const row = parsed().rows.find((entry) => entry.key === 'ex/repo#7');
    if (!row) throw new Error('missing row');
    const held = { ...row, links: { ...row.links, ticket: 'https://observed.test/issue/7' } };
    const links = task().links;
    const chips = linkChips(links, row.key, null, null, held);
    expect(chips.map((chip) => chip.icon)).toEqual(['ticket', 'pr', 'term']);
    expect(chips[0]?.href).toBe(held.links.ticket);
    expect(
      linkChips(
        [
          { kind: 'ticket', ref: row.key, role: null },
          { kind: 'ticket', ref: row.key, role: null },
          ...links,
        ],
        row.key,
        null,
        null,
        held,
      ),
    ).toHaveLength(3);
    expect(
      linkChips([], row.key, null, null, {
        ...held,
        links: { ...held.links, ticket: 'javascript:bad' },
      })[0]?.href,
    ).toBeNull();
    expect(linkChips([], row.key, null, null, row)[0]?.href).toBeNull();
    expect(linkChips([], row.key, null, null, { ...held, key: 'ex/repo#99' })).toEqual([]);
    const jira = { ...held, key: 'ABC-3' };
    expect(linkChips([], jira.key, null, 'https://jira.test/browse/', jira)[0]?.href).toBe(
      'https://jira.test/browse/ABC-3',
    );
  });
  it('groups ticket, pr, session; links GitHub refs, keeps Jira plain without a browse base, sessions plain without an origin', () => {
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
    expect(linkChips(value.links, 'ABC-1', null, null)).toEqual([
      { kind: 'ticket', icon: 'ticket', text: 'ticket ABC-3', href: null, label: undefined },
      {
        text: 'ticket #5',
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://github.com/ex/repo/issues/5',
        label: 'ticket #5, ex/repo',
      },
      {
        text: 'PR #7',
        kind: 'pr',
        icon: 'pr',
        href: 'https://github.com/ex/repo/pull/7',
        label: 'PR #7, ex/repo',
      },
      { kind: 'pr', icon: 'pr', text: 'PR repo#8', href: null, label: undefined },
      { kind: 'session', icon: 'term', text: 'session s1', href: null, label: undefined },
    ]);
  });
  it('links a session to the Spur UI when the origin is set', () => {
    const value = task({}, { links: [{ kind: 'session', ref: 'sb-1234', role: 'worker' }] });
    expect(linkChips(value.links, 'ABC-1', 'https://spur.example', null)).toEqual([
      {
        text: 'session sb-1234',
        kind: 'session',
        icon: 'term',
        href: 'https://spur.example/sessions/sb-1234',
        label: 'session sb-1234, Spur session',
      },
    ]);
  });
  it('links a Jira ticket to the browse base; GitHub tickets and free text keep theirs', () => {
    const ticket = (ref: string) => ({ kind: 'ticket', ref, role: null });
    const value = task(
      {},
      { links: [ticket('ABC-3'), ticket('ex/repo#5'), ticket('repo#6'), ticket('foo bar')] },
    );
    expect(linkChips(value.links, 'ABC-1', null, 'https://j.test/browse/')).toEqual([
      {
        text: 'ticket ABC-3',
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://j.test/browse/ABC-3',
        label: 'ticket ABC-3, Jira',
      },
      {
        text: 'ticket #5',
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://github.com/ex/repo/issues/5',
        label: 'ticket #5, ex/repo',
      },
      { kind: 'ticket', icon: 'ticket', text: 'ticket #6', href: null, label: undefined },
      { kind: 'ticket', icon: 'ticket', text: 'ticket foo bar', href: null, label: undefined },
    ]);
  });
  it.each([
    ['same prefix', 'ABC-3', 'ABC-1', 'https://j.test/browse/', 'https://j.test/browse/ABC-3'],
    ['another project', 'B-2', 'A-1', 'https://j.test/browse/', null],
    [
      'prefix in another case',
      'abc-3',
      'ABC-1',
      'https://j.test/browse/',
      'https://j.test/browse/abc-3',
    ],
    ['a GitHub task', 'ABC-3', 'ex/repo#7', 'https://j.test/browse/', null],
    ['no browse base', 'ABC-3', 'ABC-1', null, null],
    [
      'a GitHub ticket',
      'ex/repo#5',
      'ABC-1',
      'https://j.test/browse/',
      'https://github.com/ex/repo/issues/5',
    ],
  ])('a ticket chip, %s: %s on task %s', (_, ref, taskKey, browseBase, href) => {
    const links = [{ kind: 'ticket' as const, ref, role: null }];
    expect(linkChips(links, taskKey, null, browseBase)[0]?.href).toBe(href);
  });
});

describe('history rows', () => {
  const repeated = (at = T) =>
    historyEvent(at, 'session_facts_changed', 'system', 'Session changed.');
  const runs = (events: ReturnType<typeof historyEvent>[]) =>
    historyRuns(browserOperations['task.history'].read.parse(taskHistory(events)).events);

  it.each([1, 2, 3, 4])('folds only runs of at least three: %s events', (count) => {
    const result = runs(Array.from({ length: count }, () => repeated()));
    expect(result.map((run) => run.rows.length)).toEqual(
      count < 3 ? Array<number>(count).fill(1) : [count],
    );
    expect(result.flatMap((run) => run.rows.map((row) => row.key))).toEqual(
      Array.from({ length: count }, (_, index) => count - index - 1),
    );
  });

  it.each([
    ['kind', { kind: 'future_kind' }],
    ['actor', { actor: 'operator' }],
    ['channel', { via: 'web' }],
    ['summary', { summary: 'Another summary.' }],
  ])('keeps maximal adjacent runs separate at a changed %s', (_, difference) => {
    const result = runs([
      repeated(),
      repeated(),
      repeated(),
      { ...repeated(), ...difference },
      repeated(),
      repeated(),
      repeated(),
    ]);
    expect(result.map((run) => run.rows.map((row) => row.key))).toEqual([
      [6, 5, 4],
      [3],
      [2, 1, 0],
    ]);
  });

  it('compares raw actors even when their displayed names collide', () => {
    const events = ['agent:one/session', 'agent:two/session', 'agent:one/session'].map((actor) => ({
      ...repeated(),
      actor,
    }));
    const result = runs(events);
    expect(result).toHaveLength(3);
    expect(result.flatMap((run) => run.rows.map((row) => row.actor))).toEqual([
      'session',
      'session',
      'session',
    ]);
  });

  it('retains the oldest position when a newer match joins, and formats oldest UTC time', () => {
    const events = [
      repeated('2026-11-15T23:58:00Z'),
      repeated('2026-11-16T00:01:00Z'),
      repeated('2026-11-16T00:02:00Z'),
    ];
    expect(runs(events)[0]).toMatchObject({ key: 0, since: '23:58 15/11/26' });
    const appended = runs([...events, repeated('2026-11-16T00:03:00Z')]);
    expect(appended[0]).toMatchObject({ key: 0, since: '23:58 15/11/26' });
    expect(appended[0]?.rows).toHaveLength(4);
    expect(appended[0]?.rows[0]?.time).toBe('00:03 16/11/26');
    expect(runs(events.slice(1).concat(repeated('2026-11-16T00:03:00Z')))[0]?.since).toBe('00:01');
    expect(runs([])).toEqual([]);
  });

  it.each([
    ['operator', 'web', 'operator (web)'],
    ['operator', 'slack', 'operator (slack)'],
    ['operator', 'carrier', 'operator (carrier)'],
    ['agent:web/web-7', undefined, 'web-7'],
    ['agent:web/web-7', 'slack', 'web-7 (slack)'],
    ['operator', 'cli', 'operator (cli)'],
    ['agent:web/web-7', 'mcp', 'web-7 (mcp)'],
    ['operator', undefined, 'operator'],
    ['system', undefined, 'system'],
  ])('actor %s via %s reads %s', (actor, via, label) => {
    expect(actorLabel(actor, via)).toBe(label);
  });

  it('lists events newest first, equal timestamps in reverse journal order, kinds verbatim', () => {
    const { events } = browserOperations['task.history'].read.parse(taskHistory());
    const rows = historyRows(events);
    expect(rows.map((row) => row.kind)).toEqual([
      'flag_raised',
      'task_moved',
      'block_unblocked',
      'comment_added',
      'turn_closed',
      'turn_taken',
      'turn_opened',
      'task_added',
    ]);
    expect(rows.map((row) => row.key)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(rows.at(-1)).toEqual({
      key: 0,
      time: T_TEXT,
      summary: 'Added to Dev.',
      actor: 'operator',
      kind: 'task_added',
    });
    expect(rows[2]?.actor).toBe('operator (slack)');
    expect(rows[3]?.actor).toBe('operator (web)');
    expect(rows[5]).toMatchObject({ time: '14:42 15/11/26', actor: 'web-7', kind: 'turn_taken' });
    expect(historyRows([])).toEqual([]);
    const unknown = browserOperations['task.history'].read.parse(
      taskHistory([historyEvent(T, 'future_kind', 'system', 'Something new.')]),
    ).events;
    expect(historyRows(unknown)[0]).toMatchObject({ kind: 'future_kind' });
  });
});
