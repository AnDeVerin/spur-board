import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EVENT_KINDS,
  EVENT_VERSION,
  type EventKind,
  type JournalEvent,
  type PrFacts,
  type SessionFacts,
  type TicketFacts,
  eventPayloadSchemas,
  parseEvent,
} from '../src/index.ts';

const base = {
  id: 'evt-1',
  at: '2026-01-05T09:30:00.000Z',
  project: 'web',
  taskId: 'PROJ-1',
  actor: 'agent',
  actorRef: { project: 'web-worker', session: 'sess-1' },
  requestId: 'req-1',
  v: EVENT_VERSION,
} as const;

const pr = { repo: 'example-org/web', pr: 7 };
const prFacts: PrFacts = {
  repo: pr.repo,
  number: pr.pr,
  url: 'https://github.com/example-org/web/pull/7',
  title: 'PROJ-1 Work',
  author: 'octocat',
  headSha: 'a'.repeat(40),
  headBranch: 'PROJ-1-work',
  state: 'open',
  draft: false,
  mergeable: 'unknown',
  mergeState: 'unknown',
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: ['PROJ-1'],
  updatedAt: base.at,
};
const ticketFacts: TicketFacts = {
  trackerId: 'web',
  id: '10001',
  key: 'PROJ-1',
  title: 'Work',
  status: 'To Do',
  assignee: null,
  sprint: null,
  labels: [],
  inFilter: true,
  url: 'https://example.test/browse/PROJ-1',
  updatedAt: base.at,
};
const sessionFacts: SessionFacts = {
  id: 'sess-1',
  spurProject: 'web-worker',
  branch: null,
  pr: null,
  links: {},
  lifecycle: 'running',
  health: 'working',
  healthSince: base.at,
  lastActivityAt: null,
  endedAt: null,
  endReason: null,
};

// A kind missing here is a compile error.
const samples: { [K in EventKind]: Extract<JournalEvent, { kind: K }> } = {
  head_moved: { ...base, kind: 'head_moved', payload: { ...pr, from: 'abc1', to: 'def2' } },
  pr_facts_changed: { ...base, kind: 'pr_facts_changed', payload: { facts: prFacts } },
  checks_changed: {
    ...base,
    kind: 'checks_changed',
    payload: { ...pr, sha: 'def2', from: null, to: 'success' },
  },
  review_submitted: {
    ...base,
    kind: 'review_submitted',
    payload: { ...pr, reviewer: 'octocat', state: 'approved' },
  },
  mergeable_changed: {
    ...base,
    kind: 'mergeable_changed',
    payload: { ...pr, from: 'clean', to: 'dirty' },
  },
  pr_state_changed: {
    ...base,
    kind: 'pr_state_changed',
    payload: { ...pr, from: 'open', to: 'merged' },
  },
  ticket_status_changed: {
    ...base,
    kind: 'ticket_status_changed',
    payload: { from: 'To Do', to: 'In Progress' },
  },
  ticket_facts_changed: { ...base, kind: 'ticket_facts_changed', payload: { facts: ticketFacts } },
  session_state_changed: {
    ...base,
    kind: 'session_state_changed',
    payload: { session: 'sess-1', from: 'running', to: 'ended', endReason: 'complete' },
  },
  session_facts_changed: {
    ...base,
    kind: 'session_facts_changed',
    payload: { facts: sessionFacts },
  },
  spur_unknown_state: {
    ...base,
    kind: 'spur_unknown_state',
    payload: { kind: 'unknown_state', value: 'future-state' },
  },
  link_added: {
    ...base,
    kind: 'link_added',
    payload: { entity: 'pr', ...pr, state: 'active', source: 'branch' },
  },
  link_removed: {
    ...base,
    kind: 'link_removed',
    payload: { entity: 'session', session: 'sess-1' },
  },
  task_added: { ...base, kind: 'task_added', payload: { column: 'todo' } },
  task_archived: { ...base, kind: 'task_archived', payload: { reason: 'done' } },
  block_opened: {
    ...base,
    kind: 'block_opened',
    payload: { block: 'blk-1', type: 'needs_input', addressee: 'orchestrator:qa' },
  },
  block_escalated: {
    ...base,
    kind: 'block_escalated',
    payload: { block: 'blk-1', from: 'curator', to: 'operator', reason: 'unanswered' },
  },
  block_unblocked: {
    ...base,
    kind: 'block_unblocked',
    payload: { block: 'blk-1', outcome: 'reason', reason: 'not needed after all' },
  },
  comment_added: {
    ...base,
    kind: 'comment_added',
    payload: { comment: 'cmt-1', addressee: 'worker' },
  },
  comment_edited: {
    ...base,
    kind: 'comment_edited',
    payload: { comment: 'cmt-1', revision: 2, clarification: true },
  },
  comment_deleted: { ...base, kind: 'comment_deleted', payload: { comment: 'cmt-1' } },
  comment_acked: { ...base, kind: 'comment_acked', payload: { comment: 'cmt-1' } },
  doorbell_rung: {
    ...base,
    kind: 'doorbell_rung',
    payload: { doorbell: 'door-1', addressee: 'operator', attempt: 2 },
  },
  doorbell_read: { ...base, kind: 'doorbell_read', payload: { doorbell: 'door-1' } },
  doorbell_undelivered: {
    ...base,
    kind: 'doorbell_undelivered',
    payload: { doorbell: 'door-1', reason: 'session gone' },
  },
  inbound_failed: {
    ...base,
    kind: 'inbound_failed',
    payload: { gateway: 'slack', reason: 'bad signature' },
  },
  inbound_skipped: {
    ...base,
    kind: 'inbound_skipped',
    payload: { gateway: 'slack', reason: 'Unknown board conversation.' },
  },
  from_you_raised: { ...base, kind: 'from_you_raised', payload: { item: 'item-1' } },
  from_you_cleared: { ...base, kind: 'from_you_cleared', payload: { item: 'item-1' } },
  flag_raised: {
    ...base,
    kind: 'flag_raised',
    payload: { flag: 'stale', session: 'sess-1' },
  },
  flag_cleared: { ...base, kind: 'flag_cleared', payload: { flag: 'stale' } },
  operation_denied: {
    ...base,
    kind: 'operation_denied',
    payload: { operation: 'archive', reason: 'task has an open block' },
  },
  token_requested: { ...base, kind: 'token_requested', payload: { name: 'desk' } },
  token_approved: { ...base, kind: 'token_approved', payload: { name: 'desk' } },
  token_denied: { ...base, kind: 'token_denied', payload: { name: 'desk' } },
  token_expired: { ...base, kind: 'token_expired', payload: { name: 'desk' } },
  token_revoked: { ...base, kind: 'token_revoked', payload: { name: 'desk' } },
};

describe('event kinds', () => {
  it('has a payload schema for each of the 37 kinds', () => {
    expect(EVENT_KINDS).toHaveLength(37);
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it.each(EVENT_KINDS)('converts the %s payload to JSON Schema in output mode', (kind) => {
    expect(() => z.toJSONSchema(eventPayloadSchemas[kind], { io: 'output' })).not.toThrow();
  });
});

describe('parseEvent', () => {
  it('accepts a manual ticket link and a reason while retaining older link events', () => {
    expect(parseEvent(samples.link_added).status).toBe('ok');
    expect(
      parseEvent({
        ...base,
        kind: 'link_added',
        payload: {
          entity: 'ticket',
          ticket: 'PROJ-456',
          source: 'manual',
          reason: 'Related work.',
        },
      }).status,
    ).toBe('ok');
    expect(
      parseEvent({
        ...base,
        kind: 'link_removed',
        payload: { entity: 'ticket', ticket: 'PROJ-456', reason: 'No longer related.' },
      }).status,
    ).toBe('ok');
  });

  it('accepts an optional rule on a raised operator item', () => {
    const event = {
      ...samples.from_you_raised,
      payload: { item: 'I1', rule: '@secretlint/secretlint-rule-slack' },
    };
    expect(parseEvent(event)).toEqual({ status: 'ok', event });
    expect(parseEvent(samples.from_you_raised)).toEqual({
      status: 'ok',
      event: samples.from_you_raised,
    });
  });

  it.each(EVENT_KINDS)('round-trips a %s event through JSON', (kind) => {
    const sample = samples[kind];
    expect(parseEvent(JSON.parse(JSON.stringify(sample)))).toEqual({
      status: 'ok',
      event: sample,
    });
  });

  it('skips an unknown kind without throwing', () => {
    const raw = { ...base, kind: 'future_kind', payload: { anything: true } };
    expect(() => parseEvent(raw)).not.toThrow();
    expect(parseEvent(raw)).toEqual({ status: 'skipped', kind: 'future_kind' });
  });

  it('rejects a payload that does not match its kind, with a payload path', () => {
    const result = parseEvent({ ...samples.head_moved, payload: {} });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.error.issues.map((issue) => issue.path[0])).toContain('payload');
    expect(z.prettifyError(result.error)).toContain('→ at payload.repo');
  });

  it.each(EVENT_KINDS)('keeps unknown payload fields of %s', (kind) => {
    const event = { ...samples[kind], payload: { ...samples[kind].payload, addedLater: 1 } };
    expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual({ status: 'ok', event });
  });

  it('rejects an envelope with a non-UTC timestamp', () => {
    expect(parseEvent({ ...samples.head_moved, at: '2026-01-05T09:30:00+01:00' }).status).toBe(
      'invalid',
    );
  });
});

describe('actor', () => {
  const { actorRef, ...withoutRef } = samples.head_moved;

  it('rejects an agent event without actorRef, with its path', () => {
    const result = parseEvent(withoutRef);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(z.prettifyError(result.error)).toContain('actorRef is required when actor is agent');
    expect(z.prettifyError(result.error)).toContain('→ at actorRef');
  });

  it.each(['operator', 'system'] as const)('parses a %s event without actorRef', (actor) => {
    const event = { ...withoutRef, actor };
    expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual({ status: 'ok', event });
  });

  it.each(['operator', 'system'] as const)('rejects a %s event with actorRef', (actor) => {
    const result = parseEvent({ ...withoutRef, actor, actorRef });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(z.prettifyError(result.error)).toContain('→ at actorRef');
  });

  it.each([
    [{ project: 'a/b', session: 'sess-1' }, 'actorRef.project'],
    [{ project: 'web', session: 'b/c' }, 'actorRef.session'],
    [{ project: '', session: 'sess-1' }, 'actorRef.project'],
  ])('rejects actorRef %j, at %s', (ref, path) => {
    const result = parseEvent({ ...samples.head_moved, actorRef: ref });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(z.prettifyError(result.error)).toContain(`→ at ${path}`);
  });

  it('parses an actorRef with real spur project and session names', () => {
    const event = { ...samples.head_moved, actorRef: { project: 'sb', session: 'sb-6949' } };
    expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual({ status: 'ok', event });
  });

  it('parses an event without requestId', () => {
    const result = parseEvent(
      JSON.parse(JSON.stringify({ ...samples.head_moved, requestId: undefined })),
    );
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && Object.keys(result.event)).not.toContain('requestId');
  });
});

describe('addressee role', () => {
  const opened = samples.block_opened.payload;

  it.each(['orchestrator:Foo', 'orchestrator:QA'])('rejects %s', (addressee) => {
    const result = eventPayloadSchemas.block_opened.safeParse({ ...opened, addressee });
    expect(result.success).toBe(false);
  });

  it('accepts an orchestrator of a board column id', () => {
    const result = eventPayloadSchemas.block_opened.safeParse({
      ...opened,
      addressee: 'orchestrator:ready-to-merge',
    });
    expect(result.success).toBe(true);
  });
});
