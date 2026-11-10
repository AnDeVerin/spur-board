import { expect, it } from 'vitest';
import {
  ACTORS,
  ADDRESSEE_ROLES,
  ARCHIVE_REASONS,
  BLOCK_OUTCOMES,
  BLOCK_STATES,
  BLOCK_TYPES,
  COLUMNS,
  COLUMN_IDS,
  LINK_SOURCES,
  MEMBERSHIPS,
  PR_LINK_STATES,
  REQUIRED_COLUMN_IDS,
  SESSION_END_REASONS,
  SESSION_LINK_ROLES,
} from '../src/index.ts';

it('lists the built-in columns from To Do to Done, with ids and display names', () => {
  expect(COLUMNS).toEqual([
    { id: 'todo', name: 'To Do', required: true },
    { id: 'ready-for-dev', name: 'Ready for Dev', required: false },
    { id: 'dev', name: 'Dev', required: true },
    { id: 'review', name: 'Review', required: false },
    { id: 'qa', name: 'QA', required: false },
    { id: 'ready-to-merge', name: 'Ready to Merge', required: false },
    { id: 'done', name: 'Done', required: true },
  ]);
  expect(COLUMN_IDS).toEqual([
    'todo',
    'ready-for-dev',
    'dev',
    'review',
    'qa',
    'ready-to-merge',
    'done',
  ]);
  expect(REQUIRED_COLUMN_IDS).toEqual(['todo', 'dev', 'done']);
});

it('lists memberships', () => {
  expect(MEMBERSHIPS).toEqual(['active', 'out_of_filter', 'archived']);
});

it('lists archive reasons', () => {
  expect(ARCHIVE_REASONS).toEqual(['done', 'out_of_filter', 'manual']);
});

it('lists block types', () => {
  expect(BLOCK_TYPES).toEqual(['code', 'needs_input', 'dependency', 'external']);
});

it('lists block states', () => {
  expect(BLOCK_STATES).toEqual(['open', 'unblocked']);
});

it('lists block outcomes', () => {
  expect(BLOCK_OUTCOMES).toEqual(['done', 'reason', 'terminal', 'withdrawn', 'archived']);
});

it('lists addressee roles: operator, curator, one orchestrator per column id, worker', () => {
  expect(ADDRESSEE_ROLES).toEqual([
    'operator',
    'curator',
    'orchestrator:todo',
    'orchestrator:ready-for-dev',
    'orchestrator:dev',
    'orchestrator:review',
    'orchestrator:qa',
    'orchestrator:ready-to-merge',
    'orchestrator:done',
    'worker',
  ]);
});

it('lists session link roles', () => {
  expect(SESSION_LINK_ROLES).toEqual(['worker', 'other', 'orchestrator']);
});

it('lists link sources', () => {
  expect(LINK_SOURCES).toEqual(['spawn_link', 'branch', 'manual']);
});

it('lists PR link states', () => {
  expect(PR_LINK_STATES).toEqual(['active', 'conflict']);
});

it('lists session end reasons', () => {
  expect(SESSION_END_REASONS).toEqual(['complete', 'kill', 'vanished', 'unknown']);
});

it('lists actors', () => {
  expect(ACTORS).toEqual(['operator', 'agent', 'system']);
});
