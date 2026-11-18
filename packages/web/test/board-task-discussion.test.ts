// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../src/board/Board.tsx';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import taskStyles from '../src/board/TaskView.module.css';
import {
  block,
  comment,
  config,
  daemon,
  deferred,
  envelope,
  hello,
  problem,
  taskGet,
  type Daemon,
} from './board-fixtures.ts';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let data: BoardData;
let calls: { path: string; input: unknown; key?: string }[] = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  history.replaceState(null, '', '/');
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  data.stop();
  container.remove();
  document.body.replaceChildren();
  calls = [];
  vi.useRealTimers();
  history.replaceState(null, '', '/');
});
function mount(d: Daemon) {
  data = createBoardData({
    fetch: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        input?: unknown;
        key?: string;
      };
      calls.push({ path, input: body.input, ...(body.key === undefined ? {} : { key: body.key }) });
      return d.fetcher(url, init);
    },
    storage: () => ({ getItem: () => null, setItem: () => undefined }),
    now: () => Date.parse('2026-11-15T14:00:00.000Z'),
  });
  act(() => {
    root.render(createElement(Board, { data }));
    data.start();
  });
  return data;
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
function inDialog(selector: string) {
  const found = dialog()?.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}
function card() {
  const found = document.querySelector('main a[title="ex/repo#7"]');
  if (!found) throw new Error('no card');
  return found;
}
function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const field = (answer = false) =>
  inDialog(answer ? 'article textarea' : 'textarea') as HTMLTextAreaElement;
const typeText = (input: HTMLTextAreaElement, text: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = (input: HTMLTextAreaElement) => {
  act(() => {
    input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
const writes = () =>
  calls.filter(({ path }) => path.endsWith('/block.answer') || path.endsWith('/comment.add'));
async function discussion(extra: Record<string, unknown> = {}) {
  const d = daemon();
  d.routes['task.get'] = () => Promise.resolve(envelope(taskGet(extra)));
  const data = mount(d);
  await settle();
  click(card());
  await settle();
  return { d, data };
}

describe('task discussion', () => {
  it.each(
    (['idle', 'pending', 'uncertain', 'refreshing', 'refresh-failed'] as const).flatMap((state) =>
      [false, true].map((answer) => ({ state, answer })),
    ),
  )(
    'tab navigation preserves $state draft and intent (answer=$answer)',
    async ({ state, answer }) => {
      const { d } = await discussion({ blocks: answer ? [block()] : [] });
      const operation = answer ? 'block.answer' : 'comment.add';
      const accepted = d.routes[operation];
      const mutation = deferred();
      const read = deferred();
      d.routes[operation] = () => mutation.promise;
      const draft = ' exact\nintent text ';
      typeText(field(answer), draft);
      if (state !== 'idle') {
        submit(field(answer));
        await settle();
        if (state === 'uncertain') {
          mutation.resolve(await problem('outcome_unknown', 500));
          await settle();
        } else if (state === 'refreshing' || state === 'refresh-failed') {
          d.routes['task.get'] = () => read.promise;
          mutation.resolve(await accepted({}));
          await settle();
          if (state === 'refresh-failed') {
            read.resolve(await problem('unexpected', 500));
            await settle();
          }
        }
      }
      const select = (label: string) => {
        const tab = [...(dialog()?.querySelectorAll('[role="tab"]') ?? [])].find(
          (candidate) => candidate.textContent === label,
        );
        if (!tab) throw new Error(`no ${label} tab`);
        click(tab);
      };
      const beforeHistory = calls.length;
      select('History');
      await settle();
      expect(inDialog('[role="tab"][aria-selected="true"]').textContent).toBe('History');
      expect(calls.slice(beforeHistory)).toEqual([
        { path: '/v1/ops/task.history', input: { task: 'ex/repo#7' } },
      ]);
      expect(inDialog('table[aria-label="Task history"]').textContent).toContain('operator (web)');
      select('Now');
      expect(field(answer).value).toBe(draft);
      if (state === 'uncertain')
        expect(inDialog('[role="alert"]').textContent).toContain('outcome_unknown');
      if (state === 'refreshing' || state === 'refresh-failed') {
        expect(inDialog('[role="status"]').textContent).toContain(
          answer ? 'Answer sent.' : 'Comment added.',
        );
        expect(inDialog('[role="status"]').textContent).toContain(
          state === 'refreshing' ? 'Refreshing task…' : 'Could not refresh the task.',
        );
      }
      submit(field(answer));
      await settle();
      const count = state === 'idle' ? 1 : state === 'uncertain' ? 2 : 1;
      expect(writes()).toHaveLength(count);
      expect(field(answer).value).toBe(draft);
      if (state === 'uncertain') expect(writes()[1]?.key).toBe(writes()[0]?.key);
      expect(writes()[0]?.input).toEqual(
        answer ? { block: 'B12', text: draft } : { task: 'ex/repo#7', text: draft },
      );
      if (state === 'refresh-failed') {
        const recovery = deferred();
        d.routes['task.get'] = () => recovery.promise;
        const refresh = [...(dialog()?.querySelectorAll('button') ?? [])].find(
          (button) => button.textContent === 'Refresh task',
        );
        if (!refresh) throw new Error('no read-only recovery action');
        click(refresh);
        await settle();
        expect(writes()).toHaveLength(1);
        expect(inDialog('[role="status"]').textContent).toContain('Refreshing task…');
      }
    },
  );

  it('unchanged uncertain retries reuse UUID, edited drafts create a new UUID', async () => {
    const { d } = await discussion();
    d.routes['comment.add'] = () => problem('outcome_unknown', 500);
    const input = field();
    typeText(input, 'first');
    submit(input);
    await settle();
    submit(input);
    await settle();
    typeText(input, 'edited');
    submit(input);
    await settle();
    expect(writes()).toHaveLength(3);
    expect(writes()[1]?.key).toBe(writes()[0]?.key);
    expect(writes()[2]?.key).not.toBe(writes()[0]?.key);
    expect(writes()[2]?.input).toEqual({ task: 'ex/repo#7', text: 'edited' });
  });

  it('offline disables both forms, a short reconnect does not, and recovery preserves drafts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { d, data } = await discussion({ blocks: [block()] });
    const inputs = [...(dialog()?.querySelectorAll('textarea') ?? [])];
    for (const input of inputs) typeText(input, 'draft');
    d.send(hello);
    await settle();
    d.failStream();
    d.endStream();
    await settle();
    for (const input of inputs) expect(input.disabled).toBe(false);
    for (const delay of [500, 1000, 2000, 4000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
      await settle();
    }
    expect(data.snapshot().stream).toBe('offline');
    expect(data.snapshot().readFailed).toBe(false);
    for (const input of inputs) {
      expect(input.disabled).toBe(true);
      expect(input.value).toBe('draft');
      submit(input);
    }
    expect(writes()).toHaveLength(0);
    expect(dialog()?.textContent).toContain('Live updates are lost.');
    d.recoverStream();
    act(() => {
      data.retry();
    });
    await settle();
    d.send(hello);
    await settle();
    expect(data.snapshot().stream).toBe('live');
    for (const input of inputs) {
      expect(input.disabled).toBe(false);
      expect(input.value).toBe('draft');
    }
  });

  it('network rejection retains edits made while a send was pending', async () => {
    const { d } = await discussion();
    let reject!: (error: Error) => void;
    d.routes['comment.add'] = () =>
      new Promise<Response>((_resolve, no) => {
        reject = no;
      });
    const input = field();
    typeText(input, 'first');
    submit(input);
    typeText(input, 'newer\n draft ');
    reject(new Error('Network unavailable'));
    await settle();
    expect(input.value).toBe('newer\n draft ');
    expect(inDialog('[role="alert"]').textContent).toBe('Network unavailable');
  });

  it('uses configured agent display names with project/session fallbacks', async () => {
    const { d, data } = await discussion({
      blocks: [block()],
      comments: [comment({ author: 'agent:unknown/s2' })],
    });
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({
          ...config,
          projects: config.projects.map((project) => ({
            ...project,
            spurProjects: [{ name: 'worker', role: 'worker', displayName: 'Builder' }],
          })),
        }),
      );
    act(() => {
      data.retry();
    });
    await settle();
    expect(dialog()?.textContent).toContain('Builder / s1');
    expect(dialog()?.textContent).toContain('unknown / s2');
  });

  it('empty sections show zero counts and retain a usable comment composer', async () => {
    await discussion();
    const sections = [...(dialog()?.querySelectorAll('section') ?? [])];
    expect(sections[1]?.textContent).toContain('Blocks00 open');
    expect(sections[1]?.textContent).toContain('No blocks on this task.');
    expect(sections[2]?.textContent).toContain('Comments0');
    expect(sections[2]?.textContent).toContain('No comments on this task.');
    expect(field().disabled).toBe(false);
    typeText(field(), 'first comment');
    expect(field().closest('form')?.querySelector('button')?.disabled).toBe(false);
  });

  it('open-first blocks, eligibility, closure channels, every reply in order and task comments', async () => {
    await discussion({
      blocks: [
        block({ id: 'B10', state: 'unblocked', outcome: 'done', answeredVia: 'slack' }),
        block(),
        block({ id: 'B13', addressee: 'worker' }),
        block({ id: 'B14', state: 'unblocked', outcome: 'withdrawn', answeredVia: 'web' }),
        block({ id: 'B15', state: 'unblocked', outcome: 'done', answeredVia: 'web' }),
        block({ id: 'B16', state: 'unblocked', outcome: 'done', answeredVia: 'cli' }),
        block({ id: 'B17', state: 'unblocked', outcome: 'done', answeredVia: 'mcp' }),
      ],
      comments: [
        comment({ block: 'B10', text: 'old reply' }),
        comment({ id: 'C2', block: 'B10', text: 'latest reply' }),
        comment({ id: 'C3' }),
      ],
    });
    const items = [...(dialog()?.querySelectorAll('article') ?? [])];
    expect(items.map((item) => item.querySelector('strong')?.textContent).slice(0, 7)).toEqual([
      'B12',
      'B13',
      'B10',
      'B14',
      'B15',
      'B16',
      'B17',
    ]);
    expect(dialog()?.querySelectorAll('textarea')).toHaveLength(2);
    expect(items[2]?.querySelector('form')).toBeNull();
    expect(items[2]?.textContent).toContain('answered via Slack');
    expect(
      [...(items[2]?.querySelectorAll(`.${taskStyles.reply ?? ''} > p`) ?? [])].map(
        (reply) => reply.textContent,
      ),
    ).toEqual(['old reply', 'latest reply']);
    expect(items[3]?.textContent).toContain('withdrawn');
    expect(items[3]?.textContent).not.toContain('answered');
    expect(items[4]?.textContent).toContain('answered via web');
    expect(items[5]?.textContent).toContain('answered via cli');
    expect(items[6]?.textContent).toContain('answered via mcp');
    expect(items[7]?.textContent).toContain('C3 · you');
    expect(dialog()?.textContent).not.toContain('No comments on this task.');
  });

  it.each([false, true])(
    'validates exact drafts locally and accepts 20,000 characters (answer=%s)',
    async (answer) => {
      const { d } = await discussion({ blocks: answer ? [block()] : [] });
      d.routes[answer ? 'block.answer' : 'comment.add'] = () => deferred().promise;
      const input = field(answer);
      for (const invalid of ['', ' \n ', 'x'.repeat(20_001)]) {
        typeText(input, invalid);
        submit(input);
        await settle();
        expect(writes()).toHaveLength(0);
        expect(input.value).toBe(invalid);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(inDialog('[role="alert"]').textContent).toMatch(/Enter text|20,000/);
      }
      typeText(input, 'x'.repeat(20_000));
      submit(input);
      submit(input);
      await settle();
      expect(writes()).toHaveLength(1);
      expect(writes()[0]?.input).toEqual(
        answer
          ? { block: 'B12', text: 'x'.repeat(20_000) }
          : { task: 'ex/repo#7', text: 'x'.repeat(20_000) },
      );
      expect(input.closest('form')?.querySelector('button')?.getAttribute('aria-busy')).toBe(
        'true',
      );
    },
  );

  it.each([false, true])(
    'failed sends retain exact draft and announce errors (answer=%s)',
    async (answer) => {
      const { d } = await discussion({ blocks: answer ? [block()] : [] });
      d.routes[answer ? 'block.answer' : 'comment.add'] = () => problem('outcome_unknown', 500);
      const input = field(answer);
      typeText(input, ' exact\ntext ');
      submit(input);
      await settle();
      expect(input.value).toBe(' exact\ntext ');
      expect(inDialog('[role="alert"]').textContent).toContain('outcome_unknown');
      submit(input);
      await settle();
      expect(writes()).toHaveLength(2);
    },
  );

  it('confirmed success retains newer drafts and offers read-only refresh recovery', async () => {
    const { d } = await discussion();
    const held = deferred();
    d.routes['comment.add'] = () => held.promise;
    const input = field();
    typeText(input, 'first');
    submit(input);
    typeText(input, 'newer');
    const read = deferred();
    d.routes['task.get'] = () => read.promise;
    held.resolve(envelope({ comment: comment({ text: 'first' }) }));
    await settle();
    expect(inDialog('[role="status"]').textContent).toBe('Comment added. Refreshing task…');
    expect(dialog()?.textContent).not.toContain('A task comment');
    submit(input);
    expect(writes()).toHaveLength(1);
    read.resolve(await problem('unexpected', 500));
    await settle();
    expect(inDialog('[role="status"]').textContent).toContain('Comment added. Could not refresh');
    expect(input.value).toBe('newer');
    d.routes['task.get'] = () =>
      Promise.resolve(envelope(taskGet({ comments: [comment({ text: 'first' })] })));
    const refresh = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Refresh task',
    );
    if (!refresh) throw new Error('no refresh');
    click(refresh);
    await settle();
    expect(writes()).toHaveLength(1);
    expect(input.value).toBe('newer');
    expect(dialog()?.querySelector('article')?.textContent).toContain('first');
  });

  it('daemon outage disables both forms with reasons and preserves drafts through recovery', async () => {
    const { d, data } = await discussion({ blocks: [block()] });
    const inputs = [...(dialog()?.querySelectorAll('textarea') ?? [])];
    for (const input of inputs) typeText(input, 'kept');
    d.routes['config.get'] = () => problem('unexpected', 500);
    act(() => {
      data.retry();
    });
    await settle();
    for (const input of inputs) {
      expect(input.disabled).toBe(true);
      expect(input.value).toBe('kept');
      submit(input);
    }
    expect(writes()).toHaveLength(0);
    expect(dialog()?.textContent).toContain('The board daemon does not answer.');
    d.routes['config.get'] = () => Promise.resolve(envelope(config));
    act(() => {
      data.retry();
    });
    await settle();
    for (const input of inputs) expect(input.disabled).toBe(false);
  });
});
