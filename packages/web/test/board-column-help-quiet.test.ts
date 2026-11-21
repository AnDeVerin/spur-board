// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { config, daemon, envelope, policy, policyColumn, row } from './board-fixtures.ts';
import { mount, mountEachTest, one, press, serve, settle } from './board-harness.ts';

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

const [project, other] = config.projects;
if (!project || !other) throw new Error('fixture config has two projects');
const QUIET_CONFIG = {
  ...config,
  projects: [
    {
      ...project,
      columns: ['todo', 'dev', 'external-review', 'done'].map((id) => ({
        id,
        executor: { kind: id === 'dev' ? 'worker' : 'dispatcher', name: null },
        ...(id === 'todo' ? { group: 'todo' } : {}),
      })),
    },
    other,
  ],
};
const TEXT = 'quietAfterMs (0 = off): an external-quiet: inbox item.';
const TITLE = 'When no new external round';

/** The External Review help of a board whose `columns.describe` gives it `quiet`, Who tab open. */
const openExternalHelp = async (quiet: { operatorItemAfterMs: number; text: string } | null) => {
  const d = daemon();
  serve(d, [row('E-1', 'external-review')], QUIET_CONFIG);
  d.routes['columns.describe'] = () =>
    Promise.resolve(
      envelope(
        policy('a', [
          policyColumn('todo', { group: 'todo' }),
          policyColumn('dev'),
          policyColumn('external-review', {
            escalation: { chain: [], noRecipient: null, silent: null, quiet },
          }),
          policyColumn('done'),
        ]),
      ),
    );
  mount(d);
  await settle();
  const head = [...document.querySelectorAll(`main .${styles['head'] ?? 'missing'}`)].find(
    (element) => element.querySelector('h2, h3')?.textContent === 'external-review',
  );
  const trigger = head?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!trigger) throw new Error('no external-review help trigger');
  press(trigger, 'click');
  await settle();
  return one('[role="dialog"]');
};
const titles = (panel: HTMLElement) =>
  [...panel.querySelectorAll('h4')].map((title) => title.textContent);
const quietPart = (panel: HTMLElement) =>
  [...panel.querySelectorAll('h4')]
    .find((title) => title.textContent === TITLE)
    ?.closest('section');

describe('External Review help: the no-new-external-round part', () => {
  it.each([
    { ms: 3_600_000, after: '60 min' },
    // minutes() rounds: 5.5 minutes shows as 6.
    { ms: 330_000, after: '6 min' },
    { ms: 0, after: null },
  ])('after Acts here, quietAfterMs $ms', async ({ ms, after }) => {
    const panel = await openExternalHelp({ operatorItemAfterMs: ms, text: TEXT });
    expect(titles(panel)).toEqual(['Acts here', TITLE]);
    const part = quietPart(panel);
    expect([...(part?.querySelectorAll('p') ?? [])].map((p) => p.textContent)).toEqual([
      after === null
        ? 'Off: no inbox item.'
        : `An item in your inbox after ${after} without a new external review round.`,
      TEXT,
    ]);
    expect(part?.querySelector('b')?.textContent).toBe(after ?? undefined);
  });

  it('no part when columns.describe gives no quiet policy', async () => {
    const panel = await openExternalHelp(null);
    expect(titles(panel)).toEqual(['Acts here']);
  });
});
