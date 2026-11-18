// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createBoardData } from '../src/board/data.ts';
import {
  block,
  daemon,
  deferred,
  envelope,
  failure,
  hello,
  taskGet,
  type Daemon,
} from './board-fixtures.ts';
import { all, mount, mounted, mountEachTest, remount, settle } from './board-harness.ts';

mountEachTest();

const PAGE = '1.0.0';
const NEXT = '2.0.0';
const OPEN = '/?open=ex%2Frepo%237';

/**
 * Re-wraps every answer of `fetcher`, the event stream's included, with the `x-board-version`
 * that `version` returns at call time; undefined sends none. `keys` logs each write's key.
 */
function versioned(fetcher: typeof fetch, version: () => string | undefined) {
  const keys: string[] = [];
  const wrapped: typeof fetch = async (input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { key?: string };
    if (body.key !== undefined) keys.push(body.key);
    const response = await fetcher(input, init);
    const current = version();
    if (current === undefined) return response;
    const headers = new Headers(response.headers);
    headers.set('x-board-version', current);
    return new Response(response.body, { status: response.status, headers });
  };
  return { fetch: wrapped, keys };
}

/** A session storage `Map` that counts its calls; `throws` makes every call throw. */
function memorySession(options: { throws?: boolean; values?: Record<string, string> } = {}) {
  const values = new Map(Object.entries(options.values ?? {}));
  const calls = { getItem: [] as string[], setItem: 0, removeItem: 0 };
  const fail = () => {
    if (options.throws === true) throw new DOMException('Storage is off', 'SecurityError');
  };
  const storage = {
    getItem: (key: string) => {
      calls.getItem.push(key);
      fail();
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      calls.setItem++;
      fail();
      values.set(key, value);
    },
    removeItem: (key: string) => {
      calls.removeItem++;
      fail();
      values.delete(key);
    },
  };
  return { values, calls, session: vi.fn(() => storage) };
}

const noStorage = () => ({ getItem: () => null, setItem: () => undefined });

describe('version check', () => {
  function board(version: () => string | undefined, session = memorySession(), page = PAGE) {
    const d = daemon();
    const reload = vi.fn();
    const data = createBoardData({
      fetch: versioned(d.fetcher, version).fetch,
      storage: noStorage,
      now: () => 0,
      update: { version: page, session: session.session, reload },
    });
    data.start();
    return { d, data, reload, session };
  }

  it('reloads once when the daemon reports another version', async () => {
    const { d, data, reload, session } = board(() => NEXT);
    await settle();
    d.send(hello);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.values.get('board-reload-target')).toBe(NEXT);
    expect(data.snapshot().update).toEqual({ version: NEXT, mode: 'reloading', keepsDrafts: true });
    data.stop();
  });

  it('shows the update instead of reloading again for the same target', async () => {
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    const { d, data, reload } = board(() => NEXT, session);
    await settle();
    const update = data.snapshot().update;
    expect(update).toEqual({ version: NEXT, mode: 'blocked', keepsDrafts: true });
    const calls = structuredClone(session.calls);
    d.send(hello);
    await settle();
    expect(data.snapshot().update).toBe(update);
    expect(session.calls).toEqual(calls);
    expect(reload).not.toHaveBeenCalled();
    data.stop();
  });

  it('a matching version removes the marker and changes nothing', async () => {
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    const { d, data, reload } = board(() => PAGE, session);
    await settle();
    d.send(hello);
    await settle();
    expect(session.values.has('board-reload-target')).toBe(false);
    expect(session.calls).toEqual({
      getItem: ['board-drafts', 'board-reload-target'],
      setItem: 0,
      removeItem: 1,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(data.snapshot().update).toBeUndefined();
    data.stop();
  });

  it('no page version: the session is never touched', async () => {
    const d = daemon();
    const session = memorySession();
    const data = createBoardData({
      fetch: versioned(d.fetcher, () => NEXT).fetch,
      storage: noStorage,
      now: () => 0,
    });
    data.start();
    await settle();
    data.retry();
    await settle();
    expect(session.session).not.toHaveBeenCalled();
    expect(data.snapshot().update).toBeUndefined();
    data.stop();
  });

  it('page version without a header: one read at construction', async () => {
    const { d, data, reload, session } = board(() => undefined);
    await settle();
    d.send(hello);
    await settle();
    expect(session.calls).toEqual({ getItem: ['board-drafts'], setItem: 0, removeItem: 0 });
    expect(reload).not.toHaveBeenCalled();
    expect(data.snapshot().update).toBeUndefined();
    data.stop();
  });

  it('retry reloads while an update is pending', async () => {
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    const { data, reload } = board(() => NEXT, session);
    await settle();
    expect(data.snapshot().update?.mode).toBe('blocked');
    data.retry();
    data.retry();
    expect(reload).toHaveBeenCalledTimes(1);
    data.stop();
  });

  it('session storage that throws never reloads', async () => {
    const { data, reload, session } = board(() => NEXT, memorySession({ throws: true }));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(data.snapshot().update).toEqual({ version: NEXT, mode: 'blocked', keepsDrafts: false });
    expect(session.calls).toEqual({ getItem: ['board-drafts'], setItem: 0, removeItem: 0 });
    data.stop();
  });
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** The answer field of block B12, then the comment field. */
const fields = () => [...(dialog()?.querySelectorAll('textarea') ?? [])];
const field = (index: 0 | 1) => {
  const found = fields()[index];
  if (!found) throw new Error(`no field ${String(index)}`);
  return found;
};
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
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
};
const updateAlert = () =>
  [...document.querySelectorAll('[role="alert"]')].find((alert) =>
    alert.textContent.includes('was updated'),
  );

describe('drafts across a board update', () => {
  let version = PAGE;
  /** Opens task ex/repo#7 with question B12 on a versioned daemon and the given session. */
  async function open(session: ReturnType<typeof memorySession>, page = PAGE) {
    history.replaceState(null, '', OPEN);
    const d = daemon();
    d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ blocks: [block()] })));
    const wrapped = versioned(d.fetcher, () => version);
    const reload = vi.fn();
    mount({ ...d, fetcher: wrapped.fetch }, {}, () => 0, {
      version: page,
      session: session.session,
      reload,
    });
    await settle();
    return { d, reload, keys: wrapped.keys };
  }
  /** The daemon restarts on the next version: the stream drops and reconnects after 0.5 s. */
  async function update(d: Daemon) {
    version = NEXT;
    d.endStream();
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(500));
    await settle();
  }
  function start() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    version = PAGE;
  }

  it('keeps unsent answer and comment text across the reload', async () => {
    start();
    const session = memorySession();
    const { d, reload } = await open(session);
    typeText(field(0), 'an answer');
    typeText(field(1), 'a comment');
    await update(d);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(session.values.get('board-drafts') ?? '{}')).toEqual({
      [JSON.stringify(['answer', 'ex/repo#7', 'B12'])]: 'an answer',
      [JSON.stringify(['comment', 'ex/repo#7', null])]: 'a comment',
    });

    remount();
    await open(session, NEXT);
    expect(location.search).toBe('?open=ex%2Frepo%237');
    expect(fields().map((input) => input.value)).toEqual(['an answer', 'a comment']);
    expect(button('Send answer').disabled).toBe(false);
    expect(button('Add comment').disabled).toBe(false);
    expect(dialog()?.textContent).not.toContain('Unsent answer draft');
    expect(session.values.has('board-drafts')).toBe(false);
  });

  it('defers the reload until a send settles', async () => {
    start();
    const { d, reload } = await open(memorySession());
    const accepted = d.routes['block.answer'];
    const sent = deferred();
    d.routes['block.answer'] = () => sent.promise;
    typeText(field(0), 'an answer');
    submit(field(0));
    await settle();
    await update(d);
    expect(mounted().snapshot().update?.mode).toBe('deferred');
    expect(updateAlert()).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    sent.resolve(await accepted({}));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a failed send does not hold the reload', async () => {
    start();
    const session = memorySession();
    const { d, reload, keys } = await open(session);
    let fail!: (reason: Error) => void;
    d.routes['block.answer'] = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      });
    typeText(field(0), 'an answer');
    submit(field(0));
    await settle();
    await update(d);
    expect(reload).not.toHaveBeenCalled();
    fail(new TypeError('Failed to fetch'));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.values.get('board-drafts')).toContain('an answer');
    expect(keys).toHaveLength(1);

    remount();
    const after = await open(session, NEXT);
    expect(field(0).value).toBe('an answer');
    submit(field(0));
    await settle();
    expect(after.keys).toHaveLength(1);
    expect(after.keys[0]).not.toBe(keys[0]);
  });

  it('storage failure shows the banner and Reload reloads', async () => {
    start();
    const session = memorySession({ throws: true });
    const { d, reload } = await open(session);
    typeText(field(0), 'an answer');
    d.routes['status.get'] = failure;
    await update(d);
    // The new daemon's first hello rereads everything.
    d.send('event: hello\ndata: {"head":2,"instance":"two"}\n\n');
    await settle();
    expect(reload).not.toHaveBeenCalled();
    const alert = updateAlert()?.textContent;
    expect(alert).toContain(`The board was updated to ${NEXT}. Reload to continue.`);
    expect(alert).toContain(
      'Unsent text cannot be kept: copy it before reloading. ' +
        'The board shows data from 00:00 01/01/70. Answers and comments cannot be sent.',
    );
    expect(alert).not.toContain('does not answer');
    expect(all('main section').every((section) => section.hasAttribute('data-stale'))).toBe(true);
    expect(dialog()?.textContent).toContain(
      `The board was updated to ${NEXT}. Answers and comments cannot be sent.`,
    );
    act(() => {
      button('Reload').click();
    });
    expect(button('Reloading').getAttribute('aria-busy')).toBe('true');
    expect(reload).toHaveBeenCalledTimes(1);
    typeText(field(0), 'an answer and more');
    d.send(hello);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.calls.setItem).toBeLessThanOrEqual(1);
  });

  it('writer reports never republish', async () => {
    start();
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    version = NEXT;
    await open(session);
    expect(mounted().snapshot().update?.mode).toBe('blocked');
    const errors = vi.spyOn(console, 'error');
    let notified = 0;
    const unsubscribe = mounted().subscribe(() => {
      notified++;
    });
    for (let i = 1; i <= 20; i++) {
      typeText(field(0), 'a'.repeat(i));
      typeText(field(1), 'b'.repeat(i));
    }
    unsubscribe();
    expect(notified).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('Reload inside the open task view keeps its text', async () => {
    start();
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    version = NEXT;
    const { reload } = await open(session);
    expect(mounted().snapshot().update?.mode).toBe('blocked');
    expect(mounted().snapshot().readFailed).toBe(false);
    const view = dialog();
    expect(view?.textContent).toContain(`The board was updated to ${NEXT}. Reload to continue.`);
    typeText(field(0), 'an answer');
    const inside = [...(view?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent === 'Reload',
    );
    act(() => {
      inside?.click();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(session.values.get('board-drafts') ?? '{}')).toEqual({
      [JSON.stringify(['answer', 'ex/repo#7', 'B12'])]: 'an answer',
    });
    expect(view?.querySelector('[aria-busy="true"]')?.textContent).toBe('Reloading');
  });

  it('the open inbox repeats the update banner', async () => {
    const session = memorySession({ values: { 'board-reload-target': NEXT } });
    version = NEXT;
    const d = daemon();
    history.replaceState(null, '', '/?open=inbox');
    mount({ ...d, fetcher: versioned(d.fetcher, () => version).fetch }, {}, () => 0, {
      version: PAGE,
      session: session.session,
      reload: vi.fn(),
    });
    await settle();
    const panel = dialog();
    expect(panel?.textContent).toContain('wait for you');
    expect(panel?.textContent).toContain(`The board was updated to ${NEXT}. Reload to continue.`);
    expect(
      [...(panel?.querySelectorAll('button') ?? [])].some(
        (candidate) => candidate.textContent === 'Reload',
      ),
    ).toBe(true);
  });

  it('a closed task view releases its writers', async () => {
    start();
    const { d, reload } = await open(memorySession());
    d.routes['block.answer'] = () => new Promise<Response>(() => undefined);
    typeText(field(0), 'an answer');
    submit(field(0));
    await settle();
    await update(d);
    expect(mounted().snapshot().update?.mode).toBe('deferred');
    act(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stop ends the version check', async () => {
    start();
    const session = memorySession();
    const { d, reload } = await open(session);
    const accepted = d.routes['block.answer'];
    const sent = deferred();
    d.routes['block.answer'] = () => sent.promise;
    typeText(field(0), 'an answer');
    submit(field(0));
    await settle();
    await update(d);
    expect(mounted().snapshot().update?.mode).toBe('deferred');
    const data = mounted();
    let notified = 0;
    data.subscribe(() => {
      notified++;
    });
    const writes = session.calls.setItem;
    data.stop();
    remount();
    sent.resolve(await accepted({}));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(session.calls.setItem).toBe(writes);
    expect(notified).toBe(0);
  });
});
