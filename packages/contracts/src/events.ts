import { z } from 'zod';
import {
  ACTORS,
  ADDRESSEE_ROLES,
  ARCHIVE_REASONS,
  BLOCK_OUTCOMES,
  BLOCK_TYPES,
  COLUMN_IDS,
  DISPATCHER_MODES,
  LINK_SOURCES,
  PR_LINK_STATES,
  SESSION_END_REASONS,
  SESSION_LINK_ROLES,
} from './enums.ts';
import { actorPartSchema } from './ids.ts';
import { prFactsSchema, sessionFactsSchema, ticketFactsSchema } from './facts.ts';

export const EVENT_KINDS = [
  'head_moved',
  'pr_facts_changed',
  'checks_changed',
  'review_submitted',
  'mergeable_changed',
  'pr_state_changed',
  'ticket_status_changed',
  'ticket_facts_changed',
  'session_state_changed',
  'session_facts_changed',
  'spur_unknown_state',
  'link_added',
  'link_removed',
  'task_added',
  'task_archived',
  'task_submitted',
  'task_moved',
  'task_shadow_moved',
  'task_corrected',
  'dispatcher_mode_changed',
  'block_opened',
  'block_escalated',
  'block_unblocked',
  'comment_added',
  'comment_edited',
  'comment_deleted',
  'comment_acked',
  'doorbell_rung',
  'doorbell_read',
  'doorbell_undelivered',
  'inbound_failed',
  'inbound_skipped',
  'from_you_raised',
  'from_you_cleared',
  'flag_raised',
  'flag_cleared',
  'operation_denied',
  'token_requested',
  'token_approved',
  'token_denied',
  'token_expired',
  'token_revoked',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Why a column gate fails, in the order the gates report them. */
export const GATE_REASONS = [
  'no_pr',
  'pr_closed',
  'pr_draft',
  'checks_red',
  'checks_pending',
  'conflict',
  'mergeable_unknown',
  'external_comments',
  'comment_history_incomplete',
  'no_submit_on_head',
  'no_review_on_head',
  'not_approved',
  'not_merged',
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

/** Why the dispatcher moved a task. */
export const MOVE_REASONS = [
  'gate_passed',
  'gate_broken',
  'merged',
  'ticket_reopened',
  'mode_changed',
] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

/** Version written to `v` by the current code. */
export const EVENT_VERSION = 1;

const S = z.string().min(1);
const N = z.int().positive();
const from = S.nullable();
const role = z.enum(ADDRESSEE_ROLES);
const prChange = { repo: S, pr: N, from, to: S };

// Payloads keep unknown keys, so a field added by a newer writer survives parsing.
export const eventPayloadSchemas = {
  head_moved: z.looseObject(prChange),
  pr_facts_changed: z.looseObject({ facts: prFactsSchema }),
  checks_changed: z.looseObject({ ...prChange, sha: S }),
  review_submitted: z.looseObject({ repo: S, pr: N, reviewer: S, state: S }),
  mergeable_changed: z.looseObject(prChange),
  pr_state_changed: z.looseObject(prChange),
  ticket_status_changed: z.looseObject({ from, to: S }),
  ticket_facts_changed: z.looseObject({ facts: ticketFactsSchema }),
  session_state_changed: z.looseObject({
    session: S,
    from,
    to: S,
    endReason: z.enum(SESSION_END_REASONS).optional(),
  }),
  session_facts_changed: z.looseObject({ facts: sessionFactsSchema }),
  spur_unknown_state: z.looseObject({
    kind: z.enum(['unknown_state', 'unknown_status']),
    value: S,
  }),
  link_added: z.discriminatedUnion('entity', [
    z.looseObject({
      entity: z.literal('session'),
      session: S,
      role: z.enum(SESSION_LINK_ROLES),
      source: z.enum(LINK_SOURCES),
      facts: sessionFactsSchema.optional(),
      reason: S.optional(),
    }),
    z.looseObject({
      entity: z.literal('pr'),
      repo: S,
      pr: N,
      state: z.enum(PR_LINK_STATES),
      source: z.enum(LINK_SOURCES),
      facts: prFactsSchema.optional(),
      reason: S.optional(),
    }),
    z.looseObject({
      entity: z.literal('ticket'),
      ticket: S,
      source: z.enum(LINK_SOURCES),
      reason: S.optional(),
    }),
  ]),
  link_removed: z.discriminatedUnion('entity', [
    z.looseObject({ entity: z.literal('session'), session: S, reason: S.optional() }),
    z.looseObject({ entity: z.literal('pr'), repo: S, pr: N, reason: S.optional() }),
    z.looseObject({ entity: z.literal('ticket'), ticket: S, reason: S.optional() }),
  ]),
  task_added: z.looseObject({ column: z.enum(COLUMN_IDS) }),
  task_archived: z.looseObject({ reason: z.enum(ARCHIVE_REASONS) }),
  task_submitted: z.looseObject({ turn: S.optional(), column: z.enum(COLUMN_IDS), sha: S }),
  task_moved: z.looseObject({
    from: z.enum(COLUMN_IDS),
    to: z.enum(COLUMN_IDS),
    turn: S.optional(),
    block: S.optional(),
    reason: z.enum(MOVE_REASONS).optional(),
    gate: z.array(z.enum(GATE_REASONS)).optional(),
  }),
  task_shadow_moved: z.looseObject({
    from: z.enum(COLUMN_IDS),
    to: z.enum(COLUMN_IDS),
    reason: z.enum(MOVE_REASONS),
    gate: z.array(z.enum(GATE_REASONS)).optional(),
  }),
  task_corrected: z.looseObject({
    from: z.enum(COLUMN_IDS),
    to: z.enum(COLUMN_IDS),
    reason: S,
    shadow: z.boolean(),
  }),
  dispatcher_mode_changed: z.looseObject({
    from: z.enum(DISPATCHER_MODES),
    to: z.enum(DISPATCHER_MODES),
  }),
  block_opened: z.looseObject({ block: S, type: z.enum(BLOCK_TYPES), addressee: role }),
  block_escalated: z.looseObject({ block: S, from: role, to: role, reason: S.optional() }),
  block_unblocked: z.looseObject({
    block: S,
    outcome: z.enum(BLOCK_OUTCOMES),
    reason: S.optional(),
  }),
  comment_added: z.looseObject({ comment: S, addressee: role }),
  comment_edited: z.looseObject({ comment: S, revision: N, clarification: z.boolean() }),
  comment_deleted: z.looseObject({ comment: S }),
  comment_acked: z.looseObject({ comment: S, revision: N.optional() }),
  doorbell_rung: z.looseObject({ doorbell: S, addressee: role, attempt: N }),
  doorbell_read: z.looseObject({ doorbell: S }),
  doorbell_undelivered: z.looseObject({ doorbell: S, reason: S }),
  inbound_failed: z.looseObject({ gateway: S, reason: S }),
  inbound_skipped: z.looseObject({ gateway: S, reason: S }),
  from_you_raised: z.looseObject({ item: S, rule: S.optional() }),
  from_you_cleared: z.looseObject({ item: S }),
  flag_raised: z.looseObject({ flag: S, session: S.optional() }),
  flag_cleared: z.looseObject({ flag: S, session: S.optional() }),
  operation_denied: z.looseObject({ operation: S, reason: S }),
  token_requested: z.looseObject({ name: S }),
  token_approved: z.looseObject({ name: S }),
  token_denied: z.looseObject({ name: S }),
  token_expired: z.looseObject({ name: S }),
  token_revoked: z.looseObject({ name: S }),
} satisfies Record<EventKind, z.ZodType>;

export type EventPayload<K extends EventKind> = z.output<(typeof eventPayloadSchemas)[K]>;

/**
 * One journal line. `payload` is checked against the schema for `kind` by `parseEvent`.
 * `actorRef` names the agent (its spur project and session) and is set only when `actor` is
 * `agent`. Both parts are non-empty and use only letters, digits, `.`, `_` and `-`, so the pair
 * encodes into one `ActorId`. `requestId` links the event to the command that caused it.
 */
export const eventEnvelopeSchema = z
  .object({
    id: S,
    at: z.iso.datetime(),
    project: S,
    taskId: S.optional(),
    kind: z.enum(EVENT_KINDS),
    actor: z.enum(ACTORS),
    actorRef: z.object({ project: actorPartSchema, session: actorPartSchema }).optional(),
    requestId: S.optional(),
    payload: z.unknown(),
    v: z.int().min(1),
  })
  .superRefine((event, ctx) => {
    if (event.actor === 'agent' && event.actorRef === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['actorRef'],
        message: 'actorRef is required when actor is agent',
      });
    } else if (event.actor !== 'agent' && event.actorRef !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['actorRef'],
        message: `actorRef is set only when actor is agent, not ${event.actor}`,
      });
    }
  });
export type EventEnvelope = z.output<typeof eventEnvelopeSchema>;

export type JournalEvent = {
  [K in EventKind]: Omit<EventEnvelope, 'kind' | 'payload'> & {
    kind: K;
    payload: EventPayload<K>;
  };
}[EventKind];

export type ParsedEvent =
  | { status: 'ok'; event: JournalEvent }
  | { status: 'skipped'; kind: string }
  | { status: 'invalid'; error: z.ZodError };

function isEventKind(kind: string): kind is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(kind);
}

/** Parses one journal line. A kind this code does not know is skipped, not an error. */
export function parseEvent(raw: unknown): ParsedEvent {
  if (typeof raw === 'object' && raw !== null && 'kind' in raw) {
    const { kind } = raw;
    if (typeof kind === 'string' && !isEventKind(kind)) return { status: 'skipped', kind };
  }
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { status: 'invalid', error: envelope.error };
  const payload = eventPayloadSchemas[envelope.data.kind].safeParse(envelope.data.payload);
  if (!payload.success) {
    return {
      status: 'invalid',
      error: new z.ZodError(
        payload.error.issues.map((issue) => ({ ...issue, path: ['payload', ...issue.path] })),
      ),
    };
  }
  // The kind and its payload were checked together above; TS cannot correlate them.
  const event = { ...envelope.data, payload: payload.data } as JournalEvent;
  return { status: 'ok', event };
}
