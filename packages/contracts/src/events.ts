import { z } from 'zod';
import {
  ACTORS,
  ADDRESSEE_ROLES,
  ARCHIVE_REASONS,
  BLOCK_OUTCOMES,
  BLOCK_TYPES,
  COLUMNS,
  LINK_SOURCES,
  PR_LINK_STATES,
  SESSION_END_REASONS,
  SESSION_LINK_ROLES,
} from './enums.ts';

export const EVENT_KINDS = [
  'head_moved',
  'checks_changed',
  'review_submitted',
  'mergeable_changed',
  'pr_state_changed',
  'ticket_status_changed',
  'session_state_changed',
  'link_added',
  'link_removed',
  'task_added',
  'task_archived',
  'block_opened',
  'block_escalated',
  'block_unblocked',
  'comment_added',
  'comment_acked',
  'doorbell_rung',
  'doorbell_read',
  'doorbell_undelivered',
  'inbound_failed',
  'from_you_raised',
  'from_you_cleared',
  'flag_raised',
  'flag_cleared',
  'operation_denied',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Version written to `v` by the current code. */
export const EVENT_VERSION = 1;

const S = z.string().min(1);
const N = z.int().positive();
const from = S.nullable();
const role = z.enum(ADDRESSEE_ROLES);
const prChange = { repo: S, pr: N, from, to: S };

// Payloads accept unknown keys so an older reader can replay a newer journal.
export const eventPayloadSchemas = {
  head_moved: z.object(prChange),
  checks_changed: z.object({ ...prChange, sha: S }),
  review_submitted: z.object({ repo: S, pr: N, reviewer: S, state: S }),
  mergeable_changed: z.object(prChange),
  pr_state_changed: z.object(prChange),
  ticket_status_changed: z.object({ from, to: S }),
  session_state_changed: z.object({
    session: S,
    from,
    to: S,
    endReason: z.enum(SESSION_END_REASONS).optional(),
  }),
  link_added: z.discriminatedUnion('entity', [
    z.object({
      entity: z.literal('session'),
      session: S,
      role: z.enum(SESSION_LINK_ROLES),
      source: z.enum(LINK_SOURCES),
    }),
    z.object({
      entity: z.literal('pr'),
      repo: S,
      pr: N,
      state: z.enum(PR_LINK_STATES),
      source: z.enum(LINK_SOURCES),
    }),
  ]),
  link_removed: z.discriminatedUnion('entity', [
    z.object({ entity: z.literal('session'), session: S }),
    z.object({ entity: z.literal('pr'), repo: S, pr: N }),
  ]),
  task_added: z.object({ column: z.enum(COLUMNS) }),
  task_archived: z.object({ reason: z.enum(ARCHIVE_REASONS) }),
  block_opened: z.object({ block: S, type: z.enum(BLOCK_TYPES), addressee: role }),
  block_escalated: z.object({ block: S, from: role, to: role }),
  block_unblocked: z.object({ block: S, outcome: z.enum(BLOCK_OUTCOMES) }),
  comment_added: z.object({ comment: S, addressee: role }),
  comment_acked: z.object({ comment: S }),
  doorbell_rung: z.object({ doorbell: S, addressee: role, attempt: N }),
  doorbell_read: z.object({ doorbell: S }),
  doorbell_undelivered: z.object({ doorbell: S, reason: S }),
  inbound_failed: z.object({ gateway: S, reason: S }),
  from_you_raised: z.object({ item: S }),
  from_you_cleared: z.object({ item: S }),
  flag_raised: z.object({ flag: S, session: S.optional() }),
  flag_cleared: z.object({ flag: S, session: S.optional() }),
  operation_denied: z.object({ operation: S, reason: S }),
} satisfies Record<EventKind, z.ZodType>;

export type EventPayload<K extends EventKind> = z.output<(typeof eventPayloadSchemas)[K]>;

/** One journal line. `payload` is checked against the schema for `kind` by `parseEvent`. */
export const eventEnvelopeSchema = z.object({
  id: S,
  at: z.iso.datetime(),
  project: S,
  taskId: S.optional(),
  kind: z.enum(EVENT_KINDS),
  actor: z.enum(ACTORS),
  payload: z.unknown(),
  v: z.int().min(1),
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
