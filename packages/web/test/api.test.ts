import { describe, expect, it } from 'vitest';
import { createApi, createMutationIntent, coordinateRead, ProblemError } from '../src/lib/api.ts';
import { browserOperations, statusOutputSchema } from '@spur-board/contracts/browser';
import { historyEvent, taskHistory } from './board-fixtures.ts';

const status = statusOutputSchema.parse({
  items: [],
  warmingUp: false,
  spurUnavailable: null,
  hostLoad: null,
  host: null,
  services: [],
  transport: [],
  sources: [],
  tasks: [],
  projectBlocks: [],
  unlinkedPrs: [],
  unlinkedSessions: [],
  hiddenUnlinkedPrs: 0,
  hiddenUnlinkedSessions: 0,
  bindings: { columns: [], operators: [], defaultAddressee: null },
  daemon: { version: '0.4.0', startedAt: '2026-01-05T08:00:00.000Z', lastDispatchAt: null },
});
const envelope = (value: unknown) => Response.json({ ok: true, requestId: 'r1', value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe('browser API', () => {
  it('posts validated input, headers and cancellation to same origin', async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const api = createApi((url, init) => {
      calls.push([url, init]);
      return Promise.resolve(envelope(status));
    });
    const controller = new AbortController();
    expect(await api('status.get', {}, { signal: controller.signal })).toEqual(status);
    expect(calls).toEqual([
      [
        '/v1/ops/status.get',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: '{"input":{}}',
          signal: controller.signal,
        },
      ],
    ]);
    await expect(api('comment.add', { task: 'PROJ-123', text: '' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it.each([{ ok: true, requestId: 'r', value: {} }, { ok: true, value: status }, { ok: false }])(
    'rejects malformed success %j',
    async (body) => {
      await expect(
        createApi(() => Promise.resolve(Response.json(body)))('status.get', {}),
      ).rejects.toThrow();
    },
  );
  it('validates problems and never retries writes automatically', async () => {
    let calls = 0;
    const api = createApi(() => {
      calls++;
      return Promise.resolve(Response.json({ broken: true }, { status: 502 }));
    });
    await expect(api('comment.add', { task: 'PROJ-123', text: 'Hello' })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('surfaces a validated HTTP problem and rejects malformed problem fields', async () => {
    const problem = {
      type: 'https://spur-board.dev/docs/errors.md#forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      requestId: 'r',
      message: 'Access denied',
      hint: 'Check identity',
      docs: 'docs/errors.md#forbidden',
      context: {},
      recovery: {
        action: 'Check identity',
        sideEffects: 'none',
        maxRetries: 0,
        retryTiming: 'After fixing identity',
      },
    };
    await expect(
      createApi(() => Promise.resolve(Response.json(problem, { status: 403 })))('status.get', {}),
    ).rejects.toThrow('Access denied');
    const thrown = await createApi(() => Promise.resolve(Response.json(problem, { status: 403 })))(
      'status.get',
      {},
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ProblemError);
    expect(thrown).toMatchObject({ code: 'forbidden', message: 'Access denied' });
    await expect(
      createApi(() =>
        Promise.resolve(Response.json({ ...problem, code: 'invented' }, { status: 403 })),
      )('status.get', {}),
    ).rejects.toThrow();
  });
  it('coalesces pending intent and keeps its UUID on retry; new intent gets a new UUID', async () => {
    const request = deferred<Response>();
    const keys: string[] = [];
    let uuid = 0;
    const api = createApi((_url, init) => {
      keys.push(
        (JSON.parse(typeof init?.body === 'string' ? init.body : '') as { key: string }).key,
      );
      return request.promise;
    });
    const input = { task: 'PROJ-123', text: 'Hello' };
    const intent = createMutationIntent(api, 'comment.add', input, () => `uuid-${String(++uuid)}`);
    const a = intent.run();
    const b = intent.run();
    expect(a).toBe(b);
    expect(keys).toEqual(['uuid-1']);
    request.reject(new Error('outcome uncertain'));
    await expect(a).rejects.toThrow('outcome uncertain');
    await expect(intent.run()).rejects.toThrow();
    await expect(
      createMutationIntent(api, 'comment.add', input, () => `uuid-${String(++uuid)}`).run(),
    ).rejects.toThrow();
    expect(keys).toEqual(['uuid-1', 'uuid-1', 'uuid-2']);
  });
  it('reads task.history with its read schema: an unknown kind or channel still parses', async () => {
    const at = '2026-11-15T14:40:00.000Z';
    const answer = taskHistory([
      historyEvent(at, 'task_added', 'operator', 'Added to Dev.'),
      historyEvent(at, 'future_kind', 'system', 'Something new.', 'carrier'),
    ]);
    const api = createApi(() => Promise.resolve(envelope(answer)));
    const value = await api('task.history', { task: 'ex/repo#7' });
    expect(value.events.map((event) => event.kind)).toEqual(['task_added', 'future_kind']);
    expect(value.events[1]?.via).toBe('carrier');
    // The catalog's own output stays strict.
    expect(browserOperations['task.history'].output.safeParse(answer).success).toBe(false);
    const noSummary = { at, kind: 'future_kind', actor: 'system' };
    await expect(
      createApi(() => Promise.resolve(envelope(taskHistory([noSummary]))))('task.history', {
        task: 'ex/repo#7',
      }),
    ).rejects.toThrow();
  });
});
describe('status read coordination', () => {
  it.each([false, true])('retains one trailing read after pending failure=%s', async (failure) => {
    const a = deferred<typeof status>();
    const b = deferred<typeof status>();
    let calls = 0;
    const publications: boolean[] = [];
    const coordinator = coordinateRead(
      () => (++calls === 1 ? a.promise : b.promise),
      (_value, error) => publications.push(error),
    );
    coordinator.refresh();
    coordinator.refresh();
    coordinator.refresh();
    expect(calls).toBe(1);
    if (failure) a.reject(new Error('no'));
    else a.resolve(status);
    await flush();
    expect(calls).toBe(2);
    b.resolve(status);
    await flush();
    expect(calls).toBe(2);
    expect(publications).toEqual([failure, false]);
    coordinator.dispose();
  });
  it('aborts and prevents publication or trailing work after disposal', async () => {
    const a = deferred<typeof status>();
    let calls = 0;
    let published = 0;
    let signal: AbortSignal | undefined;
    const coordinator = coordinateRead(
      (value) => {
        signal = value;
        calls++;
        return a.promise;
      },
      () => {
        published++;
      },
    );
    coordinator.refresh();
    coordinator.refresh();
    coordinator.dispose();
    a.resolve(status);
    await flush();
    coordinator.refresh();
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(published).toBe(0);
  });
});
