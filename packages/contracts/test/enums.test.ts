import { expect, it } from 'vitest';
import {
  ACTORS,
  ADDRESSEE_ROLES,
  ARCHIVE_REASONS,
  BLOCK_OUTCOMES,
  BLOCK_STATES,
  BLOCK_TYPES,
  COLUMNS,
  LINK_SOURCES,
  MEMBERSHIPS,
  PR_LINK_STATES,
  SESSION_END_REASONS,
  SESSION_LINK_ROLES,
  VERDICT_KINDS,
} from '../src/index.ts';

it('lists the columns from To Do to Done', () => {
  expect(COLUMNS).toEqual([
    'To Do',
    'Ready for Dev',
    'Dev',
    'Review',
    'QA',
    'Ready to Merge',
    'Done',
  ]);
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

it('lists addressee roles: operator, one orchestrator per column, worker', () => {
  expect(ADDRESSEE_ROLES).toEqual([
    'operator',
    'orchestrator:To Do',
    'orchestrator:Ready for Dev',
    'orchestrator:Dev',
    'orchestrator:Review',
    'orchestrator:QA',
    'orchestrator:Ready to Merge',
    'orchestrator:Done',
    'worker',
  ]);
});

it('lists verdict kinds', () => {
  expect(VERDICT_KINDS).toEqual(['approve', 'back', 'running', 'carried']);
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
