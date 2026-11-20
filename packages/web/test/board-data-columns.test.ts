import { afterEach, describe, expect, it } from 'vitest';
import { createBoardData, type BoardData } from '../src/board/data.ts';
import {
  daemon,
  deferred,
  envelope,
  failure,
  policy,
  policyColumn,
  type Daemon,
} from './board-fixtures.ts';

/** Body reads and parsing cross a few macrotasks. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
const reset = 'event: reset\ndata: {}\n\n';
const started: BoardData[] = [];
afterEach(() => {
  for (const data of started.splice(0)) data.stop();
});

/** A board on the fixture daemon whose `columns.describe` answers through `route`; reads in order. */
function start(route: Daemon['routes']['columns.describe']) {
  const reads: string[] = [];
  const describes: Record<string, unknown>[] = [];
  const d = daemon();
  d.routes['columns.describe'] = (input) => {
    describes.push(input);
    return route(input);
  };
  const data = createBoardData({
    fetch: (url, init) => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path !== '/v1/events') reads.push(path.replace('/v1/ops/', ''));
      return d.fetcher(url, init);
    },
    storage: () => ({ getItem: () => null, setItem: () => undefined }),
    now: () => 0,
  });
  started.push(data);
  data.start();
  return { d, data, reads, describes };
}

describe('board data columns.describe', () => {
  it('reads columns.describe for the chosen project after config and again for a chosen one', async () => {
    const { data, reads, describes } = start(() => Promise.resolve(envelope({ projects: [] })));
    await settle();
    expect(describes).toEqual([{ project: 'a' }]);
    expect(reads.indexOf('columns.describe')).toBeGreaterThan(reads.indexOf('config.get'));
    expect(data.snapshot().columns).toEqual({
      project: 'a',
      value: { projects: [] },
      help: undefined,
    });
    data.choose('b');
    expect(data.snapshot().columns).toBeUndefined();
    await settle();
    expect(describes).toEqual([{ project: 'a' }, { project: 'b' }]);
    expect(data.snapshot().columns?.project).toBe('b');
  });

  it('keeps the last columns answer and no read failure when columns.describe fails', async () => {
    const answer = policy('a', [policyColumn('todo')]);
    let route: Daemon['routes']['columns.describe'] = () => Promise.resolve(envelope(answer));
    const { d, data, describes } = start((input) => route(input));
    await settle();
    expect(data.snapshot().columns?.value).toEqual(answer);
    route = failure;
    d.send(reset);
    await settle();
    expect(describes).toHaveLength(2);
    expect(data.snapshot()).toMatchObject({
      columns: { project: 'a', value: answer, help: undefined },
      readFailed: false,
      unreadable: false,
      retrying: false,
    });
  });

  it('readColumns is loading until a read issued after it settles, and later reads leave help alone', async () => {
    let route: Daemon['routes']['columns.describe'] = () =>
      Promise.resolve(envelope({ projects: [] }));
    const { d, data, describes } = start((input) => route(input));
    await settle();
    const first = policy('a', [policyColumn('todo')]);
    const second = policy('a', [policyColumn('todo'), policyColumn('done')]);
    const held = [deferred(), deferred()];
    route = () => held[describes.length - 2]?.promise ?? failure();
    // A background read, held in flight.
    d.send(reset);
    await settle();
    expect(describes).toHaveLength(2);
    data.readColumns();
    expect(data.snapshot().columns).toEqual({
      project: 'a',
      value: { projects: [] },
      help: 'loading',
    });
    expect(describes).toHaveLength(2);
    held[0]?.resolve(envelope(first));
    await settle();
    // The held read was issued before the open: help still waits, the value is fresh.
    expect(describes).toHaveLength(3);
    expect(data.snapshot().columns).toEqual({ project: 'a', value: first, help: 'loading' });
    held[1]?.resolve(envelope(second));
    await settle();
    expect(data.snapshot().columns).toEqual({ project: 'a', value: second, help: 'ready' });

    route = failure;
    d.send(reset);
    await settle();
    expect(describes).toHaveLength(4);
    expect(data.snapshot().columns).toEqual({ project: 'a', value: second, help: 'ready' });

    const background = deferred();
    route = () => background.promise;
    d.send(reset);
    await settle();
    route = failure;
    data.readColumns();
    background.resolve(envelope(first));
    await settle();
    expect(describes).toHaveLength(6);
    expect(data.snapshot()).toMatchObject({
      columns: { project: 'a', value: first, help: 'failed' },
      readFailed: false,
    });
  });
});
