// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { InboxPanel } from '../src/board/InboxPanel.tsx';
import type { BoardSnapshot } from '../src/board/data.ts';
import { createRoot } from 'react-dom/client';
import { focusRing, quiet } from '../src/ds/index.ts';
import { describe, expect, it, vi } from 'vitest';
import { config, daemon, deferred, envelope, failure, inbox, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, press, settle } from './board-harness.ts';

mountEachTest();
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const find = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
};

describe('inbox task navigation without configuration', () => {
  it.each([undefined, 'javascript:alert(1)', '/relative', 'https://example.test/run'])(
    'inbox native link semantics for URL %s in active and handled rows',
    (url) => {
      const base = {
        id: 'I1',
        project: '_board',
        kind: 'board_observation' as const,
        severity: 'failure' as const,
        text: 'Run failed',
        at: '2026-11-04T08:00:00.000Z',
        task: null,
        ...(url === undefined ? {} : { url }),
      };
      const snapshot: BoardSnapshot = {
        config: undefined,
        project: undefined,
        status: undefined,
        inbox: {
          items: [base, { ...base, id: 'I3', task: 'ex/repo#7' }],
          handled: [{ ...base, id: 'I2', handledAt: base.at }],
        },
        readFailed: false,
        unreadable: false,
        update: undefined,
        stream: 'offline',
        everLive: false,
        lastGoodAt: undefined,
        retrying: false,
        task: undefined,
        history: undefined,
      };
      // Direct renderer fixture deliberately bypasses the API schema to reach URL defense.
      const target = document.createElement('div');
      document.body.append(target);
      const root = createRoot(target);
      act(() => {
        root.render(
          createElement(InboxPanel, {
            snapshot,
            now: 0,
            onClose: () => undefined,
            onOpen: () => undefined,
            onColumnHelp: () => undefined,
            opensTask: () => false,
            closeItem: () => ({ run: () => Promise.resolve() }),
          }),
        );
      });
      try {
        const host = document;
        for (const id of ['I1', 'I2']) {
          const row = host.querySelector(`[data-inbox-id="${id}"]`);
          expect(row?.className).toContain(focusRing);
          expect(row?.className).toContain(quiet);
          if (url === 'https://example.test/run') {
            expect(row?.tagName).toBe('A');
            expect(row?.getAttribute('href')).toBe(url);
            expect(row?.getAttribute('target')).toBe('_blank');
            expect(row?.getAttribute('rel')).toBe('noopener noreferrer');
          } else {
            expect(row?.tagName).toBe('DIV');
            expect(row?.getAttribute('tabindex')).toBe('0');
            expect(row?.hasAttribute('href')).toBe(false);
          }
        }
        const task = host.querySelector('[data-inbox-id="I3"]');
        expect(task?.tagName).toBe('A');
        expect(task?.getAttribute('href')).toBe('?open=ex%2Frepo%237');
        expect(task?.hasAttribute('target')).toBe(false);
      } finally {
        act(() => {
          root.unmount();
        });
        target.remove();
      }
    },
  );
  const cases = ['pending', 'failed'].flatMap((configState) =>
    ['click', 'restored'].flatMap((opener) =>
      ['stay', 'close', 'navigate'].map((next) => ({ configState, opener, next })),
    ),
  );
  it.each(cases)(
    '$configState config / $opener task / $next before config arrives',
    async ({ configState, opener, next }) => {
      history.replaceState(
        opener === 'restored' ? { inbox: true, project: 'b' } : null,
        '',
        opener === 'restored' ? '/?open=ex%2Frepo%237' : '/?open=inbox',
      );
      const d = daemon();
      const held = deferred();
      d.routes['config.get'] = configState === 'pending' ? () => held.promise : failure;
      d.routes['inbox.operator'] = () =>
        Promise.resolve(
          envelope({
            items: [{ ...inbox(1).items[0], project: 'b', task: 'ex/repo#7' }],
            handled: [],
          }),
        );
      const readTask = vi.fn(() =>
        Promise.resolve(envelope(taskGet({ task: { ...taskGet().task, project: 'b' } }))),
      );
      d.routes['task.get'] = readTask;
      const storage = mount(d);
      await settle();
      if (opener === 'click') press(find('[data-inbox-id="B1"]'), 'click');
      await settle();
      expect(readTask).toHaveBeenCalledOnce();
      expect(dialogs()).toHaveLength(2);
      expect(dialogs().at(-1)?.textContent).toContain('#7');
      expect(storage.get('board-project')).toBeUndefined();
      if (next === 'close') {
        const close = dialogs().at(-1)?.querySelector('[aria-label="Close"]');
        if (!close) throw new Error('missing task close');
        press(close, 'click');
      } else if (next === 'navigate') {
        act(() => {
          history.replaceState(null, '', '/?open=services');
          dispatchEvent(new PopStateEvent('popstate'));
        });
      }
      await settle();
      if (configState === 'pending') held.resolve(envelope(config));
      else {
        d.routes['config.get'] = () => Promise.resolve(envelope(config));
        d.send('event: reset\ndata: {}\n\n');
      }
      await settle();
      expect(storage.get('board-project')).toBe(next === 'stay' ? 'b' : undefined);
      expect(find('header button[aria-controls]').textContent).toBe(next === 'stay' ? 'b' : 'a');
      expect(dialogs()).toHaveLength(next === 'stay' ? 2 : next === 'close' ? 1 : 0);
      expect(location.search).toBe(
        next === 'stay'
          ? '?open=ex%2Frepo%237'
          : next === 'close'
            ? '?open=inbox'
            : '?open=services',
      );
    },
  );
});
