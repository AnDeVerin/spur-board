// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { boardColumns } from '../src/board/model.ts';
import { parsed } from './board-fixtures.ts';
import { config, daemon, envelope, failure, row, ROWS, status, taskGet } from './board-fixtures.ts';
import { all, goOffline, mount, mountEachTest, one, press, settle } from './board-harness.ts';

mountEachTest();

const button = (text: string) => {
  const found = all('button').find((item) => item.textContent.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${text}`);
  return found;
};
const trigger = () => one('button[aria-controls]');
const type = (value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      one('input'),
      value,
    );
    one('input').dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('unknown board columns', () => {
  it('boardColumns retains only configured groups in config order', () => {
    const columns = boardColumns(parsed().columns, parsed().rows);
    expect(columns.map(({ id, rows }) => [id, rows.length])).toEqual([
      ['todo', 0],
      ['dev', 2],
      ['review', 0],
      ['done', 7],
    ]);
  });
  it('counts unmatched rows once and discloses their keys, titles and original columns', async () => {
    const d = daemon();
    d.routes['status.get'] = () =>
      Promise.resolve(
        envelope(status([...ROWS, row('UNKNOWN-2', 'product-review', { ticket: null })])),
      );
    mount(d);
    await settle();
    const marker = button('2 tasks in unknown columns');
    expect(all('main button')).toEqual([marker]);
    expect(marker.getAttribute('aria-expanded')).toBe('false');
    const list = one(`ul[id="${marker.getAttribute('aria-controls') ?? ''}"]`);
    expect(list.hidden).toBe(true);
    expect([...list.querySelectorAll('a')].every((link) => link.closest('[hidden]') !== null)).toBe(
      true,
    );
    press(marker.firstElementChild ?? marker, 'click');
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('a')].map((link) => [link.title, link.textContent])).toEqual([
      ['ex/repo#99', '#99Title ex/repo#99qa'],
      ['UNKNOWN-2', 'UNKNOWN-2product-review'],
    ]);
    type('UNKNOWN-2');
    expect(marker.textContent).toBe('2 tasks in unknown columns');
    expect(list.querySelector('[title="ex/repo#99"]')?.hasAttribute('data-dimmed')).toBe(true);
    expect(list.querySelector('[title="UNKNOWN-2"]')?.hasAttribute('data-dimmed')).toBe(false);
    press(marker, 'click');
    expect(list.hidden).toBe(true);
  });

  it.each([{ rows: [] }, { rows: ROWS.filter((task) => task.column !== 'qa') }])(
    'omits the unknown surface at zero: $rows.length rows',
    async ({ rows }) => {
      const d = daemon();
      d.routes['status.get'] = () => Promise.resolve(envelope(status(rows)));
      mount(d);
      await settle();
      expect(all('main button')).toHaveLength(0);
      expect(one('main').textContent).not.toContain('unknown columns');
    },
  );

  it('keeps an all-unmatched task discoverable through the existing task view', async () => {
    const d = daemon();
    const reads: Record<string, unknown>[] = [];
    d.routes['task.get'] = (input) => {
      reads.push(input);
      return Promise.resolve(
        envelope(taskGet({ task: { ...taskGet().task, key: 'ex/repo#99', column: 'qa' } })),
      );
    };
    d.routes['status.get'] = () => Promise.resolve(envelope(status([row('ex/repo#99', 'qa')])));
    mount(d);
    await settle();
    const marker = button('1 task in unknown columns');
    press(marker, 'click');
    const link = one('main a[title="ex/repo#99"]');
    act(() => {
      link.focus();
    });
    press(link, 'click');
    await settle();
    expect(location.search).toBe('?open=ex%2Frepo%2399');
    expect(reads).toContainEqual({ task: 'ex/repo#99', why: true });
    const close = document.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (close === null) throw new Error('no task close button');
    press(close, 'click');
    await settle();
    expect(marker.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(link);
  });

  it('recomputes unknown rows on status/config refresh and resets disclosure on project change', async () => {
    const d = daemon();
    mount(d);
    await settle();
    press(button('1 task in unknown columns'), 'click');
    d.routes['status.get'] = () => Promise.resolve(envelope(status([row('NEW-1', 'qa')])));
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(all('main a').map((link) => link.title)).toEqual(['NEW-1']);
    expect(button('1 task in unknown columns').getAttribute('aria-expanded')).toBe('true');
    press(trigger(), 'click');
    press(button('b · dispatcher'), 'click');
    await settle();
    expect(button('1 task in unknown columns').getAttribute('aria-expanded')).toBe('false');
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({
          ...config,
          projects: config.projects.map((project) => ({
            ...project,
            columns: [...project.columns, { ...project.columns[0], id: 'qa' }],
          })),
        }),
      );
    d.send('event: reset\ndata: {}\n\n');
    await settle();
    expect(all('main button')).toHaveLength(0);
    expect(all('main a').map((link) => link.title)).toEqual(['NEW-1']);
  });

  it.each([false, true])(
    'retains expanded unknown rows through offline/read failure: %s',
    async (readFailed) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const d = daemon();
      mount(d);
      await settle();
      const marker = button('1 task in unknown columns');
      press(marker, 'click');
      const list = one(`ul[id="${marker.getAttribute('aria-controls') ?? ''}"]`);
      const text = list.textContent;
      if (readFailed) d.routes['status.get'] = failure;
      await goOffline(d);
      expect(marker.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      expect(list.textContent).toBe(text);
      expect(marker.textContent).toBe('1 task in unknown columns');
      expect(marker.parentElement?.hasAttribute('data-stale')).toBe(true);
      expect(all('main section').every((section) => section.hasAttribute('data-stale'))).toBe(true);
    },
  );
});
