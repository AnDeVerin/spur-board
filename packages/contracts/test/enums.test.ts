import { expect, it } from 'vitest';
import {
  ACTORS,
  ADDRESSEE_ROLES,
  ARCHIVE_REASONS,
  BLOCK_OUTCOMES,
  BLOCK_STATES,
  BLOCK_TYPES,
  CHECKS_GATE_COLUMNS,
  COLUMN_GROUPS,
  COLUMNS,
  COLUMN_IDS,
  DISPATCHER_MODES,
  GATE_CONDITIONS,
  GATE_CONDITION_STATES,
  INBOX_KINDS,
  INBOX_SEVERITIES,
  isTodoGroupColumn,
  ITEM_KINDS,
  LINK_SOURCES,
  MEMBERSHIPS,
  PR_LINK_STATES,
  REQUIRED_COLUMN_IDS,
  SESSION_END_REASONS,
  SESSION_LINK_ROLES,
  TASK_HOLDS,
  WAITS_FOR_KINDS,
  TODO_GROUP_COLUMN_IDS,
  TOKEN_STATUSES,
  TURN_OUTCOMES,
  SUBMISSION_BASES,
  VIAS,
} from '../src/index.ts';

it('lists the built-in columns from To Do to Done, with ids, display names and properties', () => {
  const off = { group: null, returnable: false, marks: false, defaultEnabled: true };
  const todo = { group: 'todo', returnable: false, marks: false };
  const back = { group: null, returnable: true, defaultEnabled: true };
  expect(COLUMNS).toEqual([
    { id: 'todo', name: 'To Do', required: true, ...todo, defaultEnabled: true },
    { id: 'triage', name: 'Triage', required: false, ...todo, defaultEnabled: false },
    { id: 'ready-for-dev', name: 'Ready for Dev', required: false, ...todo, defaultEnabled: true },
    { id: 'dev', name: 'Dev', required: true, ...off },
    { id: 'review', name: 'Review', required: false, ...back, marks: true },
    { id: 'product-review', name: 'Product Review', required: false, ...back, marks: true },
    { id: 'external-review', name: 'External Review', required: false, ...back, marks: false },
    { id: 'qa', name: 'QA', required: false, ...back, marks: false },
    { id: 'ready-to-merge', name: 'Ready to Merge', required: false, ...back, marks: false },
    { id: 'done', name: 'Done', required: true, ...off },
  ]);
  expect(COLUMN_IDS).toEqual([
    'todo',
    'triage',
    'ready-for-dev',
    'dev',
    'review',
    'product-review',
    'external-review',
    'qa',
    'ready-to-merge',
    'done',
  ]);
  expect(REQUIRED_COLUMN_IDS).toEqual(['todo', 'dev', 'done']);
});

it('derives the Todo group', () => {
  expect(COLUMN_GROUPS).toEqual(['todo']);
  expect(TODO_GROUP_COLUMN_IDS).toEqual(['todo', 'triage', 'ready-for-dev']);
  expect(COLUMN_IDS.filter(isTodoGroupColumn)).toEqual(['todo', 'triage', 'ready-for-dev']);
});

it('lists memberships', () => {
  expect(MEMBERSHIPS).toEqual(['active', 'out_of_filter', 'archived']);
});

it('lists submission bases', () => {
  expect(SUBMISSION_BASES).toEqual(['tested', 'carried', 'skipped']);
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
    'orchestrator:triage',
    'orchestrator:ready-for-dev',
    'orchestrator:dev',
    'orchestrator:review',
    'orchestrator:product-review',
    'orchestrator:external-review',
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

it('lists write vias', () => {
  expect(VIAS).toEqual(['web', 'slack', 'cli', 'mcp']);
});

it('lists token statuses', () => {
  expect(TOKEN_STATUSES).toEqual(['pending', 'approved', 'denied', 'expired', 'revoked']);
});

it('lists dispatcher modes', () => {
  expect(DISPATCHER_MODES).toEqual(['shadow', 'on']);
});

it('lists turn outcomes', () => {
  expect(TURN_OUTCOMES).toEqual([
    'submitted',
    'returned',
    'moved',
    'corrected',
    'rerouted',
    'mode_changed',
    'archived',
  ]);
});

it('lists the columns a project checks gate may name, each left of qa', () => {
  expect(CHECKS_GATE_COLUMNS).toEqual(['dev', 'review', 'product-review', 'external-review']);
  for (const id of CHECKS_GATE_COLUMNS)
    expect(COLUMN_IDS.indexOf(id)).toBeLessThan(COLUMN_IDS.indexOf('qa'));
});

it('lists gate conditions and their states', () => {
  expect(GATE_CONDITIONS).toEqual([
    'pr_open',
    'not_draft',
    'checks_green',
    'checks_not_red',
    'no_conflict',
    'external_comments_handled',
    'comment_history_read',
    'threads_resolved',
    'submit_on_head',
    'review_on_head',
    'approved',
    'review_rule_satisfied',
    'merged',
  ]);
  expect(GATE_CONDITION_STATES).toEqual(['met', 'failed', 'waiting', 'unchecked']);
});

it('lists task holds', () => {
  expect(TASK_HOLDS).toEqual([
    'pr_snapshot_missing',
    'github_blind',
    'spur_blind',
    'ticket_unconfirmed',
    'submit_pending',
    'cycle_limit',
    'work_not_started',
  ]);
});

it('lists what a task waits for', () => {
  expect(WAITS_FOR_KINDS).toEqual([
    'turn',
    'merge',
    'approval',
    'ticket',
    'checks',
    'github',
    'spur',
    'board',
    'answer',
    'work',
    'gate',
    'done',
    'archived',
    'config',
  ]);
});

it('lists operator item kinds and the operator inbox kinds and severities', () => {
  const items = [
    'token_request',
    'post_blocked',
    'post_failed',
    'transport_health',
    'answer_undelivered',
    'worker_not_reading',
    'answer_author_unavailable',
    'inbound_failure',
    'inbound_gap',
    'board_observation',
    'worker_ended',
    'turn',
    'anomaly',
    'cycle_limit',
    'course_check',
    'conversation_waiting',
  ];
  expect(ITEM_KINDS).toEqual(items);
  expect(INBOX_KINDS).toEqual(['block', ...items]);
  expect(INBOX_SEVERITIES).toEqual(['attention', 'failure']);
});
