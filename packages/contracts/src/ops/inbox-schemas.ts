import { z } from 'zod';
import { COLUMN_IDS, INBOX_KINDS, INBOX_SEVERITIES, VIAS } from '../enums.ts';
import { blockIdSchema, itemIdSchema, taskKeySchema, turnIdSchema } from '../ids.ts';

// The entries of `inbox.operator`.

/** What a `no-session:` board observation is about, read from the store when the inbox is read. */
export const inboxNoSessionSchema = z
  .strictObject({
    project: z.string().min(1).describe('Board project of the column.'),
    column: z.enum(COLUMN_IDS).describe('Column whose orchestrator turns have no session to ring.'),
    spurProject: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Spur project of the column orchestrator the observation recorded, else the current binding; absent when neither is known.',
      ),
    oldestTask: taskKeySchema.describe('Task of the oldest waiting turn when the item was raised.'),
    since: z.iso
      .datetime()
      .describe('Since when the column has had no live session, ISO 8601 UTC.'),
    waiting: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Open entries only: untaken orchestrator turns waiting in the column now.'),
    oldestTurn: turnIdSchema
      .optional()
      .describe(
        'The oldest waiting turn the observation recorded; on an open entry whose record cannot be read, the waiting turn of its task.',
      ),
    oldestAt: z.iso
      .datetime()
      .optional()
      .describe(
        'Open entries only: when that turn rang, ISO 8601 UTC, while it still waits untaken.',
      ),
  })
  .describe(
    'On a board_observation no-session item only: the column with no live session to ring; absent when the board cannot read it.',
  );

/** One entry of the operator inbox: an operator item, a block addressed to the operator or a turn. */
export const inboxEntrySchema = z
  .strictObject({
    id: z
      .union([itemIdSchema, blockIdSchema, turnIdSchema])
      .describe('Item (I), block (B) or turn (T) ID; stable while the entry exists.'),
    project: z
      .string()
      .min(1)
      .describe('Board project the entry belongs to; _board for a board-wide one.'),
    kind: z
      .enum(INBOX_KINDS)
      .describe(
        'block for a block addressed to the operator, turn for a turn, else the item kind.',
      ),
    severity: z
      .enum(INBOX_SEVERITIES)
      .describe(
        'failure: the board or a connection broke; attention: a decision, answer or other operator action is wanted.',
      ),
    text: z.string().describe('What needs the operator, in one line.'),
    url: z
      .url({ protocol: /^https?$/ })
      // The URL protocol option is runtime-only; retain it in advertised JSON Schema too.
      .and(z.string().regex(/^[hH][tT][tT][pP][sS]?:\/\//))
      .optional()
      .describe(
        'Meaningful external destination for this entry, when known; HTTP(S) only. Task navigation takes precedence in the web inbox.',
      ),
    action: z
      .string()
      .min(1)
      .optional()
      .describe(
        'What the operator does about an item entry; the text ends with it. Absent on block and turn entries.',
      ),
    at: z.iso.datetime().describe('When the entry was raised or opened, ISO 8601 UTC.'),
    task: taskKeySchema.nullable().describe('Task the entry is about; null when it has none.'),
    column: z.enum(COLUMN_IDS).optional().describe('Column of a turn; absent on other entries.'),
    answeredVia: z
      .enum(VIAS)
      .nullable()
      .optional()
      .describe(
        'On a block: web, slack, cli or mcp when the closing write arrived that way (cli and mcp as the board client reported it), else null; absent on other entries.',
      ),
    noSession: inboxNoSessionSchema.optional(),
  })
  .describe('One entry of the operator inbox.');

/** An operator inbox entry cleared, answered or closed in the last 24 hours. */
export const inboxHandledSchema = inboxEntrySchema
  .extend({
    handledAt: z.iso.datetime().describe('When it was cleared, answered or closed, ISO 8601 UTC.'),
  })
  .describe('An operator inbox entry handled in the last 24 hours.');
