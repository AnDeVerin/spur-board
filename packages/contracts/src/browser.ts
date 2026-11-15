/** Browser-safe operation schemas; never import the operation catalog here. */
import { z } from 'zod';
import {
  ADDRESSEE_SOURCES,
  COLUMN_BINDING_SOURCES,
  COLUMN_IDS,
  OPERATOR_BINDING_SOURCES,
} from './enums.ts';
import { blockIdSchema, taskKeyInputSchema } from './ids.ts';
import { SPACE_IDS } from './gateway/schemas.ts';
import { sourceViewSchema } from './ops/source-view-schema.ts';
import {
  blockViewSchema,
  commentSchema,
  statusItemSchema,
  statusTaskSchema,
  statusUnlinkedPrSchema,
  statusUnlinkedSessionSchema,
} from './ops/schemas.ts';
import { errorDetailSchema } from './errors.ts';
export { successEnvelopeSchema } from './errors.ts';
export const problemSchema = errorDetailSchema.extend({
  type: z.url(),
  title: z.string(),
  status: z.int().min(400).max(599),
});
const TEXT_MAX = 20_000;
const text = (what: string, max: number) => z.string().min(1).max(max).describe(what);
const project = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Project to limit the answer to; absent means every project the caller may see.');
/** The effective column orchestrators and operators of the requested projects (`configBindings`). */
const statusBindingsSchema = z
  .strictObject({
    columns: z
      .array(
        z
          .strictObject({
            project: z.string().min(1).describe('Board project.'),
            column: z.enum(COLUMN_IDS).describe('Enabled column with an orchestrator.'),
            orchestrator: z
              .string()
              .min(1)
              .describe('Spur project, or operator, that takes the column turns.'),
            source: z
              .enum(COLUMN_BINDING_SOURCES)
              .describe(
                'project: set in projects[].columns; board-wide: filled from top-level spurProjects.',
              ),
          })
          .describe('One column binding.'),
      )
      .describe('Column orchestrators of each requested project; columns left at none are absent.'),
    operators: z
      .array(
        z
          .strictObject({
            project: z.string().min(1).describe('Board project.'),
            operator: z.string().min(1).describe('Spur project acting as operator there.'),
            source: z
              .enum(OPERATOR_BINDING_SOURCES)
              .describe(
                "project: its own spurProjects; board-wide: top-level spurProjects; other-project: another project's operator, without a board-wide one.",
              ),
          })
          .describe('One operator binding.'),
      )
      .describe('Operator Spur projects of each requested project.'),
    defaultAddressee: z
      .strictObject({
        spurProject: z.string().min(1).describe('Spur project the message goes to.'),
        source: z
          .enum(ADDRESSEE_SOURCES)
          .describe(
            'config: slack.defaultAddressee; board-wide: the board-wide operator; project: the operator of the first board project, in config order, that lists one.',
          ),
      })
      .nullable()
      .describe(
        'Who an orchestrators-channel message without a known @shortName goes to; null when it is left unhandled or answered with the prefixes.',
      ),
  })
  .describe('Effective column orchestrators, operators and default Slack addressee.');

export const statusInputSchema = z.strictObject({
  project,
  detail: z
    .boolean()
    .optional()
    .describe('Include full ticket, pull request and session facts; absent means compact rows.'),
});
export const statusOutputSchema = z.strictObject({
  items: z.array(statusItemSchema).describe('Actionable items in priority order.'),
  warmingUp: z.boolean().describe('Whether required sources still need a complete poll.'),
  spurUnavailable: z
    .string()
    .nullable()
    .describe('One combined Spur availability line, or null when available.'),
  hostLoad: z.string().nullable().describe('Host-load episode line, or null when absent.'),
  transport: z
    .array(
      z
        .strictObject({
          gateway: z.string().min(1).describe('Chat gateway kind.'),
          state: z
            .enum(['up', 'down'])
            .describe('down while delivery to any space of the gateway is suspended.'),
          since: z.iso
            .datetime()
            .nullable()
            .describe('When the earliest outage started, ISO 8601 UTC, or null when up.'),
          reason: z.string().nullable().describe('Reason of the earliest outage, or null when up.'),
          spaces: z.array(z.enum(SPACE_IDS)).describe('Spaces whose delivery is suspended.'),
        })
        .describe('Transport health of one gateway.'),
    )
    .describe('Transport health of each chat gateway.'),
  sources: z.array(sourceViewSchema).describe('Freshness and availability of each source.'),
  tasks: z
    .array(statusTaskSchema)
    .describe('Tasks with state, turn, PR summary arrays and navigation; full facts with detail.'),
  projectBlocks: z
    .array(
      z
        .strictObject({
          project: z.string().min(1).describe('Board project.'),
          openBlocks: z.int().min(0).describe('Open project-level blocks, without a task.'),
        })
        .describe('Open project-level blocks of one project.'),
    )
    .describe('Open project-level blocks of each requested project.'),
  unlinkedPrs: z
    .array(statusUnlinkedPrSchema)
    .describe(
      'Observed pull requests without a task link; merged or closed ones with no change for over 7 days are left out.',
    ),
  unlinkedSessions: z
    .array(statusUnlinkedSessionSchema)
    .describe(
      "Observed sessions without a task link; ones ended, or gone from Spur's session list, for over 7 days are left out.",
    ),
  hiddenUnlinkedPrs: z
    .int()
    .min(0)
    .describe(
      'Unlinked pull requests not listed: merged or closed, with no change for over 7 days. Counted within the requested projects; detail does not list them.',
    ),
  hiddenUnlinkedSessions: z
    .int()
    .min(0)
    .describe(
      "Unlinked sessions not listed: ended, or gone from Spur's session list, for over 7 days. Counted within the requested projects; detail does not list them.",
    ),
  bindings: statusBindingsSchema,
});

export const commentAddInputSchema = z.strictObject({
  task: taskKeyInputSchema,
  block: blockIdSchema.optional().describe('Block conversation to join, if any.'),
  text: text('Comment text.', TEXT_MAX),
});
export const commentAddOutputSchema = z.strictObject({ comment: commentSchema });

export const blockAnswerInputSchema = z.strictObject({
  block: blockIdSchema,
  text: text('The answer.', TEXT_MAX),
  note: z
    .string()
    .min(1)
    .max(TEXT_MAX)
    .optional()
    .describe(
      'Your own comment on the answer, kept apart from it: stored as a second comment and shown on the curator feed line.',
    ),
});
export const blockAnswerOutputSchema = z.strictObject({
  block: blockViewSchema,
  comment: commentSchema,
});

export const browserOperations = {
  'status.get': {
    id: 'status.get',
    kind: 'query',
    input: statusInputSchema,
    output: statusOutputSchema,
  },
  'comment.add': {
    id: 'comment.add',
    kind: 'mutation',
    input: commentAddInputSchema,
    output: commentAddOutputSchema,
  },
  'block.answer': {
    id: 'block.answer',
    kind: 'mutation',
    input: blockAnswerInputSchema,
    output: blockAnswerOutputSchema,
  },
} as const;
