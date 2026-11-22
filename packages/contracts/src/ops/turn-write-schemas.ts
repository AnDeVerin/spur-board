// The inputs and outputs of the writes that take, close and wait on a turn: `inbox.ack`,
// `task.submit`, `task.return` and `task.wait`. The catalog and the browser operations share
// these objects (`ops.test.ts`).
import { z } from 'zod';
import { SUBMISSION_BASES } from '../enums.ts';
import { commitShaSchema } from '../facts.ts';
import {
  blockIdSchema,
  commentIdSchema,
  ringIdSchema,
  taskKeyInputSchema,
  turnIdSchema,
} from '../ids.ts';
import { blockViewSchema, taskViewSchema } from './schemas.ts';
import { turnWaitSchema } from './turn-schemas.ts';

/** Most entries one `inbox.ack` call acknowledges. */
const ACK_ENTRIES_MAX = 100;
export const inboxAckInputSchema = z.strictObject({
  entries: z
    .array(
      z.union([
        z.strictObject({
          id: commentIdSchema,
          revision: z.int().positive().describe('Revision the caller read.'),
        }),
        z.strictObject({ id: blockIdSchema }),
        z.strictObject({ id: turnIdSchema }),
        z.strictObject({ id: ringIdSchema }),
      ]),
    )
    .min(1)
    .max(ACK_ENTRIES_MAX)
    .describe('Comment revisions, blocks, turns and ring IDs to acknowledge.'),
});
export const inboxAckOutputSchema = z.strictObject({
  acked: z
    .array(z.union([commentIdSchema, blockIdSchema, turnIdSchema, ringIdSchema]))
    .describe('Entries now acknowledged.'),
  alreadyHandled: z
    .array(z.union([commentIdSchema, blockIdSchema, turnIdSchema, ringIdSchema]))
    .optional()
    .describe('Entries that were already handled; nothing new was acknowledged for them.'),
});

export const taskSubmitInputSchema = z.strictObject({
  turn: z
    .union([turnIdSchema, taskKeyInputSchema])
    .describe(
      'Turn ID you took (T4); while the project dispatcher is in shadow mode, the task key instead.',
    ),
  sha: commitShaSchema
    .max(64)
    .describe('Full commit SHA at the head of the pull request, lowercase.'),
  basis: z
    .enum(SUBMISSION_BASES)
    .optional()
    .describe(
      'Testing provenance: tested (default), carried from a tested origin on this task, or skipped with a reason.',
    ),
  from: commitShaSchema
    .max(64)
    .optional()
    .describe('Full lowercase source SHA on this task; required only for carried.'),
  reason: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Literal nonblank explanation, up to 2000 UTF-16 units; required for carried and skipped.',
    ),
});
export const taskSubmitOutputSchema = z.strictObject({
  task: taskViewSchema,
  turn: turnIdSchema
    .nullable()
    .describe('The closed turn; null for a submit by task key in shadow mode.'),
  sha: commitShaSchema.describe('The submitted commit SHA.'),
  // The default reads a result stored before pending submits existed, when every submit
  // confirmed its head; a new call always sets status, so the output schema keeps it required.
  status: z
    .enum(['confirmed', 'pending'])
    .default('confirmed')
    .describe(
      'confirmed: the board saw the PR head at sha. pending: accepted, pending confirmation - the board confirms the head on its next polls and hands the turn back with the reason if it cannot; do not resubmit or raise a block.',
    ),
});

export const taskReturnInputSchema = z.strictObject({
  turn: turnIdSchema,
  reason: z
    .string()
    .min(1)
    .max(20_000)
    .describe('What the worker must change, sent to the worker as a code block.'),
  findings: z
    .int()
    .min(0)
    .optional()
    .describe("Number of review findings the return sends; shown on the task's status row."),
});
export const taskReturnOutputSchema = z.strictObject({
  task: taskViewSchema,
  block: blockViewSchema,
});

/** Longest one wait may last, in minutes. */
const WAIT_MINUTES_MAX = 120;
export const taskWaitInputSchema = z.strictObject({
  turn: turnIdSchema.describe(
    'Turn ID you took (T4); with end, the turn whose wait you end as the operator.',
  ),
  for: z
    .int()
    .min(1)
    .max(WAIT_MINUTES_MAX)
    .optional()
    .describe(
      'Whole minutes to wait, 1 to 120; the turn total cap may shorten it. Required unless end.',
    ),
  reason: z
    .string()
    .min(1)
    .max(200)
    .regex(/\S/)
    .optional()
    .describe(
      'What you wait for, up to 200 characters; the wake ring repeats it. Required unless end. Wait only on a condition you cannot change and must re-check: a busy test stand, no free slot, high machine load, a deploy, an outside service. Not on your own work (review fixes, tests, checks, rebasing): work holding the turn, so a stall reaches the operator; a wait hides it.',
    ),
  end: z
    .boolean()
    .optional()
    .describe(
      "Operator only: end the turn's active wait now instead of starting one; pass no for or reason.",
    ),
});
export const taskWaitOutputSchema = z.strictObject({
  turn: turnIdSchema.describe('The waiting turn.'),
  wait: turnWaitSchema.optional().describe('The wait just started; absent after end.'),
  waits: z.int().min(1).describe('Waits the turn has started, this one or the ended one included.'),
});

/**
 * The four writes as `browserOperations` entries (`../browser.ts`), kept beside their schemas: the
 * web Turn section calls them, and the catalog shares the same schema objects.
 */
export const turnWriteOperations = {
  'inbox.ack': {
    id: 'inbox.ack',
    kind: 'mutation',
    input: inboxAckInputSchema,
    output: inboxAckOutputSchema,
  },
  'task.submit': {
    id: 'task.submit',
    kind: 'mutation',
    input: taskSubmitInputSchema,
    output: taskSubmitOutputSchema,
  },
  'task.return': {
    id: 'task.return',
    kind: 'mutation',
    input: taskReturnInputSchema,
    output: taskReturnOutputSchema,
  },
  'task.wait': {
    id: 'task.wait',
    kind: 'mutation',
    input: taskWaitInputSchema,
    output: taskWaitOutputSchema,
  },
} as const;
