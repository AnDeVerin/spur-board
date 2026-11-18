// Shared by the version check tests: board-update.test.ts and board-update-leave.test.ts.
import { act } from 'react';
import { vi } from 'vitest';

/**
 * Re-wraps every answer of `fetcher`, the event stream's included, with the `x-board-version`
 * that `version` returns at call time; undefined sends none. `keys` logs each write's key.
 */
export function versioned(fetcher: typeof fetch, version: () => string | undefined) {
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

/**
 * A session storage `Map` that counts its calls. `throws` makes every call throw; `setKey` makes
 * `setItem` of that key throw a quota error. Setting `fails.getter` makes the session getter throw
 * from then on.
 */
export function memorySession(
  options: { throws?: boolean; values?: Record<string, string>; setKey?: string } = {},
) {
  const values = new Map(Object.entries(options.values ?? {}));
  const calls = { getItem: [] as string[], setItem: 0, removeItem: 0 };
  const fails = { getter: false, setKey: options.setKey };
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
      if (key === fails.setKey) throw new DOMException('Quota is full', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => {
      calls.removeItem++;
      fail();
      values.delete(key);
    },
  };
  const session = vi.fn(() => {
    if (fails.getter) throw new DOMException('Storage is off', 'SecurityError');
    return storage;
  });
  return { values, calls, fails, session };
}

export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** The answer field of block B12, then the comment field. */
export const fields = () => [...(dialog()?.querySelectorAll('textarea') ?? [])];
export const field = (index: 0 | 1) => {
  const found = fields()[index];
  if (!found) throw new Error(`no field ${String(index)}`);
  return found;
};
export const typeText = (input: HTMLTextAreaElement, text: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
export const submit = (input: HTMLTextAreaElement) => {
  act(() => {
    input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
export const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
};
export const updateAlert = () =>
  [...document.querySelectorAll('[role="alert"]')].find((alert) =>
    alert.textContent.includes('was updated'),
  );
