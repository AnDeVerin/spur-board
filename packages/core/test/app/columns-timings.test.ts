import { columnTurnTimings, configSchema, type ColumnId } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { stuckTurnAfterMs, turnExecutor } from '../../src/app/turns.ts';
import { openTempStore } from '../support/store.ts';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

it.each([
  {
    name: 'named defaults',
    column: 'qa',
    binding: 'conductor',
    quiet: undefined,
    missing: undefined,
    named: true,
  },
  {
    name: 'named overrides',
    column: 'qa',
    binding: 'conductor',
    quiet: 5400000,
    missing: 2700000,
    named: true,
  },
  {
    name: 'curator overrides',
    column: 'product-review',
    binding: 'cur',
    quiet: 3600000,
    missing: 900000,
    named: true,
  },
  {
    name: 'board-wide overrides',
    column: 'review',
    binding: 'none',
    quiet: 4500000,
    missing: 1200000,
    named: true,
  },
  {
    name: 'worker',
    column: 'dev',
    binding: 'none',
    quiet: undefined,
    missing: undefined,
    named: false,
  },
  {
    name: 'operator',
    column: 'qa',
    binding: 'operator',
    quiet: undefined,
    missing: undefined,
    named: false,
  },
  {
    name: 'unbound external review',
    column: 'external-review',
    binding: 'none',
    quiet: undefined,
    missing: undefined,
    named: false,
  },
  {
    name: 'Todo binding opens no turns',
    column: 'todo',
    binding: 'conductor',
    quiet: undefined,
    missing: undefined,
    named: true,
  },
  {
    name: 'disabled named',
    column: 'qa',
    binding: 'conductor',
    quiet: undefined,
    missing: undefined,
    named: true,
  },
] as const)(
  'describes effective turn timing for $name',
  async ({ name, column, binding, quiet, missing, named }) => {
    const store = openTempStore('board-column-timings-').store;
    stores.push(store);
    const config = configSchema.parse({
      projects: [
        {
          id: 'policy',
          tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          spurProjects: [
            { name: 'conductor', role: 'orchestrator' },
            { name: 'cur', role: 'curator' },
          ],
          columns: (
            [
              'todo',
              'dev',
              'review',
              'product-review',
              'external-review',
              'qa',
              'done',
            ] satisfies ColumnId[]
          ).map((id) => ({
            id,
            enabled: !(name === 'disabled named' && id === column),
            orchestrator: id === column ? binding : 'none',
            ...(id !== column || quiet === undefined ? {} : { quietTurnAfterMs: quiet }),
            ...(id !== column || missing === undefined ? {} : { noRecipientAfterMs: missing }),
          })),
        },
      ],
      spurProjects:
        name === 'board-wide overrides'
          ? [{ name: 'global', role: 'orchestrator', columns: ['review'] }]
          : [],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
      health: { idleInDevAfterMs: 12345 },
    });
    const registry = createOperationRegistry({
      config,
      clock: { now: () => 0 },
      completeSince: new Map(),
    });
    const query = createQuery({ store, config, clock: { now: () => 0 } });
    const policy = (
      await query(registry['columns.describe'], {}, 'operator')
    ).projects[0]?.columns.find((entry) => entry.id === column);
    const timings = columnTurnTimings(config, 'policy', column);
    if (name === 'disabled named') {
      expect(policy).toBeUndefined();
      expect(timings).toBeNull();
      return;
    }
    if (policy === undefined) throw new Error('missing policy');
    const configured = config.projects[0]?.columns.find((entry) => entry.id === column);
    if (configured === undefined) throw new Error('missing config');
    const role = turnExecutor(column, configured.orchestrator, true);
    if (column === 'todo' || binding === 'operator' || column === 'external-review') {
      expect(policy.escalation.silent).toBeNull();
      expect(policy.escalation.noRecipient).toBeNull();
      return;
    }
    const threshold = stuckTurnAfterMs(config, 'policy', { column, role });
    expect(policy.escalation.silent?.remindAfterMs).toBe(threshold);
    expect(policy.escalation.silent?.operatorItemAfterReminderReadMs).toBe(threshold);
    if (named) {
      expect(policy.escalation.silent?.remindAfterMs).toBe(quiet ?? config.health.idleInDevAfterMs);
      expect(policy.escalation.noRecipient?.operatorItemAfterMs).toBe(timings?.noRecipientAfterMs);
      if (missing !== undefined)
        expect(policy.escalation.noRecipient?.operatorItemAfterMs).toBe(missing);
      expect(policy.escalation.noRecipient?.text).toContain('later of ring creation');
      expect(policy.escalation.noRecipient?.text).toContain('last eligible session');
      expect(policy.escalation.noRecipient?.text).toContain('blind, incomplete or stale');
      expect(policy.escalation.noRecipient?.text).toContain('one operator item per project/column');
      expect(policy.escalation.silent?.text).toContain(
        'Existing worker/operator turns keep the global idle threshold',
      );
      expect(stuckTurnAfterMs(config, 'policy', { column, role: 'worker' })).toBe(
        config.health.idleInDevAfterMs,
      );
      const compact = (
        await query(registry['config.get'], {}, 'operator')
      ).projects[0]?.columns.find((entry) => entry.id === column);
      expect(compact?.quietTurnAfterMs).toBe(threshold);
      expect(compact?.noRecipientAfterMs).toBe(policy.escalation.noRecipient?.operatorItemAfterMs);
    } else {
      expect(policy.escalation.silent?.remindAfterMs).toBe(config.health.idleInDevAfterMs);
      expect(policy.escalation.noRecipient).toBeNull();
    }
  },
);

it.each<{ name: string; quietAfterMs: number | undefined }>([
  { name: 'set', quietAfterMs: 600_000 },
  { name: 'zero', quietAfterMs: 0 },
  { name: 'unset', quietAfterMs: undefined },
])(
  'describes the External Review quiet item and shows quietAfterMs in config.get when $name',
  async ({ quietAfterMs }) => {
    const store = openTempStore('board-column-quiet-').store;
    stores.push(store);
    const config = configSchema.parse({
      projects: [
        {
          id: 'policy',
          tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
          repos: ['o/r'],
          operatorGithubLogin: 'operator',
          columns: (['todo', 'dev', 'review', 'external-review', 'done'] satisfies ColumnId[]).map(
            (id) => ({
              id,
              ...(id !== 'external-review' || quietAfterMs === undefined ? {} : { quietAfterMs }),
            }),
          ),
        },
      ],
      operator: { slack: 'operator' },
      digest: { tz: 'UTC' },
    });
    const registry = createOperationRegistry({
      config,
      clock: { now: () => 0 },
      completeSince: new Map(),
    });
    const query = createQuery({ store, config, clock: { now: () => 0 } });
    const described = (await query(registry['columns.describe'], {}, 'operator')).projects[0]
      ?.columns;
    const quiet = described?.find((entry) => entry.id === 'external-review')?.escalation.quiet;
    expect(quiet?.operatorItemAfterMs).toBe(quietAfterMs ?? 0);
    expect(quiet?.text).toContain('quietAfterMs');
    expect(quiet?.text).toContain('external-quiet:');
    expect(quiet?.text.split(/\.\s/).length).toBeLessThanOrEqual(2);
    for (const other of described?.filter((entry) => entry.id !== 'external-review') ?? [])
      expect(other.escalation.quiet).toBeNull();
    const compact = (await query(registry['config.get'], {}, 'operator')).projects[0]?.columns;
    const external = compact?.find((entry) => entry.id === 'external-review');
    if (quietAfterMs === 600_000) expect(external?.quietAfterMs).toBe(600_000);
    else expect(external).not.toHaveProperty('quietAfterMs');
    for (const other of compact?.filter((entry) => entry.id !== 'external-review') ?? [])
      expect(other).not.toHaveProperty('quietAfterMs');
  },
);
