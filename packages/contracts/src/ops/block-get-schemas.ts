/** Browser-safe `block.get` schemas: one block, a project-level block too, with its replies. */
import { z } from 'zod';
import { blockIdSchema } from '../ids.ts';
import { commentSchema, taskBlockViewSchema } from './schemas.ts';

export const blockGetInputSchema = z.strictObject({ block: blockIdSchema });
export const blockGetOutputSchema = z.strictObject({
  block: taskBlockViewSchema.describe(
    'The block, on a task or project-level, with the channel that closed it.',
  ),
  project: z
    .string()
    .min(1)
    .describe("Board project of the block: the block's own project, or its task's."),
  comments: z
    .array(commentSchema)
    .describe(
      'Replies on the block, oldest first; its opening comment, by its author with its reason as text, is left out.',
    ),
});

/** The `block.get` entry of `browserOperations`, kept here so `browser.ts` stays small. */
export const blockReadOperations = {
  'block.get': {
    id: 'block.get',
    kind: 'query',
    input: blockGetInputSchema,
    output: blockGetOutputSchema,
  },
} as const;
