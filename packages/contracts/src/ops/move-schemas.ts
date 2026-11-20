import { z } from 'zod';
import { COLUMN_IDS } from '../enums.ts';
import { taskKeyInputSchema, taskKeySchema } from '../ids.ts';
import { moveViewSchema, taskViewSchema } from './schemas.ts';

export const taskMoveInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('manual').describe('Place an idle task inside the Todo group.'),
    task: taskKeyInputSchema,
    column: z
      .enum(COLUMN_IDS)
      .describe('Enabled Todo-group destination; a new visit places the task at its end.'),
    reason: z
      .string()
      .min(1)
      .max(20_000)
      .regex(/\S/)
      .describe(
        'Literal reason for the move, kept exactly in the journal; must contain non-whitespace text.',
      ),
  }),
  z.strictObject({
    mode: z.literal('correct').describe('Correct a wrong column by hand.'),
    task: taskKeyInputSchema,
    column: z
      .enum(COLUMN_IDS)
      .exclude(['done'])
      .describe('Enabled column to put the task in; Done is reached only from the facts.'),
    reason: z
      .string()
      .min(1)
      .max(20_000)
      .describe('Literal reason for manual placement or correction, kept in the journal.'),
  }),
]);

export const taskMoveOutputSchema = z.strictObject({
  task: taskViewSchema,
  from: z
    .enum(COLUMN_IDS)
    .describe('Column the task left; correction uses the dispatcher position.'),
  to: z.enum(COLUMN_IDS).describe('Requested destination column.'),
  column: z
    .enum(COLUMN_IDS)
    .describe('Resulting position; correction uses the shadow position in shadow mode.'),
  settled: z
    .array(moveViewSchema)
    .describe('Dispatcher moves after a correction, oldest first; empty for manual placement.'),
});

const orderAnchor = taskKeyInputSchema.describe(
  'Another live task of the same column; the task goes directly before it in mode before, after it in mode after.',
);

export const taskOrderInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('before').describe('Place the task directly before the anchor task.'),
    task: taskKeyInputSchema,
    anchor: orderAnchor,
  }),
  z.strictObject({
    mode: z.literal('after').describe('Place the task directly after the anchor task.'),
    task: taskKeyInputSchema,
    anchor: orderAnchor,
  }),
  z.strictObject({
    mode: z.literal('top').describe('Place the task first in its column order.'),
    task: taskKeyInputSchema,
  }),
  z.strictObject({
    mode: z.literal('bottom').describe('Place the task last in its column order.'),
    task: taskKeyInputSchema,
  }),
]);

export const taskOrderOutputSchema = z.strictObject({
  task: taskViewSchema,
  position: z
    .int()
    .min(1)
    .describe('1-based place of the task in its column order after the call.'),
  previous: taskKeySchema
    .nullable()
    .describe('Task directly before it in the column order; null when it is first.'),
  next: taskKeySchema
    .nullable()
    .describe('Task directly after it in the column order; null when it is last.'),
});
