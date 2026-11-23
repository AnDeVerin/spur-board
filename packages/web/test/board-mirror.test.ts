// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { Icon, StatusDot, type IconName } from '../src/ds/index.ts';
import { daemon, envelope, policy, policyColumn, source, status } from './board-fixtures.ts';
import { all, mount, mountEachTest, one, press, remount, serve, settle } from './board-harness.ts';
import { board, keysIn, MIRRORED_ROWS, mirrored, part, ROWS } from './board-move-helpers.ts';

mountEachTest();

// The Popover places itself from its anchor's box and hides when the anchor is out of view;
// happy-dom lays nothing out, so every box is one column head in a 1024x768 window.
beforeEach(() => {
  for (const [name, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const)
    Object.defineProperty(document.documentElement, name, { configurable: true, get: () => value });
  const box = { left: 100, right: 340, top: 20, bottom: 60, x: 100, y: 20, width: 240, height: 40 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...box,
    toJSON: () => box,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The selector of a `Columns.module.css` class. */
const css = (name: string) => {
  const value = styles[name];
  if (value === undefined) throw new Error(`no class ${name}`);
  return `.${value}`;
};
const FROZEN = {
  health: 'failing',
  error: { code: 'mirror_read_failed', message: 'GitHub answered 502' },
};
const DETAIL =
  'GitHub answered 502. Last complete read 13:42 18/11/26. Tasks stay where they were.';
const actor = (id: string) => {
  const found = part(id).querySelector<HTMLButtonElement>(css('actor'));
  if (!found) throw new Error(`no head trigger ${id}`);
  return found;
};
const icon = (name: IconName) => renderToStaticMarkup(createElement(Icon, { name }));
const band = () => one(`main ${css('groupHead')}`);
const toggle = () => one('main section[aria-labelledby] h2 button');
const notice = (id: string) => part(id).querySelector(`${css('notice')} [role="status"]`);

describe('mirrored Backlog part on the board', () => {
  it('mirrored part: the head names the Project; a manual part keeps manual', async () => {
    await board(mirrored(), MIRRORED_ROWS);
    expect(actor('ready-for-dev').querySelector(css('execText'))?.textContent).toBe(
      'mirror · Roadmap',
    );
    expect(actor('ready-for-dev').textContent).toBe('mirror · Roadmap');
    expect(actor('ready-for-dev').querySelector('svg')?.outerHTML).toBe(icon('mirror'));
    expect(actor('ready-for-dev').hasAttribute('data-warn')).toBe(false);
    for (const id of ['todo', 'triage']) {
      expect(actor(id).textContent).toBe('manual');
      expect(actor(id).querySelector('svg')?.outerHTML).toBe(icon('person'));
    }
    expect(all(`main ${css('notice')}`)).toEqual([]);
    expect(band().querySelector(css('groupWarn'))).toBeNull();
    remount();
    await board(mirrored(), ROWS);
    expect(part('ready-for-dev').title).toBe('ready-for-dev: empty · mirror · Roadmap');
  });

  it('failing mirror: frozen line, band dot, notice; cards stay; folded too; empty part keeps the notice', async () => {
    await board(mirrored(FROZEN), MIRRORED_ROWS);
    const trigger = actor('ready-for-dev');
    expect(trigger.hasAttribute('data-warn')).toBe(true);
    expect(trigger.textContent).toBe('mirror · Roadmap · frozen');
    expect(trigger.querySelector(css('execWarn'))?.textContent).toBe(' · frozen');
    expect(trigger.title).toBe('Mirror not readable: GitHub answered 502. Click for details.');
    expect(actor('todo').hasAttribute('data-warn')).toBe(false);
    const warn = band().querySelector<HTMLElement>(css('groupWarn'));
    expect(warn?.title).toBe('A mirror is not readable');
    expect(warn?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(warn?.querySelector(css('hidden'))?.textContent).toBe('mirror frozen');
    expect(warn?.nextElementSibling?.textContent).toBe('3');
    expect(notice('ready-for-dev')?.textContent).toBe(`Mirror not readable: frozen${DETAIL}`);
    // The notice sits between the head and the cards; the cards stay as read.
    const holder = part('ready-for-dev').querySelector(css('notice'));
    expect(holder?.previousElementSibling?.contains(trigger)).toBe(true);
    expect(holder?.nextElementSibling?.className).toBe(styles.body);
    expect(keysIn('ready-for-dev')).toEqual(['ex/repo#4']);
    expect(notice('todo')).toBeNull();
    expect(all('main [role="status"]')).toHaveLength(1);
    press(toggle(), 'click');
    const stacked = all(`main section${css('groupSection')}`);
    expect(stacked).toHaveLength(3);
    expect(stacked[0]).toBe(part('ready-for-dev'));
    expect(stacked[0]?.querySelector('h3')?.textContent).toBe('ready-for-dev');
    expect(stacked[0]?.contains(notice('ready-for-dev') ?? null)).toBe(true);
    expect(notice('ready-for-dev')?.textContent).toBe(`Mirror not readable: frozen${DETAIL}`);
    expect(keysIn('ready-for-dev')).toEqual(['ex/repo#4']);
    expect(actor('ready-for-dev').textContent).toBe('mirror · Roadmap · frozen');
    remount();
    // No tasks: a column with its head and the notice, not a spine.
    await board(mirrored({ ...FROZEN, readAt: null }), ROWS);
    expect(part('ready-for-dev').hasAttribute('title')).toBe(false);
    expect(notice('ready-for-dev')?.textContent).toBe(
      'Mirror not readable: frozenGitHub answered 502. No complete read yet. Tasks stay where they were.',
    );
    expect(keysIn('ready-for-dev')).toEqual([]);
  });
});

describe('mirrored Backlog part in column help', () => {
  const TEXT =
    'GitHub Project ex/1 places idle work here while its Status field is Ready; manual moves into or out of this column are refused.';
  const MANUAL = { kind: 'manual', text: 'The operator moves tasks here by hand, with a reason.' };
  const described = policy('a', [
    policyColumn('todo', { group: 'todo', movedBy: MANUAL }),
    policyColumn('triage', { group: 'todo', movedBy: MANUAL }),
    policyColumn('ready-for-dev', { group: 'todo', movedBy: { kind: 'mirror', text: TEXT } }),
    policyColumn('dev'),
    policyColumn('done'),
  ]);
  const panel = () => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!found) throw new Error('no dialog');
    return found;
  };
  const moves = () => {
    const found = [...panel().querySelectorAll('h4')]
      .find((title) => title.textContent === 'Moves tasks here')
      ?.closest('section');
    if (!found) throw new Error('no Moves tasks here');
    return found;
  };
  const lines = () => [...moves().querySelectorAll('p')];
  /**
   * The board with ready-for-dev in `extra`'s state, read 3 minutes ago, and `status.get` listing
   * `sources`, its Who tab open.
   */
  const openWho = async (extra: Record<string, unknown> = {}, sources: unknown[] = []) => {
    remount();
    const d = daemon();
    serve(d, MIRRORED_ROWS, mirrored(extra));
    d.routes['status.get'] = () => Promise.resolve(envelope(status(MIRRORED_ROWS, sources)));
    d.routes['columns.describe'] = () => Promise.resolve(envelope(described));
    mount(d, {}, () => Date.parse('2026-11-18T13:45:00.000Z'));
    await settle();
    press(actor('ready-for-dev'), 'click');
    await settle();
  };

  it('mirrored Backlog part: Who names the Project and the state, healthy and frozen', async () => {
    await openWho();
    expect(lines()[0]?.innerHTML).toBe('<b>mirror</b> · GitHub Project <b>Roadmap</b> · Status');
    expect(lines()[1]?.textContent).toBe('read 3m ago');
    expect(lines()[1]?.querySelector('[aria-hidden="true"]')?.outerHTML).toBe(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'ok' })),
    );
    expect(lines()[2]?.textContent).toBe(TEXT);
    expect(moves().querySelector('[role="status"]')).toBeNull();
    // A degraded mirror warns but is not frozen.
    await openWho({ health: 'degraded', readAt: null });
    expect(lines()[1]?.textContent).toBe('degraded · no complete read yet');
    expect(lines()[1]?.querySelector('[aria-hidden="true"]')?.outerHTML).toBe(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'warn' })),
    );
    expect(moves().querySelector('[role="status"]')).toBeNull();
    // A degraded mirror after a good read says so in words, not only by the dot.
    await openWho({ health: 'degraded' });
    expect(lines()[1]?.textContent).toBe('degraded · read 3m ago');
    // Paused for the GitHub rate budget, it names the wait.
    await openWho({ health: 'degraded' }, [
      source('github-project:a:ex/1', { waitsForBudget: true }),
    ]);
    expect(lines()[1]?.textContent).toBe('waiting for the GitHub rate budget · read 3m ago');
    expect(moves().querySelector('[role="status"]')).toBeNull();
    await openWho(FROZEN);
    expect(moves().querySelector('[role="status"]')?.textContent).toBe(
      `Not readable: frozen${DETAIL}`,
    );
    expect(lines()[0]?.textContent).toBe('mirror · GitHub Project Roadmap · Status');
    expect(moves().lastElementChild?.textContent).toBe(TEXT);
  });

  const STALE = {
    blindReason: 'stale',
    message: 'No complete observation in 3 poll intervals',
    lastCompleteAt: '2026-11-18T13:42:00.000Z',
    stale: true,
  };
  const LAST = 'Last complete read 13:42 18/11/26. Tasks stay where they were.';
  it.each([
    ['coded error', FROZEN, [], 'GitHub answered 502.', ': GitHub answered 502'],
    [
      'stale blind after a good poll',
      { health: 'failing' },
      [source('github-project:a:ex/1', STALE)],
      'No complete observation in 3 poll intervals.',
      '',
    ],
    [
      'stale blind while waiting for the rate budget',
      { health: 'failing' },
      [source('github-project:a:ex/1', { ...STALE, waitsForBudget: true })],
      'No complete observation in 3 poll intervals. Polls wait for the GitHub rate budget.',
      '',
    ],
    ['no source in status.get', { health: 'failing' }, [], 'The mirror has no usable read.', ''],
  ])(
    'frozen mirror, %s: the notice and Who give the cause',
    async (_, extra, sources, cause, why) => {
      await openWho(extra, sources);
      expect(notice('ready-for-dev')?.textContent).toBe(
        `Mirror not readable: frozen${cause} ${LAST}`,
      );
      expect(moves().querySelector('[role="status"]')?.textContent).toBe(
        `Not readable: frozen${cause} ${LAST}`,
      );
      expect(actor('ready-for-dev').title).toBe(`Mirror not readable${why}. Click for details.`);
    },
  );
});

describe('mirrored Backlog part and the top banner', () => {
  it('a blind or failing GitHub Project mirror raises the top banner as other sources do', async () => {
    const LAST = '2026-11-15T14:40:00.000Z';
    const mirror = (extra: Record<string, unknown>) =>
      source('github-project:a:ex/1', { lastCompleteAt: LAST, ...extra });
    const failed = { code: 'mirror_read_failed', message: 'GitHub answered 502' };
    const FROZE =
      'ready-for-dev is frozen: tasks stay where they were until the mirror reads again.';
    const NAME = 'GitHub Project ex/1';
    const OLDEST = 'The oldest answer is from 14:40 15/11/26.';
    const said = (name: string, detail = FROZE) =>
      `${name} has not answered since 14:40 15/11/26.${detail}`;
    const warnings = async (
      sources: unknown[],
      rows: unknown[] = MIRRORED_ROWS,
      extra: Record<string, unknown> = FROZEN,
    ) => {
      remount();
      const d = daemon();
      serve(d, rows, mirrored(extra));
      d.routes['status.get'] = () => Promise.resolve(envelope(status(rows, sources)));
      mount(d);
      await settle();
      return all('[role="status"]')
        .filter((banner) => banner.closest('main') === null)
        .map((banner) => banner.textContent);
    };
    // The Backlog notice can be offscreen at 375 px, so the banner names the mirror and says
    // its part is frozen.
    expect(await warnings([mirror({ blindReason: 'auth', stale: true })])).toEqual([said(NAME)]);
    expect(await warnings([mirror({ failure: failed, stale: true })])).toEqual([said(NAME)]);
    // A stale mirror that is not blind is degraded, not frozen.
    expect(
      await warnings([mirror({ stale: true })], MIRRORED_ROWS, { health: 'degraded' }),
    ).toEqual([said(NAME, 'Its facts may be out of date.')]);
    // No tasks: the board shows its empty message instead of the notice; the banner stays.
    expect(await warnings([mirror({ blindReason: 'stale', stale: true })], [])).toEqual([
      said(NAME),
    ]);
    expect(await warnings([mirror({ failure: failed, blindReason: 'auth' })], [])).toEqual([
      said(NAME),
    ]);
    expect(
      await warnings([
        mirror({ blindReason: 'auth', failure: failed }),
        source('jira:a', { blindReason: 'auth', lastCompleteAt: LAST }),
      ]),
    ).toEqual([`2 sources have not answered: ${NAME}, jira:a.${OLDEST} ${FROZE}`]);
    // A failed read alone, not yet blind or stale, freezes the part, so the banner names it.
    expect(await warnings([mirror({ failure: failed })])).toEqual([said(NAME)]);
    expect(
      await warnings([
        mirror({ failure: failed }),
        source('github:a:ex/repo', { blindReason: 'auth', lastCompleteAt: LAST }),
      ]),
    ).toEqual([`2 sources have not answered: ${NAME}, github:a:ex/repo.${OLDEST} ${FROZE}`]);
    // A blind source that is not a mirror freezes nothing.
    const jira = source('jira:a', { blindReason: 'auth', lastCompleteAt: LAST });
    expect(await warnings([jira], MIRRORED_ROWS, {})).toEqual([
      said('jira:a', 'Its facts may be out of date.'),
    ]);
    expect(
      await warnings(
        [jira, source('github:a:ex/repo', { blindReason: 'auth', lastCompleteAt: LAST })],
        MIRRORED_ROWS,
        {},
      ),
    ).toEqual([`2 sources have not answered: jira:a, github:a:ex/repo.${OLDEST}`]);
    // A mirror that reads again has no failure and raises no banner.
    expect(await warnings([mirror({ failure: null })], MIRRORED_ROWS, {})).toEqual([]);
  });
});
