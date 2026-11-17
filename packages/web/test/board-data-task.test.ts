import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import {
  daemon,
  comment,
  deferred,
  envelope,
  failure,
  hello,
  problem,
  taskGet,
  taskHistory,
  type Daemon,
} from './board-fixtures.ts';

/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const started: BoardData[] = [];
let inputs: Record<string, unknown>[] = [];
let mutations: { path: string; key: string; input: unknown }[] = [];
let historyInputs: Record<string, unknown>[] = [];
/** The inputs of every `task.get` the board sent, in order. */
const taskCalls = () => inputs;
/** The inputs of every `task.history` the board sent, in order. */
const historyCalls = () => historyInputs;
function start(d: Daemon) {
  const data = createBoardData({
    fetch: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        key: string;
        input: Record<string, unknown>;
      };
      if (
        path === '/v1/ops/comment.add' ||
        path === '/v1/ops/block.answer' ||
        path === '/v1/ops/block.followup'
      )
        mutations.push({ path, ...body });
      if (path === '/v1/ops/task.get') inputs.push(body.input);
      if (path === '/v1/ops/task.history') historyInputs.push(body.input);
      return d.fetcher(url, init);
    },
    storage: () => ({ getItem: () => null, setItem: () => undefined }),
    now: () => 0,
  });
  started.push(data);
  data.start();
  return data;
}
afterEach(() => {
  for (const data of started.splice(0)) data.stop();
  inputs = [];
  mutations = [];
  historyInputs = [];
  vi.useRealTimers();
});

describe('task writes', () => {
  it('only the three narrow payloads, UUID per intent, coalesced pending, same-key retry after failure', async () => {
    const d = daemon();
    const data = start(d);
    data.open('ex/repo#7');
    await settle();
    const held = deferred();
    d.routes['comment.add'] = () => held.promise;
    const intent = data.commentIntent('ex/repo#7', ' exact\ntext ');
    const first = intent.run();
    const duplicate = intent.run();
    expect(duplicate).toBe(first);
    expect(mutations).toHaveLength(1);
    const rejected = expect(first).rejects.toThrow('outcome_unknown');
    held.resolve(await problem('outcome_unknown', 500));
    await rejected;
    d.routes['comment.add'] = () => Promise.resolve(envelope({ comment: comment() }));
    const result = await intent.run();
    expect(await result.refresh).toBe(true);
    expect(mutations[0]?.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mutations[1]?.key).toBe(mutations[0]?.key);
    expect(mutations[0]?.input).toEqual({ task: 'ex/repo#7', text: ' exact\ntext ' });
    await intent.run();
    expect(mutations).toHaveLength(2);
    const next = await data.commentIntent('ex/repo#7', 'edited').run();
    await next.refresh;
    const answer = await data.answerIntent('ex/repo#7', 'B12', 'Answer').run();
    await answer.refresh;
    await (
      await data.followUpIntent('ex/repo#7', 'B12', 'More').run()
    ).refresh;
    expect(
      new Set([mutations[0]?.key, mutations[2]?.key, mutations[3]?.key, mutations[4]?.key]).size,
    ).toBe(4);
    expect(mutations[3]).toMatchObject({
      path: '/v1/ops/block.answer',
      input: { block: 'B12', text: 'Answer' },
    });
    expect(mutations[4]).toMatchObject({
      path: '/v1/ops/block.followup',
      input: { block: 'B12', text: 'More' },
    });
    expect(taskCalls()).toHaveLength(5);
  });

  it('post-success refresh waits for the read after an overlapping stream read, then recovers without another write', async () => {
    const d = daemon();
    const data = start(d);
    data.open('ex/repo#7');
    await settle();
    const oldRead = deferred();
    d.routes['task.get'] = () => oldRead.promise;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    const result = await data.commentIntent('ex/repo#7', 'comment').run();
    let settled = false;
    void result.refresh.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    d.routes['task.get'] = () => problem('unexpected', 500);
    oldRead.resolve(envelope(taskGet()));
    await settle();
    expect(await result.refresh).toBe(false);
    expect(taskCalls()).toHaveLength(3);
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ comments: [comment()] })));
    expect(await data.refreshTask()).toBe(true);
    expect(mutations).toHaveLength(1);
    expect(data.snapshot().task?.value?.comments).toHaveLength(1);
  });

  it.each(['switch', 'close', 'stop'])(
    'late mutation completion after %s cannot refresh a different task or publish',
    async (action) => {
      const d = daemon();
      const data = start(d);
      data.open('ex/repo#7');
      await settle();
      const held = deferred();
      d.routes['comment.add'] = () => held.promise;
      const intent = data.commentIntent('ex/repo#7', 'comment');
      const pending = intent.run();
      if (action === 'switch') data.open('ex/repo#8');
      else if (action === 'close') data.open(null);
      else data.stop();
      await settle();
      const before = taskCalls().length;
      const snapshot = data.snapshot();
      held.resolve(envelope({ comment: comment() }));
      const result = await pending;
      expect(await result.refresh).toBe(false);
      await settle();
      expect(taskCalls()).toHaveLength(before);
      expect(data.snapshot()).toBe(snapshot);
      if (action !== 'stop') {
        data.open('ex/repo#7');
        await settle();
        await intent.run();
        expect(mutations).toHaveLength(1);
      }
    },
  );

  it('an intent rechecks availability and task lifetime at send time', async () => {
    const d = daemon();
    const data = start(d);
    data.open('ex/repo#7');
    await settle();
    const intent = data.commentIntent('ex/repo#7', 'comment');
    d.routes['config.get'] = () => problem('unexpected', 500);
    data.retry();
    await settle();
    await expect(intent.run()).rejects.toThrow('unavailable');
    expect(mutations).toHaveLength(0);
    data.open(null);
    data.open('ex/repo#7');
    await settle();
    await expect(intent.run()).rejects.toThrow('unavailable');
    expect(mutations).toHaveLength(0);
  });
});
describe('task read', () => {
  it('reads task.get with why for an opened task key and never for another key', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    expect(data.snapshot().task).toBeUndefined();
    data.open('ex/repo#7');
    expect(data.snapshot().task).toMatchObject({ key: 'ex/repo#7', state: 'loading' });
    await settle();
    expect(taskCalls()).toEqual([{ task: 'ex/repo#7', why: true }]);
    expect(data.snapshot().task).toMatchObject({ key: 'ex/repo#7', state: 'ready' });
    expect(data.snapshot().task?.value?.task.key).toBe('ex/repo#7');
    data.open('509');
    await settle();
    expect(data.snapshot().task).toEqual({
      key: '509',
      state: 'missing',
      value: undefined,
      retrying: false,
    });
    expect(taskCalls()).toHaveLength(1);
    data.retryTask();
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(taskCalls()).toHaveLength(1);
    data.open(null);
    expect(data.snapshot().task).toBeUndefined();
  });

  it('re-reads on an invalidate naming the open task, a reset and Retry now, not for another task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    d.routes['task.get'] = () =>
      Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#7' } })));
    const data = start(d);
    await settle();
    d.send(hello);
    await settle();
    // A short key: task.get answers the canonical key, which the stream names.
    data.open('repo#7');
    await settle();
    expect(taskCalls()).toHaveLength(1);
    const invalidate = async (tasks: string[]) => {
      d.send(`event: invalidate\ndata: ${JSON.stringify({ projects: [], tasks })}\n\n`);
      await settle();
      await vi.advanceTimersByTimeAsync(400);
      await settle();
    };
    await invalidate(['ex/repo#7']);
    expect(taskCalls()).toHaveLength(2);
    await invalidate(['repo#7']);
    expect(taskCalls()).toHaveLength(3);
    await invalidate(['ex/repo#8']);
    expect(taskCalls()).toHaveLength(3);
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(taskCalls()).toHaveLength(4);
    data.retry();
    await settle();
    expect(taskCalls()).toHaveLength(5);
    data.open(null);
    await invalidate(['ex/repo#7']);
    expect(taskCalls()).toHaveLength(5);
  });

  it('a not_found or wrong_id_kind answer is missing; a failure keeps the last good value', async () => {
    const d = daemon();
    d.routes['task.get'] = () => problem('not_found');
    const data = start(d);
    await settle();
    data.open('ex/repo#404');
    await settle();
    expect(data.snapshot().task).toMatchObject({ state: 'missing', value: undefined });
    d.routes['task.get'] = () => problem('wrong_id_kind', 400);
    data.open('T4');
    await settle();
    expect(data.snapshot().task).toMatchObject({ key: 'T4', state: 'missing' });
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet()));
    data.open('ex/repo#7');
    await settle();
    const good = data.snapshot().task?.value;
    expect(good).toBeDefined();
    d.routes['task.get'] = () => problem('unexpected', 500);
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().task).toEqual({
      key: 'ex/repo#7',
      state: 'failed',
      value: good,
      retrying: false,
    });
    const held = deferred();
    d.routes['task.get'] = () => held.promise;
    data.retryTask();
    expect(data.snapshot().task).toMatchObject({ state: 'loading', value: good, retrying: true });
    held.resolve(envelope(taskGet()));
    await settle();
    expect(data.snapshot().task).toMatchObject({ state: 'ready', retrying: false });
  });

  it('a malformed failure without a problem body is failed, not missing', async () => {
    const d = daemon();
    d.routes['task.get'] = failure;
    const data = start(d);
    await settle();
    data.open('ex/repo#7');
    await settle();
    expect(data.snapshot().task).toMatchObject({ state: 'failed', value: undefined });
  });

  it('never shows a late answer for a previous key under the current key', async () => {
    const d = daemon();
    const first = deferred();
    d.routes['task.get'] = () => first.promise;
    const data = start(d);
    await settle();
    data.open('ex/repo#1');
    await settle();
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet()));
    data.open('ex/repo#7');
    expect(data.snapshot().task).toMatchObject({ key: 'ex/repo#7', state: 'loading' });
    first.resolve(envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#1' } })));
    await settle();
    expect(data.snapshot().task?.key).toBe('ex/repo#7');
    expect(data.snapshot().task?.value?.task.key).toBe('ex/repo#7');
    expect(taskCalls().map(({ task }) => task)).toEqual(['ex/repo#1', 'ex/repo#7']);
  });

  it('stop ends the task read', async () => {
    const d = daemon();
    const held = deferred();
    d.routes['task.get'] = () => held.promise;
    const data = start(d);
    await settle();
    data.open('ex/repo#7');
    data.stop();
    held.resolve(envelope(taskGet()));
    await settle();
    expect(data.snapshot().task).toMatchObject({ state: 'loading', value: undefined });
  });
});

describe('task history read', () => {
  it('re-reads history while shown: invalidate, reset and Retry now; not while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    const data = start(d);
    await settle();
    d.send(hello);
    await settle();
    data.open('repo#7');
    await settle();
    expect(historyCalls()).toHaveLength(0);
    data.showHistory(true);
    expect(data.snapshot().history).toMatchObject({ key: 'repo#7', state: 'loading' });
    await settle();
    expect(historyCalls()).toEqual([{ task: 'repo#7' }]);
    expect(data.snapshot().history).toMatchObject({ key: 'repo#7', state: 'ready' });
    const invalidate = async (tasks: string[]) => {
      d.send(`event: invalidate\ndata: ${JSON.stringify({ projects: [], tasks })}\n\n`);
      await settle();
      await vi.advanceTimersByTimeAsync(400);
      await settle();
    };
    await invalidate(['ex/repo#7']);
    expect(historyCalls()).toHaveLength(2);
    await invalidate(['repo#7']);
    expect(historyCalls()).toHaveLength(3);
    await invalidate(['ex/repo#8']);
    expect(historyCalls()).toHaveLength(3);
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(historyCalls()).toHaveLength(4);
    data.retry();
    await settle();
    expect(historyCalls()).toHaveLength(5);
    data.showHistory(false);
    const tasks = taskCalls().length;
    await invalidate(['ex/repo#7']);
    expect(taskCalls()).toHaveLength(tasks + 1);
    expect(historyCalls()).toHaveLength(5);
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    data.showHistory(true);
    // Shown again: the kept rows stay while the re-read runs.
    expect(data.snapshot().history).toMatchObject({ state: 'ready' });
    expect(historyCalls()).toHaveLength(6);
    data.showHistory(true);
    expect(historyCalls()).toHaveLength(6);
    held.resolve(envelope(taskHistory()));
    await settle();
    data.open(null);
    expect(data.snapshot().history).toBeUndefined();
    await invalidate(['ex/repo#7']);
    expect(historyCalls()).toHaveLength(6);
  });

  it.each([
    [
      'History hides',
      (data: BoardData) => {
        data.showHistory(false);
      },
    ],
    [
      'another task opens',
      (data: BoardData) => {
        data.open('ex/repo#8');
      },
    ],
    [
      'the task closes',
      (data: BoardData) => {
        data.open(null);
      },
    ],
  ])('drops the queued history re-read when %s during a pending read', async (_, leave) => {
    const d = daemon();
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    const data = start(d);
    await settle();
    data.open('ex/repo#7');
    data.showHistory(true);
    await settle();
    expect(historyCalls()).toHaveLength(1);
    // An invalidate during the pending read queues one trailing re-read.
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    leave(data);
    held.resolve(envelope(taskHistory()));
    await settle();
    expect(historyCalls()).toHaveLength(1);
  });

  it('never reads history for a key that is not a task key', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    data.open('509');
    data.showHistory(true);
    data.retryHistory();
    await settle();
    expect(historyCalls()).toHaveLength(0);
    expect(data.snapshot().history).toBeUndefined();
    expect(data.snapshot().task).toMatchObject({ state: 'missing' });
  });

  it('history state: a held re-read stays ready, missing after ready, a failure keeps rows', async () => {
    const d = daemon();
    const data = start(d);
    await settle();
    data.open('ex/repo#7');
    data.showHistory(true);
    await settle();
    const good = data.snapshot().history?.value;
    expect(good?.events).toHaveLength(8);
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().history).toMatchObject({ state: 'ready', value: good });
    held.resolve(envelope(taskHistory([])));
    await settle();
    expect(data.snapshot().history?.value?.events).toEqual([]);
    d.routes['task.history'] = () => problem('unexpected', 500);
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().history).toMatchObject({ state: 'failed', retrying: false });
    expect(data.snapshot().history?.value?.events).toEqual([]);
    const retried = deferred();
    d.routes['task.history'] = () => retried.promise;
    data.retryHistory();
    data.retryHistory();
    expect(data.snapshot().history).toMatchObject({ state: 'loading', retrying: true });
    expect(historyCalls()).toHaveLength(4);
    retried.resolve(envelope(taskHistory()));
    await settle();
    expect(data.snapshot().history).toMatchObject({ state: 'ready', retrying: false });
    d.routes['task.history'] = () => problem('not_found');
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(data.snapshot().history).toEqual({
      key: 'ex/repo#7',
      state: 'missing',
      value: undefined,
      retrying: false,
    });
  });

  it('drops a late history answer for a previous key; stop publishes nothing', async () => {
    const d = daemon();
    const first = deferred();
    d.routes['task.history'] = () => first.promise;
    const data = start(d);
    await settle();
    data.open('ex/repo#1');
    data.showHistory(true);
    await settle();
    d.routes['task.history'] = () => Promise.resolve(envelope(taskHistory([])));
    data.open('ex/repo#7');
    data.showHistory(true);
    first.resolve(envelope(taskHistory()));
    await settle();
    expect(data.snapshot().history).toMatchObject({ key: 'ex/repo#7', state: 'ready' });
    expect(data.snapshot().history?.value?.events).toEqual([]);
    const held = deferred();
    d.routes['task.history'] = () => held.promise;
    data.open('ex/repo#8');
    data.showHistory(true);
    data.stop();
    held.resolve(envelope(taskHistory()));
    await settle();
    expect(data.snapshot().history).toMatchObject({ key: 'ex/repo#8', state: 'loading' });
  });
});
