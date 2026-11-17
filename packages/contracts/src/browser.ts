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
import { configViewSchema } from './ops/config-view-schema.ts';
import { inboxEntrySchema, inboxHandledSchema } from './ops/inbox-schemas.ts';
import { sourceViewSchema } from './ops/source-view-schema.ts';
import {
  blockViewSchema,
  commentSchema,
  linkViewSchema,
  statusItemSchema,
  statusSessionFactsSchema,
  statusTaskSchema,
  statusUnlinkedPrSchema,
  statusUnlinkedSessionSchema,
  taskBlockViewSchema,
  taskViewSchema,
  taskWhySchema,
} from './ops/schemas.ts';
import { taskTurnSchema } from './ops/turn-schemas.ts';
import { errorDetailSchema } from './errors.ts';
export { successEnvelopeSchema } from './errors.ts';
export { JIRA_PROJECT_KEY, REF_NUMBER } from './ids.ts';
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

const hostUsageSchema = (total: string, available: string, used: string) =>
  z
    .strictObject({
      totalBytes: z.number().nonnegative().describe(total),
      availableBytes: z.number().nonnegative().describe(available),
      usedPercent: z.number().min(0).max(100).describe(used),
    })
    .nullable();

const hostSchema = z
  .strictObject({
    sampledAt: z.iso
      .datetime()
      .describe(
        'When the daemon took this sample, ISO 8601 UTC. It samples every 30 seconds; reads never take a new sample, so an old value means sampling is stuck.',
      ),
    cpuPercent: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Host CPU busy percent over all cores since the previous sample, one decimal; null on the first sample or when unreadable.',
      ),
    memory: hostUsageSchema(
      'Total host memory in bytes.',
      'Host memory available for new work without swapping, in bytes.',
      'Percent of host memory in use: total minus available, over total; one decimal.',
    ).describe('Host memory; null when unreadable.'),
    disk: hostUsageSchema(
      'Size of the volume in bytes, root-reserved blocks included.',
      'Free bytes an unprivileged user can still write, without root-reserved blocks.',
      'Percent of the volume in use, as df shows it: used over used plus available, without root-reserved blocks; one decimal.',
    ).describe('The volume holding the board data; null when unreadable.'),
  })
  .nullable()
  .describe(
    'Host CPU, memory and data-volume disk usage from the last sample of the daemon; null before the first sample.',
  );

const serviceSchema = z
  .strictObject({
    service: z
      .string()
      .min(1)
      .describe('daemon, github, jira, spur, or a chat gateway kind such as slack.'),
    state: z
      .enum(['healthy', 'degraded', 'failing'])
      .describe(
        'failing: a blind source or a gateway that is down; degraded: a source that never completed, is stale, warms up or waits for its rate budget, or a daemon with no completed board tick for over 120 seconds; else healthy. A source service takes its worst source.',
      ),
    since: z.iso
      .datetime()
      .nullable()
      .describe(
        'Healthy: since when the service has been usable in this daemon run. That is daemon.startedAt for the daemon, the latest healthySince of its sources for github, jira and spur, and for a gateway the end of its last recorded outage or daemon.startedAt, whichever is later. Failing gateway: when the outage started. Otherwise null.',
      ),
    lastGoodAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'Last sign of work: the last completed board tick for the daemon, the oldest latest observation of its sources for github, jira and spur (null when one has none); null for a gateway.',
      ),
    reason: z
      .string()
      .nullable()
      .describe(
        'Why the service is not healthy, from its first worst source for github, jira and spur; null when healthy.',
      ),
  })
  .describe('Health of one service.');

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
  host: hostSchema,
  services: z
    .array(serviceSchema)
    .describe(
      'One health row per service: daemon, each chat gateway, then github, spur and jira when sources lists one. Daemon and gateway rows are board-wide; source services roll up only the sources listed.',
    ),
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
  daemon: z
    .strictObject({
      version: z.string().min(1).describe('Product version of the running daemon.'),
      startedAt: z.iso.datetime().describe('When the daemon started, ISO 8601 UTC.'),
      lastDispatchAt: z.iso
        .datetime()
        .nullable()
        .describe(
          'When the last completed board tick (dispatch pass) ended, ISO 8601 UTC; null until the first tick after start.',
        ),
    })
    .describe('The running daemon: version, start time and last completed tick.'),
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

export const configGetInputSchema = z.strictObject({ project });

export const inboxOperatorInputSchema = z.strictObject({});
export const inboxOperatorOutputSchema = z.strictObject({
  items: z
    .array(inboxEntrySchema)
    .describe(
      'Open operator items, blocks addressed to the operator and operator turns, newest first; a block or turn is listed once, not with its items.',
    ),
  handled: z
    .array(inboxHandledSchema)
    .describe('At most 20 entries handled in the last 24 hours, newest first.'),
});

export const taskGetInputSchema = z.strictObject({
  task: taskKeyInputSchema,
  refresh: z
    .boolean()
    .optional()
    .describe(
      'Read every linked pull request from GitHub before showing the task; unavailable reads fail visibly.',
    ),
  detail: z
    .boolean()
    .optional()
    .describe('Also list the last 5 closed turns, newest first; absent means none.'),
  why: z
    .boolean()
    .optional()
    .describe(
      'Explain why the task is in its column: gates, holds, the open turn and the last moves; absent means no explanation.',
    ),
});
export const taskGetOutputSchema = z.strictObject({
  task: taskViewSchema,
  turn: taskTurnSchema.nullable().describe("The task's unclosed turn; null when none is open."),
  turns: z
    .array(taskTurnSchema)
    .optional()
    .describe('Present only with detail: the last 5 closed turns, newest first.'),
  links: z.array(linkViewSchema).describe('Effective pull request, session, and ticket links.'),
  sessions: z
    .array(statusSessionFactsSchema)
    .optional()
    .describe('Current facts of effective linked sessions.'),
  blocks: z.array(taskBlockViewSchema).describe('Blocks on the task, open and unblocked.'),
  comments: z.array(commentSchema).describe('Comments on the task, oldest first.'),
  why: taskWhySchema.optional().describe('Present only with why.'),
});

export const browserOperations = {
  'config.get': {
    id: 'config.get',
    kind: 'query',
    input: configGetInputSchema,
    output: configViewSchema,
  },
  'inbox.operator': {
    id: 'inbox.operator',
    kind: 'query',
    input: inboxOperatorInputSchema,
    output: inboxOperatorOutputSchema,
  },
  'status.get': {
    id: 'status.get',
    kind: 'query',
    input: statusInputSchema,
    output: statusOutputSchema,
  },
  'task.get': {
    id: 'task.get',
    kind: 'query',
    input: taskGetInputSchema,
    output: taskGetOutputSchema,
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
