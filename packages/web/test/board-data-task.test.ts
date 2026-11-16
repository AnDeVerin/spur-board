import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import {
  daemon,
  deferred,
  envelope,
  failure,
  hello,
  problem,
  taskGet,
  type Daemon,
} from './board-fixtures.ts';

/** Body reads and parsing cross a few macrotasks; fake timers leave setImmediate real. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const started: BoardData[] = [];
let inputs: Record<string, unknown>[] = [];
/** The inputs of every `task.get` the board sent, in order. */
const taskCalls = () => inputs;
function start(d: Daemon) {
  const data = createBoardData({
    fetch: (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()) === '/v1/ops/task.get') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          input: Record<string, unknown>;
        };
        inputs.push(body.input);
      }
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
  vi.useRealTimers();
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
