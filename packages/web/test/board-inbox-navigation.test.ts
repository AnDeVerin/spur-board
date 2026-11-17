// @vitest-environment happy-dom
import { act } from 'react';
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
