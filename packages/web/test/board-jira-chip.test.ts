// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { config, daemon, envelope, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, one, press, settle } from './board-harness.ts';

mountEachTest();

it.each([true, false])('Jira ticket chip with project browse base %s', async (linked) => {
  const links = [
    { kind: 'ticket', ref: 'ABC-3', role: null },
    { kind: 'pr', ref: 'ex/repo#7', role: null, state: 'open' },
  ];
  const [first, ...rest] = config.projects;
  if (first === undefined) throw new Error('no project');
  const d = daemon();
  if (linked)
    d.routes['config.get'] = () =>
      Promise.resolve(
        envelope({
          ...config,
          projects: [{ ...first, ticketBrowseBase: 'https://j.test/browse/' }, ...rest],
        }),
      );
  const task = { ...taskGet().task, key: 'ABC-1' };
  d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ task, links })));
  mount(d);
  await settle();
  press(one('main a[title="ex/repo#7"]'), 'click');
  await settle();
  const dialog = document.querySelector('[role="dialog"]');
  if (linked) {
    const ticket = dialog?.querySelector(
      'a[aria-label="ticket ABC-3, Jira"][rel="noopener noreferrer"][target="_blank"]',
    );
    if (!ticket) throw new Error('no Jira ticket link');
    expect(ticket.textContent).toBe('ticket ABC-3');
    expect(ticket.getAttribute('href')).toBe('https://j.test/browse/ABC-3');
  } else {
    expect(dialog?.querySelector('a[aria-label^="ticket"]')).toBeNull();
    const chip = [...(dialog?.querySelectorAll('span') ?? [])].find(
      (span) => span.textContent === 'ticket ABC-3',
    );
    expect(chip?.closest('a')).toBeNull();
  }
});
