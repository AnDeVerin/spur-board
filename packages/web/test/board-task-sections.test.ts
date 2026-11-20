// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { daemon, envelope, orchestratorTaskGet, taskGet, type Daemon } from './board-fixtures.ts';
import { mount, mountEachTest, one, press, remount, settle } from './board-harness.ts';

mountEachTest();

const TITLES = {
  why: 'Why it is here',
  turn: 'Turn',
  submission: 'Latest submission',
  blocks: 'Blocks',
  comments: 'Comments',
} as const;
type Id = keyof typeof TITLES;
const IDS = Object.keys(TITLES) as Id[];
const DEFAULTS: Record<Id, boolean> = {
  why: true,
  turn: true,
  submission: false,
  blocks: true,
  comments: true,
};

const submission = {
  column: 'review' as const,
  at: '2026-11-15T13:00:00.000Z',
  sha: 'b'.repeat(40),
  basis: 'tested' as const,
  from: null,
  testedOrigin: null,
  reason: null,
  pending: false,
  voided: false,
};
/** An orchestrator task with a turn and a submission, so all five sections show. */
const answer = (key = 'ex/repo#7') =>
  orchestratorTaskGet({}, { task: { ...taskGet().task, key, column: 'review' }, submission });

const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no task view');
  return found;
};
const chevron = (id: Id) => {
  const section = [...dialog().querySelectorAll('section')].find(
    (candidate) => candidate.querySelector('[id$="-title"]')?.textContent === TITLES[id],
  );
  const found = section?.querySelector<HTMLElement>('button[aria-expanded]');
  if (!found) throw new Error(`no ${TITLES[id]} section`);
  return found;
};
const expanded = (id: Id) => chevron(id).getAttribute('aria-expanded') === 'true';
const states = () => Object.fromEntries(IDS.map((id) => [id, expanded(id)]));

/** Serves `answer` for whichever task is read and opens ex/repo#7, counting daemon calls. */
async function open(storage: Parameters<typeof mount>[1] = {}, d: Daemon = daemon()) {
  const calls: string[] = [];
  d.routes['task.get'] = (input) =>
    Promise.resolve(envelope(answer((input as { task: string }).task)));
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  const stored = mount(
    {
      ...d,
      fetcher: (url, init) => {
        calls.push(url instanceof Request ? url.url : url.toString());
        return d.fetcher(url, init);
      },
    },
    storage,
  );
  await settle();
  return { d, calls, stored };
}

describe('task view sections', () => {
  it('defaults with nothing stored', async () => {
    await open();
    expect(states()).toEqual(DEFAULTS);
  });

  it('starts each section from its stored state', async () => {
    const stored = Object.fromEntries(
      IDS.map((id) => [`board-section:${id}`, DEFAULTS[id] ? 'closed' : 'open']),
    );
    await open(stored);
    expect(states()).toEqual(Object.fromEntries(IDS.map((id) => [id, !DEFAULTS[id]])));
    for (const id of IDS)
      expect(document.getElementById(chevron(id).getAttribute('aria-controls') ?? '')?.hidden).toBe(
        DEFAULTS[id],
      );
  });

  it('writes on click and double-click, once per toggle', async () => {
    const writes: [string, string][] = [];
    await open(() => ({
      getItem: () => null,
      setItem: (key, value) => {
        writes.push([key, value]);
      },
    }));
    expect(writes).toEqual([]);
    press(chevron('blocks'), 'click');
    expect(writes).toEqual([['board-section:blocks', 'closed']]);
    const title = chevron('blocks').parentElement?.querySelector('[id$="-title"]');
    if (!title) throw new Error('no Blocks title');
    press(title, 'dblclick');
    expect(writes).toEqual([
      ['board-section:blocks', 'closed'],
      ['board-section:blocks', 'open'],
    ]);
    press(chevron('blocks'), 'dblclick');
    expect(writes).toHaveLength(2);
    expect(expanded('blocks')).toBe(true);
  });

  it('a section closed on one task stays closed on another and after a reload', async () => {
    const { d, calls, stored } = await open();
    const before = calls.length;
    press(chevron('blocks'), 'click');
    press(chevron('submission'), 'click');
    await settle();
    expect(calls).toHaveLength(before);
    expect(Object.fromEntries(stored)).toEqual({
      'board-section:blocks': 'closed',
      'board-section:submission': 'open',
    });
    const close = dialog().querySelector('button[aria-label="Close"]');
    if (!close) throw new Error('no task close button');
    press(close, 'click');
    await settle();
    press(one('main a[title="ex/repo#99"]'), 'click');
    await settle();
    expect(location.search).toBe('?open=ex%2Frepo%2399');
    expect(states()).toEqual({ ...DEFAULTS, blocks: false, submission: true });
    remount();
    await open(Object.fromEntries(stored), d);
    expect(states()).toEqual({ ...DEFAULTS, blocks: false, submission: true });
  });

  it('throwing storage falls back to defaults', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    await open(() => ({ getItem: denied, setItem: denied }));
    expect(states()).toEqual(DEFAULTS);
    press(chevron('blocks'), 'click');
    press(chevron('submission'), 'click');
    expect(states()).toEqual({ ...DEFAULTS, blocks: false, submission: true });
    expect(dialog().querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('reads an unknown stored value as the default', async () => {
    await open(Object.fromEntries(IDS.map((id) => [`board-section:${id}`, 'bogus'])));
    expect(states()).toEqual(DEFAULTS);
  });
});
