// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { StatusDot } from '../src/ds/index.ts';
import {
  daemon,
  envelope,
  HEALTHY,
  polled,
  PR,
  service,
  SLACK_UP,
  status,
  type Daemon,
} from './board-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

function mount(d: Daemon, path = '/') {
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', d.fetcher);
  act(() => {
    root.render(createElement(App));
  });
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}
const barButton = (name: string) => {
  const found = [
    ...(container.querySelector('footer')?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((candidate) => candidate.getAttribute('aria-label')?.split(':')[0] === name);
  if (!found) throw new Error(`no bar button ${name}`);
  return found;
};
const panel = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no panel');
  return found;
};
const box = (id: string) => {
  const found = panel().querySelector<HTMLElement>(`[data-box="${id}"]`);
  if (!found) throw new Error(`no box ${id}`);
  return found;
};
const headings = () => [...panel().querySelectorAll('h2')].map((item) => item.textContent);
const press = (target: HTMLElement) => {
  act(() => {
    target.focus();
    target.click();
  });
};
const answer = (sources: unknown[]) =>
  Promise.resolve(
    envelope(
      status(undefined, sources, {
        services: [...HEALTHY, service('jira', 'failing')],
        transport: [SLACK_UP],
      }),
    ),
  );

describe('status bar across projects', () => {
  it("shows every project's services with another project chosen", async () => {
    localStorage.setItem('board-project', 'b');
    const d = daemon();
    const inputs: unknown[] = [];
    d.routes['status.get'] = (input) => {
      inputs.push(input);
      return answer([
        polled('spur'),
        polled('jira:a', { blindReason: 'auth' }),
        polled(PR),
        polled('github:b:ex/other'),
      ]);
    };
    mount(d, '/?open=services');
    await settle();
    expect(barButton('jira').getAttribute('aria-label')).toBe('jira: blind: auth');
    expect(barButton('jira').innerHTML).toContain(
      renderToStaticMarkup(createElement(StatusDot, { tone: 'error', hollow: false })),
    );
    expect(box('jira:a').closest('section[aria-label="a"]')).not.toBeNull();
    expect(headings()).toEqual(['a', 'b']);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input).toEqual({ project: 'b', detail: true });
  });

  it('a red service button scrolls to its failing box', async () => {
    const d = daemon();
    d.routes['status.get'] = () =>
      answer([polled('spur'), polled('jira:a'), polled('jira:b', { blindReason: 'auth' })]);
    mount(d);
    await settle();
    press(barButton('services'));
    const scrolled = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    press(barButton('jira'));
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(box('jira:b'));
    // The group the box sits in is headed by its own project.
    expect(box('jira:b').closest('section[aria-label]')?.querySelector('h2')?.textContent).toBe(
      'b',
    );
  });
});
