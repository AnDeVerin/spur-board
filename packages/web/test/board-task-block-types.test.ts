// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { block, daemon, envelope, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, settle } from './board-harness.ts';

mountEachTest();

const TYPES = ['needs_input', 'code', 'dependency', 'external'] as const;
const CHANNELS = [null, 'slack', 'web'] as const;
const variants = [
  ...TYPES.flatMap((type) =>
    ['operator', 'worker'].map((addressee) => ({
      type,
      state: 'open',
      addressee,
      outcome: null,
      answeredVia: null,
      status: 'open',
      form: type === 'needs_input' && addressee === 'operator',
      reference: null,
    })),
  ),
  ...TYPES.flatMap((type) =>
    CHANNELS.map((answeredVia) => ({
      type,
      state: 'unblocked',
      addressee: 'operator',
      outcome: 'done',
      answeredVia,
      status:
        type === 'needs_input'
          ? `answered${answeredVia ? ` via ${answeredVia === 'slack' ? 'Slack' : 'web'}` : ''}`
          : 'done',
      form: false,
      reference: type === 'needs_input' ? null : 'commit abc1234 / PR #42',
    })),
  ),
  {
    type: 'needs_input',
    state: 'open',
    addressee: 'curator',
    outcome: null,
    answeredVia: null,
    status: 'open',
    form: false,
    reference: null,
  },
  {
    type: 'needs_input',
    state: 'unblocked',
    addressee: 'operator',
    outcome: 'withdrawn',
    answeredVia: 'slack',
    status: 'withdrawn',
    form: false,
    reference: 'Question withdrawn',
  },
  {
    type: 'code',
    state: 'unblocked',
    addressee: 'operator',
    outcome: 'reason',
    answeredVia: null,
    status: 'reason',
    form: false,
    reference: 'Fixed elsewhere',
  },
  {
    type: 'dependency',
    state: 'unblocked',
    addressee: 'worker',
    outcome: 'reason',
    answeredVia: null,
    status: 'reason',
    form: false,
    reference: 'Dependency is ready',
  },
  {
    type: 'external',
    state: 'unblocked',
    addressee: 'operator',
    outcome: 'terminal',
    answeredVia: 'web',
    status: 'terminal',
    form: false,
    reference: 'External work ended',
  },
  {
    type: 'needs_input',
    state: 'unblocked',
    addressee: 'operator',
    outcome: 'archived',
    answeredVia: null,
    status: 'archived',
    form: false,
    reference: 'Task archived',
  },
];

describe('block type presentation and answer eligibility', () => {
  it.each(variants)(
    '$type $state/$outcome via $answeredVia addressed to $addressee shows $status, form=$form',
    async ({ type, state, addressee, outcome, answeredVia, status, form, reference }) => {
      const d = daemon();
      d.routes['task.get'] = () =>
        Promise.resolve(
          envelope(
            taskGet({
              blocks: [
                block({ type, state, addressee, outcome, answeredVia, outcomeReason: reference }),
              ],
            }),
          ),
        );
      history.replaceState(null, '', '/?open=ex%2Frepo%237');
      mount(d);
      await settle();
      const item = document.querySelector('[role="dialog"] article');
      if (!item) throw new Error('no block in task dialog');
      expect(item.textContent).toContain(status);
      expect(item.querySelector('textarea') !== null).toBe(form);
      expect(item.querySelector('[aria-label^="Retained draft:"]')).toBeNull();
      if (form) {
        expect(item.querySelector('label')?.textContent).toBe('Answer B12');
        expect(item.querySelector('button[type="submit"]')?.textContent).toBe('Send answer');
      }
      if (!status.startsWith('answered')) expect(item.textContent).not.toContain('answered');
      if (reference !== null) expect(item.textContent).toContain(reference);
      if (addressee === 'curator') expect(item.textContent).toContain('→ curator');
    },
  );
});
