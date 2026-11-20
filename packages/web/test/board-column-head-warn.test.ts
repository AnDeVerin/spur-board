// @vitest-environment happy-dom
// A long executor name clips before the no-live-session warning, never over it. happy-dom lays
// nothing out, so the test reads the structure: the warning is a sibling of the clipped text.
import { describe, expect, it } from 'vitest';
import styles from '../src/board/Columns.module.css';
import { config, daemon, envelope, policy, policyColumn, row } from './board-fixtures.ts';
import { mount, mountEachTest, one, serve, settle } from './board-harness.ts';

mountEachTest();

const css = (name: string) => `.${styles[name] ?? 'missing'}`;
const NAME = 'quality-assurance-qa';
const [projectA] = config.projects;
if (!projectA) throw new Error('fixture config has a project');
const WARN_CONFIG = {
  ...config,
  projects: [
    {
      ...projectA,
      columns: [
        { id: 'qa', executor: { kind: 'orchestrator', name: NAME } },
        { id: 'done', executor: { kind: 'dispatcher', name: null } },
      ],
    },
  ],
};
const ANSWER = policy('a', [
  policyColumn('qa', {
    executor: {
      kind: 'orchestrator',
      project: NAME,
      role: 'orchestrator',
      displayName: NAME,
      session: null,
      text: `A session of ${NAME} takes the turn.`,
    },
  }),
  policyColumn('done'),
]);

describe('column head warning', () => {
  it('keeps the no-live-session words outside the clipped executor text', async () => {
    const d = daemon();
    serve(d, [row('Q-1', 'qa')], WARN_CONFIG);
    d.routes['columns.describe'] = () => Promise.resolve(envelope(ANSWER));
    mount(d);
    await settle();
    const trigger = one('main button[aria-haspopup="dialog"]');
    expect(trigger.hasAttribute('data-warn')).toBe(true);
    const text = trigger.querySelector(css('execText'));
    const warning = trigger.querySelector(css('execWarn'));
    expect(text?.textContent).toBe(`orchestrator ${NAME}`);
    expect(warning?.textContent).toBe(' · no live session');
    expect(warning?.parentElement).toBe(trigger);
    expect(text?.contains(warning ?? null)).toBe(false);
    expect(trigger.textContent).toBe(`orchestrator ${NAME} · no live session`);
    expect(trigger.title).toBe('How qa works: who acts and the rules · no live session');
  });
});
