// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Chip, type ChipTone } from '../src/ds/index.ts';
import { config, daemon, failure, prLink, prSummary, row, turn } from './board-fixtures.ts';
import {
  all,
  container,
  goOffline,
  linkedRows,
  mount,
  mountEachTest,
  one,
  press,
  remount,
  serve,
  settle,
  SPUR,
  withSpur,
} from './board-harness.ts';

mountEachTest();

const NOW = Date.parse('2026-11-15T14:05:00.000Z');
const taken = { taken: { by: 'agent:stand-worker/crew-ada', at: '2026-11-15T14:00:00.000Z' } };
/** The card link's description: each described element's label, else its text. */
const description = (card: HTMLElement) =>
  (card.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => {
      const target = document.getElementById(id);
      if (target === null) throw new Error(`no #${id}`);
      return target.getAttribute('aria-label') ?? target.textContent;
    })
    .join(' | ');
const chipClass = (tone: ChipTone, wrap = false) =>
  /class="([^"]*)"/.exec(
    renderToStaticMarkup(createElement(Chip, { tone, wrap, children: 'x' })),
  )?.[1];
/** `config` with an operator Ready to Merge column in the first project. */
function readyToMergeConfig() {
  const [first, ...rest] = config.projects;
  if (first === undefined) throw new Error('no project');
  return {
    ...config,
    projects: [
      {
        ...first,
        columns: [
          ...first.columns,
          { id: 'ready-to-merge', executor: { kind: 'operator', name: null } },
        ],
      },
      ...rest,
    ],
  };
}

describe('board task cards', () => {
  it('a quick link does not open the task', async () => {
    const d = daemon();
    serve(d, linkedRows());
    mount(d);
    await settle();
    // happy-dom would follow a target=_blank link; the test only checks the board ignores it.
    const stop = (event: Event) => {
      event.preventDefault();
    };
    document.addEventListener('click', stop);
    try {
      const quick = all('main a[target]');
      expect(quick.map((link) => link.getAttribute('aria-label'))).toEqual([
        'Ticket ex/repo#7, opens in a new tab',
        'PR #4, opens in a new tab',
      ]);
      for (const link of quick) {
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.closest('a[href^="?open="]')).toBeNull();
        press(link, 'click');
        expect(location.search).toBe('');
      }
      expect(quick.map((link) => link.getAttribute('href'))).toEqual([
        'https://example.test/ticket',
        'https://github.com/ex/repo/pull/4',
      ]);
    } finally {
      document.removeEventListener('click', stop);
    }
  });

  it('a Jira card links its ticket to the project browse base', async () => {
    const d = daemon();
    const [first, ...rest] = config.projects;
    if (first === undefined) throw new Error('no project');
    serve(d, linkedRows(), {
      ...config,
      projects: [{ ...first, ticketBrowseBase: 'https://j.test/browse/' }, ...rest],
    });
    mount(d);
    await settle();
    const ticket = one(
      'main a[target="_blank"][rel="noopener noreferrer"][href="https://j.test/browse/ABC-3"]',
    );
    expect(ticket.getAttribute('aria-label')).toBe('Ticket ABC-3, Jira, opens in a new tab');
    expect(ticket.closest('a[href^="?open="]')).toBeNull();
    expect(
      one('main a[aria-label="Ticket ex/repo#7, opens in a new tab"]').getAttribute('href'),
    ).toBe('https://example.test/ticket');
  });

  it('the session is a link with spurUiOrigin and a plain chip without', async () => {
    const linked = daemon();
    serve(linked, linkedRows(), withSpur);
    mount(linked);
    await settle();
    const session = one(`main a[href="${SPUR}/sessions/sess-9"]`);
    expect(session.getAttribute('aria-label')).toBe('Spur session sess-9, opens in a new tab');
    expect(session.title).toBe('Spur session sess-9');
    expect(one('main').textContent).not.toContain('session sess-9');

    remount();
    const plain = daemon();
    serve(plain, linkedRows());
    mount(plain);
    await settle();
    expect(container().querySelector('main a[href*="/sessions/"]')).toBeNull();
    const chip = all('main span').find((span) => span.textContent === 'session sess-9');
    if (chip === undefined) throw new Error('no session chip');
    expect(chip.title).toBe('Spur session sess-9');
    expect(chip.hasAttribute('href')).toBe(false);
    expect(chip.hasAttribute('tabindex')).toBe(false);
    expect(chip.closest('a')).toBe(one('main a[title="ex/repo#7"]'));
  });

  it('card description names the PR cells, markers and turn', async () => {
    const d = daemon();
    serve(d, [
      row('ex/repo#7', 'dev', {
        links: { ticket: null, prs: [prLink(1), prLink(2)], sessions: [] },
        prSummary: [prSummary({ unconfirmed: true, draft: true }), prSummary({ number: 2 })],
        turn: turn(taken),
      }),
      row('ex/repo#8', 'dev', {
        links: { ticket: null, prs: [prLink(3)], sessions: [] },
        prSummary: [prSummary({ number: 3, mergeable: 'conflicting' })],
        blocks: [{ id: 'B4', addressee: 'worker', session: null }],
      }),
      row('ABC-3', 'dev', {
        ticket: null,
        links: { ticket: null, prs: [prLink(5)], sessions: [] },
      }),
      row('ABC-4', 'dev', { ticket: null, turn: turn({ addressee: 'operator' }) }),
    ]);
    mount(d, {}, () => NOW);
    await settle();
    const card = (key: string) => one(`main a[title="${key}"]`);
    expect(description(card('ex/repo#7'))).toBe(
      [
        'Checks: 3 of 3 passed, not confirmed',
        'Merge: no conflicts, not confirmed',
        'Threads: none, not confirmed',
        'Reviews on the head: none, not confirmed',
        '+1',
        'draft',
        'T3 worker crew-ada taken · 5m',
      ].join(' | '),
    );
    expect(card('ex/repo#7').parentElement?.getAttribute('data-turn')).toBe('agent');
    expect(one('main [title="1 more pull request: #2"]').textContent).toBe('+1');
    expect(description(card('ex/repo#8'))).toBe(
      [
        'Checks: 3 of 3 passed',
        'Merge: conflicting',
        'Threads: none',
        'Reviews on the head: none',
        '1 block',
      ].join(' | '),
    );
    expect(card('ex/repo#8').parentElement?.getAttribute('data-turn')).toBe('none');
    expect(description(card('ABC-3'))).toBe('PR status: not observed yet');
    expect(description(card('ABC-4'))).toBe('no PR yet | T3 your turn open · 5m');
    expect(card('ABC-4').parentElement?.getAttribute('data-turn')).toBe('you');
  });

  it('a Ready to Merge card shows QA carried or QA skipped in its markers', async () => {
    const sha = 'a'.repeat(40);
    const qa = (basis: string, extra: Record<string, unknown> = {}) => ({
      column: 'qa',
      sha,
      at: '2026-11-15T14:00:00.000Z',
      basis,
      from: null,
      testedOrigin: null,
      reason: null,
      pending: false,
      voided: false,
      ...extra,
    });
    const d = daemon();
    serve(
      d,
      [
        row('ex/repo#7', 'ready-to-merge', {
          qaSubmission: qa('carried', { from: sha, testedOrigin: sha, reason: 'Same tree' }),
        }),
        row('ex/repo#8', 'ready-to-merge', {
          qaSubmission: qa('skipped', { reason: 'Docs only' }),
        }),
        row('ex/repo#9', 'ready-to-merge', { qaSubmission: qa('tested') }),
      ],
      readyToMergeConfig(),
    );
    mount(d, {}, () => NOW);
    await settle();
    const card = (key: string) => one(`main a[title="${key}"]`);
    const chip = (key: string, text: string) => {
      const found = [...card(key).querySelectorAll('span')].find(
        (span) => span.textContent === text,
      );
      if (found === undefined) throw new Error(`no ${text} chip on ${key}`);
      return found;
    };
    const carried = chip('ex/repo#7', 'QA carried');
    expect(carried.title).toBe(`Verdict carried from ${sha}: Same tree`);
    expect(carried.className).toBe(chipClass('default'));
    const skipped = chip('ex/repo#8', 'QA skipped');
    expect(skipped.title).toBe('QA skipped: Docs only');
    expect(skipped.className).toBe(chipClass('warn'));
    expect(chipClass('warn')).not.toBe(chipClass('default'));
    expect(description(card('ex/repo#7'))).toBe('QA carried');
    expect(description(card('ex/repo#8'))).toBe('QA skipped');
    expect(card('ex/repo#9').getAttribute('aria-describedby') ?? '').not.toContain('markers');
    expect(card('ex/repo#9').textContent).not.toContain('QA');
  });

  it('a Ready to Merge card shows approval freshness in the reviews cell and markers', async () => {
    const sha = 'a'.repeat(40);
    const pr = (number: number, approval: Record<string, unknown>) => ({
      links: { ticket: null, prs: [prLink(number)], sessions: [] },
      prSummary: [
        prSummary({ number, approvals: [{ author: 'dana', sha, onHead: false, ...approval }] }),
      ],
    });
    const d = daemon();
    serve(
      d,
      [
        row(
          'ex/repo#7',
          'ready-to-merge',
          pr(7, {
            commitsAfter: 3,
            changedAfter: ['back/', 'docs/', 'front/'],
            watchedAfter: ['back/', 'front/'],
          }),
        ),
        row(
          'ex/repo#8',
          'ready-to-merge',
          pr(8, { commitsAfter: 2, changedAfter: ['docs/'], watchedAfter: [] }),
        ),
      ],
      readyToMergeConfig(),
    );
    mount(d, {}, () => NOW);
    await settle();
    const card = (key: string) => one(`main a[title="${key}"]`);
    const cell = (key: string) => {
      const found = card(key).querySelectorAll<HTMLElement>('[role="img"]')[3];
      if (found === undefined) throw new Error(`no reviews cell on ${key}`);
      return found;
    };
    const staleTitle = 'Approved 3 commits ago; changed since: back/, docs/, front/';
    const stale = cell('ex/repo#7');
    expect(stale.getAttribute('data-tone')).toBe('pend');
    expect(stale.textContent).toBe('1+3');
    expect(stale.title).toBe(staleTitle);
    const chip = [...card('ex/repo#7').querySelectorAll('span')].find(
      (span) => span.textContent === 'approved before back/ front/',
    );
    expect(chip?.className).toBe(chipClass('warn', true));
    expect(chip?.title).toBe(`dana approved ${sha}; 3 commits since changed back/, front/.`);
    expect(description(card('ex/repo#7'))).toContain(`Approvals: 1; ${staleTitle}`);
    expect(description(card('ex/repo#7'))).toContain('approved before back/ front/');
    const quietCell = cell('ex/repo#8');
    expect(quietCell.getAttribute('data-tone')).toBe('ok');
    expect(quietCell.textContent).toBe('1+2');
    expect(quietCell.lastElementChild?.textContent).toBe('+2');
    expect(card('ex/repo#8').getAttribute('aria-describedby') ?? '').not.toContain('markers');
  });

  it('a not-observed first PR keeps +N for the other linked PRs in the description', async () => {
    const d = daemon();
    serve(d, [
      row('ex/repo#7', 'dev', {
        links: { ticket: null, prs: [prLink(6), prLink(7)], sessions: [] },
        // Only the second linked PR is observed: the first one's status is unknown.
        prSummary: [prSummary({ number: 7, mergeable: 'conflicting' })],
        turn: turn(taken),
      }),
    ]);
    mount(d, {}, () => NOW);
    await settle();
    const card = one('main a[title="ex/repo#7"]');
    const more = (card.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .find((id) => id.endsWith('-more'));
    expect(more).toBeDefined();
    const element = document.getElementById(more ?? '');
    expect(element?.textContent).toBe('+1');
    expect(element?.title).toBe('1 more pull request: #7');
    expect(all('main [role="img"]')).toHaveLength(0);
    expect(description(card)).toBe(
      ['PR status: not observed yet', '+1', 'T3 worker crew-ada taken · 5m'].join(' | '),
    );
  });

  it('rendering cards requests only the five paths', async () => {
    const d = daemon();
    serve(d, linkedRows(), withSpur);
    const paths = new Set<string>();
    const fetcher = d.fetcher;
    d.fetcher = (url, init) => {
      paths.add(url instanceof Request ? url.url : url.toString());
      return fetcher(url, init);
    };
    mount(d);
    await settle();
    expect(all('main a[target]')).toHaveLength(3);
    expect([...paths].sort()).toEqual([
      '/v1/events',
      '/v1/ops/columns.describe',
      '/v1/ops/config.get',
      '/v1/ops/inbox.operator',
      '/v1/ops/status.get',
    ]);
  });

  it('a waiting turn row reads clock, wake time, then reason, and names the full label', async () => {
    const reason = 'r'.repeat(200);
    const wait = { reason, since: '2026-11-15T14:01:00.000Z', wakesAt: '2026-11-15T14:31:00.000Z' };
    const d = daemon();
    serve(d, [
      row('ex/repo#7', 'dev', { turn: turn({ ...taken, wait }) }),
      row('ex/repo#8', 'dev', {
        turn: turn({ ...taken, wait, stalledSince: '2026-11-15T13:25:00.000Z' }),
      }),
      row('ex/repo#9', 'dev', { turn: turn(taken) }),
      row('ex/repo#10', 'dev', { turn: turn({ ...taken, wait: { ...wait, reason: '  ' } }) }),
    ]);
    mount(d, {}, () => NOW);
    await settle();
    const card = (key: string) => one(`main a[title="${key}"]`);
    const turnRow = (key: string) => {
      const found = card(key).querySelector('[id$="-turn"]');
      if (found === null) throw new Error(`no turn row on ${key}`);
      return found;
    };
    const tail = (key: string) => turnRow(key).querySelector('[data-kind]');
    const full = `Waiting: ${reason}. Wakes 14:31 (in 26m)`;
    expect(turnRow('ex/repo#7').hasAttribute('data-waiting')).toBe(true);
    expect(tail('ex/repo#7')?.getAttribute('title')).toBe(full);
    expect(tail('ex/repo#7')?.getAttribute('data-kind')).toBe('agent');
    // Clock icon, then the time, then the reason; only the hidden label is read aloud.
    const parts = [...(tail('ex/repo#7')?.children ?? [])];
    expect(parts.map((part) => part.tagName.toLowerCase())).toEqual([
      'svg',
      'span',
      'span',
      'span',
    ]);
    expect(parts.map((part) => part.getAttribute('aria-hidden'))).toEqual([
      'true',
      'true',
      'true',
      null,
    ]);
    expect(parts.map((part) => part.textContent)).toEqual(['', 'wakes 14:31 ·', reason, full]);
    // What assistive technology reads from the described turn row: text outside aria-hidden.
    const read = turnRow('ex/repo#7').cloneNode(true) as Element;
    for (const hidden of read.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    expect(read.textContent.replace(/^T\d+ /, '')).toBe(`worker crew-ada ${full}`);
    expect(card('ex/repo#7').getAttribute('aria-describedby')).toContain(turnRow('ex/repo#7').id);
    // A whitespace-only reason: no dot and no reason span.
    const blank = [...(tail('ex/repo#10')?.children ?? [])];
    expect(blank.map((part) => part.textContent)).toEqual([
      '',
      'wakes 14:31',
      'Waiting. Wakes 14:31 (in 26m)',
    ]);
    for (const key of ['ex/repo#8', 'ex/repo#9']) {
      expect(turnRow(key).hasAttribute('data-waiting')).toBe(false);
      expect(tail(key)?.hasAttribute('title')).toBe(false);
      expect(tail(key)?.children).toHaveLength(0);
    }
    expect(tail('ex/repo#8')?.textContent).toBe('stalled · 40m');
    expect(tail('ex/repo#9')?.textContent).toBe('taken · 5m');
  });

  it('ages freeze while stale', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = NOW;
    const d = daemon();
    serve(d, [row('ex/repo#7', 'dev', { turn: turn(taken) })]);
    mount(d, {}, () => now);
    await settle();
    const tail = () => one('main a[title="ex/repo#7"]').textContent;
    expect(tail()).toContain('taken · 5m');
    now += 3_600_000;
    d.routes['status.get'] = failure;
    await goOffline(d);
    expect(one('[role="alert"]').textContent).toContain('14:05 15/11/26');
    expect(all('main section').every((section) => section.hasAttribute('data-stale'))).toBe(true);
    expect(tail()).toContain('taken · 5m');
  });
});
