// The adapter port: one poll method per source. `Batch` is what an adapter hands back to core
// and is validated at runtime; `Adapter` and `PollContext` are built by core and are not.
import { z } from 'zod';
import { prFactsSchema, prRefSchema, sessionFactsSchema, ticketFactsSchema } from './facts.ts';
import { actorPartSchema, taskKeySchema } from './ids.ts';

export const ADAPTER_ERROR_KINDS = ['auth', 'config', 'throttled', 'transient'] as const;
export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

/** What the source answered for one requested entity. */
export const ENTITY_STATUSES = ['ok', 'not_found', 'no_access'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

/** Opaque, adapter-issued position in a source. Core stores it and never parses it. */
export const sourceCursorSchema = z.string().min(1).brand<'SourceCursor'>();
export type SourceCursor = z.output<typeof sourceCursorSchema>;

/** A requested entity: a pull request, a ticket or a session. */
export const entityRefSchema = z.discriminatedUnion('kind', [
  prRefSchema.extend({ kind: z.literal('pr').describe('A pull request.') }),
  z.strictObject({
    kind: z.literal('ticket').describe('A tracker ticket.'),
    trackerId: z.string().min(1).describe('Stable id of the tracker the ticket lives in.'),
    key: taskKeySchema,
  }),
  z.strictObject({
    kind: z.literal('session').describe('A Spur session.'),
    id: actorPartSchema.describe('Spur session name.'),
  }),
]);
export type EntityRef = z.output<typeof entityRefSchema>;
export type PrEntityRef = Extract<EntityRef, { kind: 'pr' }>;
export type TicketEntityRef = Extract<EntityRef, { kind: 'ticket' }>;
export type SessionEntityRef = Extract<EntityRef, { kind: 'session' }>;

/** The facts of one entity, tagged with their kind. */
export const batchItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pr').describe('Pull request facts.'),
    facts: prFactsSchema,
  }),
  z.strictObject({
    kind: z.literal('ticket').describe('Ticket facts.'),
    facts: ticketFactsSchema,
  }),
  z.strictObject({
    kind: z.literal('session').describe('Session facts.'),
    facts: sessionFactsSchema,
  }),
]);
export type BatchItem = z.output<typeof batchItemSchema>;

export const batchSchema = z
  .strictObject({
    source: z.string().min(1).describe('Id of the adapter that produced the batch.'),
    observedAt: z.iso.datetime().describe('When the poll started (A2).'),
    complete: z
      .boolean()
      .describe('Whether everything was listed without errors (A3); per-entity outcomes aside.'),
    items: z.array(batchItemSchema).describe('Facts observed in this poll.'),
    cursor: sourceCursorSchema
      .optional()
      .describe('Where the next poll continues; omitted when the source has none (A5).'),
    entities: z
      .array(
        z.strictObject({
          ref: entityRefSchema.describe('The requested entity.'),
          status: z.enum(ENTITY_STATUSES).describe('What the source answered for it.'),
        }),
      )
      .describe('One entry per entity core asked for (A4).'),
  })
  .describe('The result of one poll.');
export type Batch = z.output<typeof batchSchema>;

/** What core asks one poll to observe, built by core. */
export interface PollContext {
  /** Entities to observe besides the source's own listing. */
  observe: {
    /** Pull requests of board tasks. */
    prs: readonly PrEntityRef[];
    /** Tickets outside the tracker filter, fetched by key. */
    tickets: readonly TicketEntityRef[];
    /** Sessions linked to board tasks. */
    sessions: readonly SessionEntityRef[];
  };
  /** The cursor the previous batch returned; absent on the first poll. */
  cursor?: SourceCursor | undefined;
  /** Aborted when core stops the poll (A7). */
  signal: AbortSignal;
}

/**
 * One source of facts. Core calls `poll` every `intervalMs` and decides what the facts mean.
 *
 * Obligations:
 * - A1: A batch carries facts only. No wire format of the source (query fields, paging
 *   tokens, response JSON, headers) reaches the batch or core.
 * - A2: `observedAt` is the time the poll started, not when it finished.
 * - A3: `complete` is true only when the whole listing was read without errors. An incomplete
 *   batch still carries the facts it did observe. Core concludes anything from absence only
 *   after a complete batch.
 * - A4: `entities` holds exactly one entry for each ref in `PollContext.observe`. A per-entity
 *   outcome (`not_found`, `no_access`) does not clear `complete`. A requested session that
 *   answers 404 is reported as `not_found` with no item; it counts as resolved, and core
 *   records it as `vanished` at once, outside the gone-after-polls count.
 * - A5: The cursor is opaque to core. The adapter returns a new one or omits it, and it never
 *   moves backwards.
 * - A6: One attempt per request; the adapter does not retry on its own. A failure of the whole
 *   poll rejects with an `AdapterError` of the matching kind; core treats any other rejection
 *   as `transient`.
 * - A7: The adapter honours `PollContext.signal` and returns no batch after it is aborted.
 */
export interface Adapter {
  /** Stable id of this adapter instance; becomes `Batch.source`. */
  readonly id: string;
  /** Time between two polls in milliseconds, from `adapters.<source>.intervalMs`. */
  readonly intervalMs: number;
  /** Observes the source once (A1-A7). */
  poll(ctx: PollContext): Promise<Batch>;
}

/** A whole-poll failure (A6). `retryAt` is when the source allows the next attempt. */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly retryAt?: Date | undefined;

  constructor(
    kind: AdapterErrorKind,
    message: string,
    options: { retryAt?: Date | undefined; cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'AdapterError';
    this.kind = kind;
    this.retryAt = options.retryAt;
  }
}
