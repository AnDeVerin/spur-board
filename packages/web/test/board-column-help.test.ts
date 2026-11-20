// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { focusRing, Icon, type IconName } from '../src/ds/index.ts';
import {
  config,
  daemon,
  deferred,
  envelope,
  failure,
  policy,
  policyColumn,
  row,
  type Daemon,
} from './board-fixtures.ts';
import {
  all,
  mount,
  mountEachTest,
  one,
  press,
  remount,
  serve,
  settle,
  SPUR,
} from './board-harness.ts';

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
const css = (name: string) => `.${styles[name] ?? 'missing'}`;
const column = (id: string, kind: string, name: string | null = null, grouped = false) => ({
  id,
  executor: { kind, name },
  ...(grouped ? { group: 'todo' } : {}),
});
const [projectA, projectB] = config.projects;
if (!projectA || !projectB) throw new Error('fixture config has two projects');
const HELP_CONFIG = {
  ...config,
  web: { publicOrigin: null, spurUiOrigin: SPUR },
  projects: [
    {
      ...projectA,
      columns: [
        column('todo', 'dispatcher', null, true),
        column('triage', 'dispatcher', null, true),
        column('dev', 'worker', 'stand-worker'),
        column('review', 'orchestrator', 'stand-review'),
        column('external-review', 'dispatcher'),
        column('qa', 'orchestrator', 'stand-qa'),
        column('ready-to-merge', 'operator'),
        column('done', 'dispatcher'),
      ],
    },
    projectB,
  ],
};
const ROWS = [
  row('T-1', 'todo'),
  row('D-1', 'dev'),
  row('R-1', 'review'),
  row('E-1', 'external-review'),
  row('Q-1', 'qa'),
  row('M-1', 'ready-to-merge'),
];

const DEV_CONDITIONS = [
  ['pr_open', 'PR open'],
  ['not_draft', 'Not a draft'],
  ['checks_green', 'Checks green'],
  ['no_conflict', 'No conflict'],
  ['external_comments_handled', 'External comments handled'],
  ['comment_history_read', 'Comment history read'],
  ['threads_resolved', 'Threads resolved'],
  ['submit_on_head', 'Submit on the head'],
] as const;
const destination = (role: string, displayName: string | null, project: string | null = null) => ({
  role,
  project,
  displayName,
  session: null,
  text: `${role} answers questions.`,
});
const executor = (kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  project: null,
  role: null,
  displayName: null,
  session: null,
  text: `${kind} takes the turn.`,
  ...extra,
});
const PART = {
  group: 'todo',
  exit: {
    to: 'dev',
    conditions: [{ id: 'work_started', text: 'An open PR or a live worker started the work.' }],
  },
  executor: executor('dispatcher', {
    project: 'stand-qa',
    role: 'orchestrator',
    text: 'No executor turn opens in the Todo group, even with a configured binding.',
  }),
  movedBy: { kind: 'manual', text: 'The operator moves tasks here by hand, with a reason.' },
};
const qaSession = { id: 's-qa', links: [] };
/** The `columns.describe` answer of project `a`; `qa` gives the QA executor's session. */
const answer = (qa: { id: string; links: never[] } | null = qaSession) =>
  policy('a', [
    policyColumn('todo', PART),
    policyColumn('triage', PART),
    policyColumn('dev', {
      exit: {
        to: 'review',
        conditions: DEV_CONDITIONS.map(([id]) => ({ id, text: `Rule ${id}.` })),
      },
      executor: executor('worker', { text: 'The worker of the task takes the turn.' }),
    }),
    policyColumn('review', {
      exit: { to: 'external-review', conditions: [{ id: 'review_on_head', text: 'Reviewed.' }] },
      returns: ['The reviewer requests changes.', 'A thread is unresolved.'],
      limits: {
        cycleLimit: 3,
        courseCheck: 2,
        courseCheckTo: destination('curator', 'Curator', 'stand-curator'),
      },
      executor: executor('orchestrator', {
        project: 'stand-review',
        role: 'orchestrator',
        displayName: 'stand-review',
        session: { id: 's-review', links: [] },
        text: 'A session of stand-review takes the turn.',
      }),
      escalation: {
        chain: [
          destination('orchestrator:review', 'stand-review', 'stand-review'),
          destination('curator', 'Curator', 'stand-curator'),
          destination('operator', null),
        ],
        noRecipient: { operatorItemAfterMs: 900_000, text: 'No recipient.' },
        silent: {
          remindAfterMs: 1_800_000,
          operatorItemAfterReminderReadMs: 600_000,
          unhealthyAfterMs: 600_000,
          text: 'Quiet turns.',
        },
      },
    }),
    policyColumn('external-review', {
      exit: {
        to: 'qa',
        conditions: [{ id: 'approved', text: 'Approved by an external reviewer.' }],
      },
      executor: executor('dispatcher', {
        text: 'The dispatcher moves the task when the rules hold; nobody takes a turn.',
      }),
    }),
    policyColumn('qa', {
      exit: { to: 'ready-to-merge', conditions: [{ id: 'submit_on_head', text: 'Submitted.' }] },
      executor: executor('orchestrator', {
        project: 'stand-qa',
        role: 'orchestrator',
        displayName: 'stand-qa',
        session: qa,
      }),
    }),
    policyColumn('ready-to-merge', {
      exit: { to: null, conditions: [{ id: 'merged', text: 'The pull request is merged.' }] },
      executor: executor('operator', { text: 'You take the turn.' }),
    }),
    policyColumn('done'),
  ]);

/** A board of project `a` whose `columns.describe` answers through `route`, which it counts. */
const board = async (
  route: Daemon['routes']['columns.describe'] = () => Promise.resolve(envelope(answer())),
) => {
  const d = daemon();
  serve(d, ROWS, HELP_CONFIG);
  const describes: Record<string, unknown>[] = [];
  d.routes['columns.describe'] = (input) => {
    describes.push(input);
    return route(input);
  };
  mount(d);
  await settle();
  return { d, describes };
};
const fold = () => {
  const found = one('main section[aria-labelledby]').querySelector('h2 button');
  if (!found) throw new Error('no fold toggle');
  press(found, 'click');
};
/** The head of the column or part named `id`. */
const head = (id: string) => {
  const label = all('main h2, main h3').find(
    (element) => element.textContent === id && element.closest(css('head')),
  );
  const found = label?.closest<HTMLElement>(css('head'));
  if (!found) throw new Error(`no head ${id}`);
  return found;
};
const actor = (id: string) => {
  const found = head(id).querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!found) throw new Error(`no trigger ${id}`);
  return found;
};
const line = (id: string) => actor(id).querySelector(css('execText'))?.textContent;
const icon = (name: IconName) => renderToStaticMarkup(createElement(Icon, { name }));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const panel = () => {
  const found = dialog();
  if (!found) throw new Error('no dialog');
  return found;
};
const tab = (label: string) => {
  const found = [...panel().querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`no tab ${label}`);
  return found;
};
/** The section of the open panel whose title is `title`. */
const part = (title: string) => {
  const heading = [...panel().querySelectorAll('h4')].find((h) => h.textContent === title);
  const found = heading?.closest('section');
  if (!found) throw new Error(`no section ${title}`);
  return found;
};
const titles = () => [...panel().querySelectorAll('h4')].map((h) => h.textContent);
const openHelp = async (id: string) => {
  press(actor(id), 'click');
  await settle();
};
const showRules = async () => {
  press(tab('Rules'), 'click');
  await settle();
};
const close = () => {
  const found = panel().querySelector<HTMLElement>('button[aria-label="Close"]');
  if (!found) throw new Error('no Close');
  press(found, 'click');
};

describe('column help', () => {
  it('the head line is the help trigger with the actor icon, whatever the describe read', async () => {
    const expected = [
      ['todo', 'manual', 'person'],
      ['dev', 'worker stand-worker', 'agent'],
      ['review', 'orchestrator stand-review', 'agent'],
      ['external-review', 'dispatcher', 'dispatcher'],
      ['qa', 'orchestrator stand-qa', 'agent'],
      ['ready-to-merge', 'operator', 'person'],
    ] as const;
    const check = () => {
      for (const [id, text, name] of expected) {
        const button = actor(id);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(button.hasAttribute('aria-controls')).toBe(false);
        expect(button.hasAttribute('data-warn')).toBe(false);
        expect(line(id)).toBe(text);
        expect(button.querySelector('svg')?.outerHTML).toBe(icon(name));
      }
      expect(all('main button[aria-haspopup="dialog"]')).toHaveLength(expected.length);
      // Empty columns and parts are spines with no head and no trigger.
      for (const id of ['triage', 'done'])
        expect(one(`main section[title^="${id}"]`).querySelector('button')).toBeNull();
    };
    await board(() => Promise.resolve(envelope({ projects: [] })));
    check();
    remount();
    const failing = await board(failure);
    expect(failing.describes).toEqual([{ project: 'a' }]);
    check();
    expect(all('[role="alert"]')).toEqual([]);
    // Folded, every part keeps its head, the empty one too, with the person icon.
    fold();
    for (const id of ['todo', 'triage']) {
      expect(line(id)).toBe('manual');
      expect(actor(id).querySelector('svg')?.outerHTML).toBe(icon('person'));
    }
  });

  it('warns with no live session on a bound non-part head only', async () => {
    let qa: { id: string; links: never[] } | null = null;
    await board(() => Promise.resolve(envelope(answer(qa))));
    expect(actor('qa').hasAttribute('data-warn')).toBe(true);
    expect(line('qa')).toBe('orchestrator stand-qa');
    expect(actor('qa').textContent).toBe('orchestrator stand-qa · no live session');
    expect(actor('qa').title).toBe('How qa works: who acts and the rules · no live session');
    // A part bound to a project without a session, a dispatcher and a live session do not warn.
    for (const id of ['todo', 'external-review', 'review', 'dev']) {
      expect(actor(id).hasAttribute('data-warn')).toBe(false);
      expect(actor(id).textContent).not.toContain('no live session');
    }
    qa = qaSession;
    await openHelp('qa');
    expect(actor('qa').hasAttribute('data-warn')).toBe(false);
    expect(actor('qa').textContent).toBe('orchestrator stand-qa');
    expect(actor('qa').title).toBe('How qa works: who acts and the rules');
    press(actor('qa'), 'click');
    qa = null;
    await openHelp('qa');
    expect(actor('qa').hasAttribute('data-warn')).toBe(true);
  });

  it('opens Who first with the tabs before Close; Escape, outside press, Close and a second click close', async () => {
    const { d } = await board();
    expect(dialog()).toBeNull();
    await openHelp('review');
    expect(actor('review').getAttribute('aria-expanded')).toBe('true');
    expect(all('[role="dialog"]')).toHaveLength(1);
    const label = document.getElementById(panel().getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('review');
    const header = [
      ...(label?.parentElement?.querySelectorAll('[id], [role="tab"], button') ?? []),
    ].map((element) => element.getAttribute('aria-label') ?? element.textContent);
    expect(header).toEqual(['review', 'Who', 'Rules', 'Close']);
    expect(tab('Who').getAttribute('aria-selected')).toBe('true');
    await showRules();
    expect(tab('Rules').getAttribute('aria-selected')).toBe('true');
    // A stream reset re-reads everything and keeps the panel open.
    d.send('event: hello\ndata: {"head":1,"instance":"one"}\n\nevent: reset\ndata: {}\n\n');
    await settle();
    expect(dialog()).not.toBeNull();
    close();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(actor('review'));
    await openHelp('review');
    expect(tab('Who').getAttribute('aria-selected')).toBe('true');

    press(document.body, 'mousedown');
    expect(dialog()).toBeNull();

    await openHelp('review');
    press(actor('review'), 'click');
    expect(dialog()).toBeNull();

    actor('review').focus();
    await openHelp('review');
    expect(panel().contains(document.activeElement)).toBe(true);
    press(document.activeElement ?? document.body, 'keydown', { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(actor('review'));
    expect(location.search).toBe('');
  });

  it('reads columns.describe on each open: Skeleton until it answers, an error Banner when it fails', async () => {
    let next = deferred();
    const { describes } = await board(() => next.promise);
    // The background read after config is still in flight; resolve it.
    next.resolve(envelope(answer()));
    await settle();
    expect(describes).toHaveLength(1);
    next = deferred();
    await openHelp('review');
    expect(describes).toEqual([{ project: 'a' }, { project: 'a' }]);
    const body = () => panel().querySelector<HTMLElement>('[role="tabpanel"] > div');
    expect(body()?.getAttribute('aria-busy')).toBe('true');
    expect(body()?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(panel().textContent).not.toContain('Acts here');
    next.resolve(envelope(answer()));
    await settle();
    expect(body()?.hasAttribute('aria-busy')).toBe(false);
    expect(titles()).toContain('Acts here');
    close();

    next = deferred();
    await openHelp('review');
    next.resolve(await failure());
    await settle();
    const alert = panel().querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      'Could not read the column rules.Close the panel and open it again to read them again.',
    );
    expect(panel().textContent).not.toContain('Acts here');
    // The board shows no error banner of its own: the read never marks the board failed.
    expect(all('[role="alert"]')).toEqual([alert]);
    close();

    next = deferred();
    await openHelp('review');
    next.resolve(envelope({ projects: [] }));
    await settle();
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read the column rules.',
    );
    expect(describes).toHaveLength(4);
  });

  it('Dev: eight conditions inside the panel body, the words of the Why table', async () => {
    await board();
    await openHelp('dev');
    expect(part('Acts here').textContent).toContain('The worker of the task takes the turn.');
    await showRules();
    const rules = part('Leaves to review when all hold');
    const rows = [...rules.querySelectorAll('ol > li')];
    expect(panel().querySelector('[role="tabpanel"]')?.contains(rules)).toBe(true);
    expect(rows.map((li) => [...li.children].map((child) => child.textContent))).toEqual(
      DEV_CONDITIONS.map(([id, words]) => [words, `Rule ${id}.`]),
    );
  });

  it('Review: orchestrator with its project and role, the chain, silent minutes, returns and limits', async () => {
    await board();
    await openHelp('review');
    const acts = part('Acts here');
    expect(acts.querySelector('p')?.textContent).toBe(
      'orchestrator · Spur project stand-review · role orchestrator',
    );
    expect(acts.textContent).toContain('A session of stand-review takes the turn.');
    const steps = [...(part('Questions go').querySelector('p')?.children ?? [])]
      .filter((span) => span.textContent !== '→')
      .map((span) => span.textContent);
    expect(steps.join(' → ')).toBe('stand-review → Curator → operator');
    expect(part('When the executor is silent').querySelector('p')?.textContent).toBe(
      'A reminder after 30 min of a quiet turn; with no live session, an item in your inbox after 15 min.',
    );
    await showRules();
    const returns = part('Returns to dev when any holds');
    expect([...returns.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'The reviewer requests changes.',
      'A thread is unresolved.',
    ]);
    expect(part('Limits').querySelector('p')?.textContent).toBe(
      '3 returns, then the task stops for the operator. After 2 returns Curator checks the course.',
    );
    expect(part('Leaves to external-review when').textContent).toContain('Review on the head');
  });

  it('External Review: the dispatcher text, no chain, "Approved by an external reviewer"', async () => {
    await board();
    await openHelp('external-review');
    const acts = part('Acts here');
    expect(acts.querySelector('p')?.textContent).toBe('dispatcher');
    expect(acts.textContent).toContain('nobody takes a turn');
    expect(titles()).toEqual(['Acts here']);
    await showRules();
    const rows = [...part('Leaves to qa when').querySelectorAll('li')];
    expect(rows.map((li) => [...li.children].map((child) => child.textContent))).toEqual([
      ['Approved', 'Approved by an external reviewer.'],
    ]);
  });

  it('QA: a live session link, or the No live session banner', async () => {
    let qa: { id: string; links: never[] } | null = qaSession;
    await board(() => Promise.resolve(envelope(answer(qa))));
    await openHelp('qa');
    const link = part('Acts here').querySelector('a');
    expect(link?.getAttribute('href')).toBe(`${SPUR}/sessions/s-qa`);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.classList.contains(focusRing)).toBe(true);
    expect(link?.textContent).toBe('s-qa');
    expect(part('Acts here').textContent).toContain('live session');
    close();
    qa = null;
    await openHelp('qa');
    const warning = part('Acts here').querySelector('[role="status"]');
    expect(warning?.textContent).toBe(
      'No live sessionStart a session of stand-qa; open turns wait until then.',
    );
    expect(part('Acts here').querySelector('a')).toBeNull();
    expect(actor('qa').hasAttribute('data-warn')).toBe(true);
  });

  it('ready-to-merge: waits until merged, then leaves to done by the completion route', async () => {
    await board();
    await openHelp('ready-to-merge');
    expect(part('Acts here').querySelector('p')?.textContent).toBe('operator');
    expect(titles()).toEqual(['Acts here']);
    await showRules();
    expect(titles()).toEqual(['Waits here until', 'Leaves to done by the completion route']);
    expect(part('Waits here until').querySelector('li > span')?.textContent).toBe('Merged');
    expect(part('Leaves to done by the completion route').textContent).toContain(
      'A merged PR with a done ticket completes the task.',
    );
    expect(panel().textContent).not.toMatch(/Leaves to done when/);
  });

  it('Backlog part: who moves tasks in and leaves when work has started, unfolded and folded', async () => {
    await board();
    await openHelp('todo');
    const moves = part('Moves tasks here');
    expect(moves.querySelector('b')?.textContent).toBe('manual');
    expect(moves.textContent).toContain('The operator moves tasks here by hand, with a reason.');
    expect(titles()).toEqual(['Moves tasks here']);
    await showRules();
    expect(titles()).toEqual(['Leaves to dev when']);
    expect(part('Leaves to dev when').querySelector('li > span')?.textContent).toBe('Work started');
    close();
    fold();
    await openHelp('triage');
    expect(part('Moves tasks here').querySelector('b')?.textContent).toBe('manual');
    expect(titles()).toEqual(['Moves tasks here']);
  });

  it('no Returns and no Limits without returns, even with limits', async () => {
    const limited = answer();
    const qa = limited.projects[0]?.columns.find(({ id }) => id === 'qa');
    if (!qa) throw new Error('no qa');
    qa.limits = {
      cycleLimit: 3,
      courseCheck: 0,
      courseCheckTo: { ...destination('operator', null), role: 'operator' },
    };
    await board(() => Promise.resolve(envelope(limited)));
    await openHelp('qa');
    await showRules();
    expect(titles()).toEqual(['Leaves to ready-to-merge when']);
  });
});
