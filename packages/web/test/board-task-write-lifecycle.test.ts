// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createBoardData } from '../src/board/data.ts';
import { block, daemon, deferred, envelope, problem, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();
const draft = ' newer\nunsent text ';
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const item = () => dialog()?.querySelector<HTMLElement>('article');
function field(answer: boolean) {
  const found = dialog()?.querySelector<HTMLTextAreaElement>(
    answer ? 'article textarea' : '[aria-label="Comment"]',
  );
  // FormRow supplies an id/label rather than aria-label.
  const commentField = [...(dialog()?.querySelectorAll('textarea') ?? [])].at(-1);
  const input = answer ? found : commentField;
  if (!input) throw new Error('no write field');
  return input;
}
function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function submit(input: HTMLTextAreaElement) {
  act(() => {
    input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function selectTab(label: string) {
  const tab = [...(dialog()?.querySelectorAll('[role="tab"]') ?? [])].find(
    (candidate) => candidate.textContent === label,
  );
  if (!tab) throw new Error(`no ${label} tab`);
  press(tab, 'click');
  await settle();
}
async function open(extra: Record<string, unknown> = {}) {
  const d = daemon();
  const writes: { path: string; key: string }[] = [];
  d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ blocks: [block()], ...extra })));
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  mount({
    ...d,
    fetcher: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path.endsWith('/block.answer') || path.endsWith('/comment.add')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          key: string;
        };
        writes.push({ path, key: body.key });
      }
      return d.fetcher(url, init);
    },
  });
  await settle();
  const setCanonical = (next: Record<string, unknown>) => {
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ blocks: [block()], ...next })));
  };
  const refresh = async () => {
    d.send('event: reset\ndata: {}\n\n');
    await settle();
  };
  return { d, writes, setCanonical, refresh };
}
const changes = [
  {
    name: 'answered',
    extra: { blocks: [block({ state: 'unblocked', outcome: 'done', answeredVia: 'web' })] },
  },
  { name: 'withdrawn', extra: { blocks: [block({ state: 'unblocked', outcome: 'withdrawn' })] } },
  { name: 'retargeted', extra: { blocks: [block({ addressee: 'worker' })] } },
  {
    name: 'archived',
    extra: {
      task: { ...taskGet().task, membership: 'archived' },
      blocks: [block({ state: 'unblocked', outcome: 'archived' })],
    },
  },
];
const phases = [
  'idle',
  'pending',
  'pending-unchanged',
  'uncertain',
  'uncertain-unchanged',
  'confirmed-newer',
  'confirmed-unchanged',
] as const;

describe('canonical write eligibility lifecycle', () => {
  it.each(
    changes.flatMap((change) =>
      phases
        .filter(
          (phase) =>
            !(['withdrawn', 'retargeted'].includes(change.name) && phase.startsWith('confirmed')),
        )
        .flatMap((phase) => [false, true].map((history) => ({ ...change, phase, history }))),
    ),
  )(
    '$name during $phase, History roundtrip=$history preserves the unsent revision without another write',
    async ({ name, extra, phase, history: visitHistory }) => {
      const { d, writes, setCanonical, refresh } = await open();
      const accepted = d.routes['block.answer'];
      const held = deferred();
      d.routes['block.answer'] = () => held.promise;
      type(field(true), 'submitted');
      if (phase !== 'idle') {
        submit(field(true));
        if (!phase.endsWith('unchanged')) type(field(true), draft);
      }
      if (phase.startsWith('uncertain')) {
        held.resolve(await problem('outcome_unknown', 500));
        await settle();
      }
      const canonical =
        name === 'archived' && phase.startsWith('confirmed')
          ? {
              ...extra,
              blocks: [block({ state: 'unblocked', outcome: 'done', answeredVia: 'web' })],
            }
          : extra;
      setCanonical(canonical);
      if (phase.startsWith('confirmed')) {
        held.resolve(await accepted({}));
        await settle();
      } else await refresh();
      if (visitHistory) {
        await selectTab('History');
        expect(dialog()?.querySelector('table')).not.toBeNull();
        await selectTab('Now');
      }
      const expected =
        phase === 'idle'
          ? 'submitted'
          : phase === 'confirmed-unchanged'
            ? ''
            : phase.endsWith('unchanged')
              ? 'submitted'
              : draft;
      expect(item()?.querySelector('form')).toBeNull();
      const retained = item()?.querySelector('[aria-label="Retained draft: Answer B12"]');
      if (expected === '') expect(retained).toBeNull();
      else {
        expect(retained?.querySelector('p')?.textContent).toBe(expected);
        expect(retained?.textContent).toContain(
          phase.endsWith('unchanged') ? 'Answer draft (unconfirmed)' : 'Unsent answer draft',
        );
        expect(retained?.querySelector('textarea, button, form')).toBeNull();
      }
      if (name === 'archived') {
        expect(field(false).disabled).toBe(true);
        expect(dialog()?.textContent).toContain('This task is archived.');
        submit(field(false));
      }
      if (phase.startsWith('uncertain'))
        expect(item()?.querySelector('[role="alert"]')?.textContent).toContain('outcome_unknown');
      if (phase.startsWith('confirmed'))
        expect(item()?.querySelector('[role="status"]')?.textContent).toContain('Answer sent.');
      expect(writes).toHaveLength(phase === 'idle' ? 0 : 1);
      if (phase.startsWith('pending')) {
        if (name === 'answered') held.resolve(await accepted({}));
        else
          held.resolve(
            await problem(name === 'archived' ? 'task_archived' : 'outcome_unknown', 500),
          );
        await settle();
        const retained = item()?.querySelector('[aria-label="Retained draft: Answer B12"]');
        if (phase.endsWith('unchanged') && name === 'answered') expect(retained).toBeNull();
        else
          expect(retained?.querySelector('p')?.textContent).toBe(
            phase.endsWith('unchanged') ? 'submitted' : draft,
          );
        expect(
          item()?.querySelector(name === 'answered' ? '[role="status"]' : '[role="alert"]')
            ?.textContent,
        ).toContain(
          name === 'answered'
            ? 'Answer sent.'
            : name === 'archived'
              ? 'task_archived'
              : 'outcome_unknown',
        );
        expect(writes).toHaveLength(1);
      }
      if (name === 'retargeted') {
        setCanonical({});
        await refresh();
        expect(field(true).value).toBe(expected);
        expect(field(true).disabled).toBe(false);
        expect(writes).toHaveLength(phase === 'idle' ? 0 : 1);
      } else if (name === 'archived') {
        setCanonical({ ...canonical, task: taskGet().task });
        await refresh();
        expect(item()?.querySelector('form')).toBeNull();
        expect(field(false).disabled).toBe(false);
        if (expected !== '')
          expect(
            item()?.querySelector('[aria-label="Retained draft: Answer B12"] p')?.textContent,
          ).toBe(expected);
      }
    },
  );

  it.each([false, true])(
    'an initially archived deep link blocks both writes (answer=%s)',
    async (answer) => {
      const { writes } = await open(changes[3]?.extra);
      expect(item()?.querySelector('form')).toBeNull();
      expect(field(false).disabled).toBe(true);
      expect(dialog()?.textContent).toContain('This task is archived.');
      if (!answer) submit(field(false));
      await settle();
      expect(writes).toHaveLength(0);
      await selectTab('History');
      expect(dialog()?.querySelector('table')).not.toBeNull();
    },
  );

  it.each(
    [false, true].flatMap((answer) =>
      ['idle', 'pending', 'failed'].map((phase) => ({ answer, phase })),
    ),
  )(
    'archive/reactivate keeps $phase draft and availability for answer=$answer',
    async ({ answer, phase }) => {
      const { d, writes, setCanonical, refresh } = await open();
      const held = deferred();
      d.routes[answer ? 'block.answer' : 'comment.add'] = () => held.promise;
      type(field(answer), draft);
      if (phase !== 'idle') {
        submit(field(answer));
        if (answer) type(field(answer), draft + ' edited');
      }
      if (phase === 'failed') {
        held.resolve(await problem('outcome_unknown', 500));
        await settle();
      }
      setCanonical(changes[3]?.extra ?? {});
      await refresh();
      if (answer) {
        expect(item()?.querySelector('form')).toBeNull();
        expect(
          item()?.querySelector('[aria-label="Retained draft: Answer B12"] p')?.textContent,
        ).toBe(phase === 'idle' ? draft : draft + ' edited');
      } else {
        expect(field(false).disabled).toBe(true);
        expect(field(false).value).toBe(draft);
      }
      expect(dialog()?.textContent).toContain('This task is archived.');
      if (!answer) submit(field(false));
      await settle();
      expect(writes).toHaveLength(phase === 'idle' ? 0 : 1);
      setCanonical({ blocks: [block({ state: 'unblocked', outcome: 'archived' })] });
      await refresh();
      if (answer) {
        expect(item()?.querySelector('form')).toBeNull();
        expect(
          item()?.querySelector('[aria-label="Retained draft: Answer B12"] p')?.textContent,
        ).toBe(phase === 'idle' ? draft : draft + ' edited');
      } else {
        expect(field(false).disabled).toBe(false);
        expect(field(false).value).toBe(draft);
      }
      if (phase === 'failed' && !answer) {
        submit(field(answer));
        await settle();
        expect(writes[1]?.key).toBe(writes[0]?.key);
      }
    },
  );

  it.each([false, true])(
    'archive does not block read-only recovery of a confirmed write (answer=%s)',
    async (answer) => {
      const { d, writes, setCanonical } = await open();
      d.routes['task.get'] = () => problem('unexpected', 500);
      type(field(answer), 'submitted');
      submit(field(answer));
      type(field(answer), draft);
      await settle();
      const recovery = [...(dialog()?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Refresh task',
      );
      if (!recovery) throw new Error('no read-only recovery');
      setCanonical({
        task: { ...taskGet().task, membership: 'archived' },
        blocks: [block({ state: 'unblocked', outcome: answer ? 'done' : 'archived' })],
      });
      press(recovery, 'click');
      await settle();
      if (answer) {
        expect(item()?.querySelector('form')).toBeNull();
        expect(
          item()?.querySelector('[aria-label="Retained draft: Answer B12"] p')?.textContent,
        ).toBe(draft);
      } else {
        expect(field(false).value).toBe(draft);
        expect(field(false).disabled).toBe(true);
      }
      expect(dialog()?.textContent).toContain('This task is archived.');
      expect(writes).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'controller rechecks archive membership before transport, but allows reads (answer=%s)',
    async (answer) => {
      const d = daemon();
      let membership = 'active';
      let writes = 0;
      d.routes['task.get'] = () =>
        Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, membership } })));
      const data = createBoardData({
        fetch: (url, init) => {
          const path = url instanceof Request ? url.url : url.toString();
          if (path.endsWith('/comment.add') || path.endsWith('/block.answer')) writes++;
          return d.fetcher(url, init);
        },
        storage: () => ({ getItem: () => null, setItem: () => undefined }),
        now: () => 0,
      });
      try {
        data.start();
        data.open('ex/repo#7');
        await settle();
        const intent = answer
          ? data.answerIntent('ex/repo#7', 'B12', draft)
          : data.commentIntent('ex/repo#7', draft);
        membership = 'archived';
        expect(await data.refreshTask()).toBe(true);
        await expect(intent.run()).rejects.toThrow('archived');
        expect(writes).toBe(0);
        membership = 'out_of_filter';
        expect(await data.refreshTask()).toBe(true);
        const result = await intent.run();
        expect(await result.refresh).toBe(true);
        expect(writes).toBe(1);
      } finally {
        data.stop();
      }
    },
  );
});
