import { z } from 'zod';
import { COLUMN_IDS } from '../enums.ts';
import { taskKeyInputSchema } from '../ids.ts';
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
      .describe('Why the column is corrected, kept in the journal.'),
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
