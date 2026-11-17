import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import {
  age,
  blockMarkers,
  markers,
  prStatus,
  quickLinks,
  returnedMarker,
  sessionChip,
  turnView,
} from '../src/board/card.ts';
import type { BoardRow } from '../src/board/model.ts';
import { prLink, prSummary, row, status, turn } from './board-fixtures.ts';

/** A fixture row parsed as `status.get` returns it. */
function typed(raw: Record<string, unknown>): BoardRow {
  const [parsed] = browserOperations['status.get'].output.parse(status([raw])).tasks;
  if (parsed === undefined) throw new Error('no row');
  return parsed;
}
const card = (extra: Record<string, unknown> = {}) => typed(row('ex/repo#7', 'dev', extra));
const links = (prs: number[], sessions: { id: string }[] = []) => ({
  ticket: null,
  prs: prs.map(prLink),
  sessions,
});
const NOW = Date.parse('2026-11-15T14:05:00.000Z');
const minutes = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe('task card', () => {
  it('turn kind and tone for agent, not taken, operator, stalled and none', () => {
    const view = (extra: Record<string, unknown>) =>
      turnView(card({ turn: turn(extra) }).turn, NOW);
    const taken = { taken: { by: 'agent:stand-worker/crew-ada', at: minutes(5) } };
    expect(view(taken)).toMatchObject({
      kind: 'agent',
      role: 'worker',
      name: 'crew-ada',
      tail: 'taken · 5m',
      tone: 'working',
      hollow: false,
    });
    expect(view({ addressedTo: 'crew-bo' })).toMatchObject({
      kind: 'wait',
      name: 'crew-bo',
      tail: 'not taken · 5m',
      tone: 'warn',
      hollow: true,
    });
    expect(view({})).toMatchObject({ kind: 'wait', name: 'unassigned' });
    expect(view({ addressee: 'operator', column: 'ready-to-merge' })).toMatchObject({
      kind: 'you',
      tail: 'open · 5m',
      tone: 'warn',
      hollow: false,
    });
    expect(view({ ...taken, stalledSince: minutes(40) })).toMatchObject({
      kind: 'stall',
      tail: 'stalled · 40m',
      tone: 'error',
      hollow: false,
    });
    expect(view({ addressee: 'orchestrator:review', column: 'review' })).toMatchObject({
      role: 'orchestrator',
    });
    expect(turnView(card().turn, NOW)).toBeNull();
  });

  it('operator block is a you chip plus +N; agent blocks are a count', () => {
    const block = (id: string, addressee: string) => ({ id, addressee, session: null });
    const blocks = (...list: ReturnType<typeof block>[]) => card({ blocks: list }).blocks;
    expect(
      blockMarkers(blocks(block('B2', 'worker'), block('B5', 'operator'), block('B6', 'curator'))),
    ).toEqual([
      { tone: 'you', icon: 'block', text: 'B5 → you' },
      { tone: 'default', text: '+2', title: 'Other open blocks: B2, B6' },
    ]);
    expect(blockMarkers(blocks(block('B5', 'operator')))).toEqual([
      { tone: 'you', icon: 'block', text: 'B5 → you' },
    ]);
    expect(blockMarkers(blocks(block('B2', 'worker')))).toEqual([
      { tone: 'default', icon: 'block', text: '1 block', title: 'Open blocks: B2' },
    ]);
    expect(blockMarkers(blocks(block('B2', 'worker'), block('B3', 'orchestrator:review')))).toEqual(
      [{ tone: 'default', icon: 'block', text: '2 blocks', title: 'Open blocks: B2, B3' }],
    );
    expect(blockMarkers(blocks())).toEqual([]);
  });

  it('returned shows · N findings, or no number for null', () => {
    const returned = (findings: number | null) =>
      card({
        returned: {
          from: 'review',
          at: '2026-11-15T14:00:00.000Z',
          by: 'agent:stand-qa/crew-qa',
          block: 'B4',
          findings,
        },
      }).returned;
    expect(returnedMarker(returned(5))).toEqual({
      tone: 'warn',
      icon: 'back',
      text: 'returned · 5 findings',
      title: 'Returned from review by crew-qa at 14:00 15/11/26, block B4',
    });
    expect(returnedMarker(returned(null))?.text).toBe('returned');
    expect(returnedMarker(card().returned)).toBeNull();
  });

  it('PR cells: pass muted, fail bad, pending pend, conflict bad, no PR none', () => {
    const cells = (summary: Record<string, unknown>) => {
      const view = prStatus(card({ links: links([1]), prSummary: [prSummary(summary)] }));
      if (view.kind !== 'cells') throw new Error(view.kind);
      return view.cells.map(({ tone, label, icons, text }) => ({ tone, label, icons, text }));
    };
    expect(cells({})).toEqual([
      { tone: 'ok', label: 'Checks: 3 of 3 passed', icons: ['check'], text: '3/3' },
      { tone: 'ok', label: 'Merge: no conflicts', icons: ['merge'], text: '' },
      { tone: 'neutral', label: 'Threads: none', icons: ['bubble'], text: '–' },
      { tone: 'neutral', label: 'Reviews on the head: none', icons: ['person'], text: '–' },
    ]);
    expect(
      cells({
        checks: { pass: 1, fail: 1, pending: 1 },
        mergeable: 'conflicting',
        threads: { unresolved: 2, total: 3 },
        reviewsOnHead: { approved: ['a'], changesRequested: ['b'] },
      }),
    ).toEqual([
      {
        tone: 'bad',
        label: 'Checks: 1 of 3 passed, 1 failed, 1 pending',
        icons: ['x'],
        text: '1/3',
      },
      { tone: 'bad', label: 'Merge: conflicting', icons: ['merge', 'x'], text: '' },
      { tone: 'pend', label: 'Threads: 1 of 3 resolved', icons: ['bubble'], text: '1/3' },
      {
        tone: 'bad',
        label: 'Reviews on the head: 1 changes requested',
        icons: ['person'],
        text: '1',
      },
    ]);
    const pending = cells({
      checks: { pass: 2, fail: 0, pending: 1 },
      mergeable: 'unknown',
      threads: { unresolved: 0, total: 2 },
      reviewsOnHead: { approved: ['a', 'c'], changesRequested: [] },
    });
    expect(pending.map(({ tone, text }) => [tone, text])).toEqual([
      ['pend', '2/3'],
      ['neutral', '?'],
      ['ok', '2/2'],
      ['ok', '2'],
    ]);
    expect(pending[1]?.label).toBe('Merge: mergeability unknown');
    expect(
      cells({ unconfirmed: true }).map(({ tone, label }) => [
        tone,
        label.endsWith(', not confirmed'),
      ]),
    ).toEqual([
      ['neutral', true],
      ['neutral', true],
      ['neutral', true],
      ['neutral', true],
    ]);
    expect(prStatus(card())).toEqual({ kind: 'none' });
    expect(prStatus(card({ turn: turn() }))).toEqual({ kind: 'placeholder' });
    expect(prStatus(card({ links: links([1]) }))).toEqual({ kind: 'unobserved', more: null });
    expect(prStatus(card({ links: links([1]), prSummary: [] }))).toEqual({
      kind: 'unobserved',
      more: null,
    });
    const several = prStatus(
      card({
        links: links([1, 2, 3]),
        prSummary: [prSummary(), prSummary({ number: 2 }), prSummary({ number: 3 })],
      }),
    );
    expect(several.kind === 'cells' && several.more).toEqual({
      count: 2,
      title: '2 more pull requests: #2, #3',
    });
  });

  /*
   * The card shows the first linked PR. Its summary has the same number and the same repo, ignoring
   * case. `merge` names the summary the cells come from (#1 mergeable, #2 conflicting); `draft`
   * says whether the draft marker shows.
   */
  it.each([
    { name: 'one link observed', prs: [1], summaries: [{}], kind: 'cells', from: 1, more: null },
    {
      name: 'two links, both observed',
      prs: [1, 2],
      summaries: [{}, { number: 2 }],
      kind: 'cells',
      from: 1,
      more: '1 more pull request: #2',
    },
    {
      name: 'two links, only the second observed',
      prs: [1, 2],
      summaries: [{ number: 2 }],
      kind: 'unobserved',
      from: null,
      more: '1 more pull request: #2',
    },
    {
      name: 'only the second observed, and a draft',
      prs: [1, 2],
      summaries: [{ number: 2, draft: true }],
      kind: 'unobserved',
      from: null,
      more: '1 more pull request: #2',
    },
    {
      name: 'the first a draft',
      prs: [1, 2],
      summaries: [{ number: 2 }, { draft: true }],
      kind: 'cells',
      from: 1,
      more: '1 more pull request: #2',
      draft: true,
    },
    {
      name: 'summaries in another order than the links',
      prs: [1, 2],
      summaries: [{ number: 2, draft: true }, {}],
      kind: 'cells',
      from: 1,
      more: '1 more pull request: #2',
    },
    {
      name: 'same number in another repo',
      prs: [1],
      summaries: [{ repo: 'ex/other', draft: true }],
      kind: 'unobserved',
      from: null,
      more: null,
    },
    {
      name: 'repo spelled in another case',
      prs: [1],
      linkRepo: 'Ex/Repo',
      summaries: [{ draft: true }],
      kind: 'cells',
      from: 1,
      more: null,
      draft: true,
    },
  ])(
    'PR status and draft follow the first linked PR: $name',
    ({ prs, linkRepo, summaries, kind, from, more, draft = false }) => {
      const prLinks = prs.map((number, index) => ({
        ...prLink(number),
        ...(index === 0 && linkRepo !== undefined ? { repo: linkRepo } : {}),
      }));
      const row = card({
        links: { ticket: null, prs: prLinks, sessions: [] },
        prSummary: summaries.map((extra: Record<string, unknown>) =>
          prSummary({ mergeable: extra['number'] === 2 ? 'conflicting' : 'mergeable', ...extra }),
        ),
      });
      const view = prStatus(row);
      const merge = view.kind === 'cells' ? view.cells[1].label : undefined;
      expect({
        kind: view.kind,
        from: merge === undefined ? null : merge === 'Merge: no conflicts' ? 1 : 2,
        more:
          view.kind === 'cells' || view.kind === 'unobserved' ? (view.more?.title ?? null) : null,
        draft: markers(row, null).some(({ text }) => text === 'draft'),
      }).toEqual({ kind, from, more, draft });
    },
  );

  it('draft and shadow markers, and the order of the markers row', () => {
    const marked = card({
      blocks: [{ id: 'B5', addressee: 'operator', session: null }],
      links: links([1], [{ id: 'crew-ada' }]),
      prSummary: [prSummary({ draft: true })],
      shadowColumn: 'review',
      shadowDiffers: true,
    });
    expect(markers(marked, null).map(({ tone, text }) => [tone, text])).toEqual([
      ['you', 'B5 → you'],
      ['default', 'draft'],
      ['ghost', 'board: review · tracker: dev'],
      ['default', 'session crew-ada'],
    ]);
    expect(markers(card({ shadowColumn: 'dev', shadowDiffers: false }), null)).toEqual([]);
  });

  it('age clamps a future time to 0m and shows — without lastGoodAt', () => {
    expect(age(new Date(NOW + 60_000).toISOString(), NOW)).toBe('0m');
    expect(age(minutes(5), undefined)).toBe('—');
    expect(age(minutes(59), NOW)).toBe('59m');
    expect(age(minutes(60), NOW)).toBe('1h');
    expect(age(minutes(90), NOW)).toBe('1h 30m');
    expect(age(minutes(2 * 1440), NOW)).toBe('2d');
    expect(turnView(card({ turn: turn() }).turn, undefined)?.tail).toBe('not taken · —');
  });

  it('a Jira key links its ticket to the browse base; other keys keep the observed URL', () => {
    const BASE = 'https://j.test/browse/';
    const jira = typed(row('ABC-3', 'dev', { links: links([]) }));
    expect(quickLinks(jira, null, BASE)).toEqual([
      {
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://j.test/browse/ABC-3',
        label: 'Ticket ABC-3, Jira, opens in a new tab',
        title: 'Ticket ABC-3: https://j.test/browse/ABC-3',
      },
    ]);
    expect(quickLinks(jira, null, null)).toEqual([]);
    const github = card({
      links: { ticket: 'https://example.test/ticket', prs: [], sessions: [] },
    });
    expect(quickLinks(github, null, BASE)).toEqual([
      {
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://example.test/ticket',
        label: 'Ticket ex/repo#7, opens in a new tab',
        title: 'Ticket ex/repo#7: https://example.test/ticket',
      },
    ]);
  });

  it('quick links go through safeExternalUrl; the session link uses spurUiOrigin', () => {
    const SPUR = 'https://spur.example.test';
    const unsafe = { ...card(), links: { ticket: 'javascript:alert(1)', prs: [], sessions: [] } };
    expect(quickLinks(unsafe, SPUR, null)).toEqual([]);
    expect(quickLinks(card(), SPUR, null)).toEqual([]);
    const linked = card({
      links: {
        ticket: 'https://example.test/ticket',
        prs: [prLink(4), prLink(5)],
        sessions: [{ id: 'a/b' }],
      },
    });
    expect(quickLinks(linked, SPUR, null)).toEqual([
      {
        kind: 'ticket',
        icon: 'ticket',
        href: 'https://example.test/ticket',
        label: 'Ticket ex/repo#7, opens in a new tab',
        title: 'Ticket ex/repo#7: https://example.test/ticket',
      },
      {
        kind: 'pr',
        icon: 'pr',
        href: 'https://github.com/ex/repo/pull/4',
        label: 'PR #4, opens in a new tab',
        title: 'PR #4: https://github.com/ex/repo/pull/4',
      },
      {
        kind: 'session',
        icon: 'term',
        href: 'https://spur.example.test/sessions/a%2Fb',
        label: 'Spur session a/b, opens in a new tab',
        title: 'Spur session a/b',
      },
    ]);
    expect(sessionChip(linked, SPUR)).toBeNull();
    expect(quickLinks(linked, null, null).map(({ kind }) => kind)).toEqual(['ticket', 'pr']);
    expect(sessionChip(linked, null)).toEqual({
      tone: 'default',
      icon: 'term',
      text: 'session a/b',
      title: 'Spur session a/b',
    });
    expect(quickLinks(linked, 'javascript:x', null).map(({ kind }) => kind)).toEqual([
      'ticket',
      'pr',
    ]);
    expect(sessionChip(linked, 'javascript:x')?.text).toBe('session a/b');
    const id = 'crew-ada-0123456789-abcdefghijklmnopq';
    expect(id).toHaveLength(37);
    expect(sessionChip(card({ links: links([], [{ id }]) }), null)).toMatchObject({
      text: 'session crew-ada-0123456789…',
      title: `Spur session ${id}`,
    });
    expect('crew-ada-0123456789…').toHaveLength(20);
    expect(sessionChip(card(), null)).toBeNull();
    expect(sessionChip(card(), SPUR)).toBeNull();
  });
});
