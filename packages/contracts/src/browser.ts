import { taskMoveInputSchema, taskMoveOutputSchema } from './ops/move-schemas.ts';
import { turnWriteOperations } from './ops/turn-write-schemas.ts';
/** Browser-safe operation schemas; never import the operation catalog here. */
import { z } from 'zod';
import {
  ADDRESSEE_SOURCES,
  COLUMN_BINDING_SOURCES,
  COLUMN_GROUPS,
  COLUMN_IDS,
  OPERATOR_BINDING_SOURCES,
  VIAS,
} from './enums.ts';
export { COLUMNS } from './enums.ts';
import { EVENT_KINDS } from './events.ts';
import { actorIdSchema, blockIdSchema, itemIdSchema, taskKeyInputSchema } from './ids.ts';
import { SPACE_IDS } from './gateway/schemas.ts';
import { configViewSchema } from './ops/config-view-schema.ts';
import { columnsDescribeOutputSchema } from './ops/columns-schema.ts';
export { columnsDescribeOutputSchema } from './ops/columns-schema.ts';
import { inboxEntrySchema, inboxHandledSchema } from './ops/inbox-schemas.ts';
import { sourceViewSchema } from './ops/source-view-schema.ts';
import {
  blockViewSchema,
  commentSchema,
  itemViewSchema,
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
import { taskTurnSchema, latestSubmissionSchema } from './ops/turn-schemas.ts';
import { errorDetailSchema } from './errors.ts';
export { successEnvelopeSchema } from './errors.ts';
export { JIRA_PROJECT_KEY, REF_NUMBER } from './ids.ts';
export { HOST_USAGE_LEVELS, hostUsageLevel, type HostUsageLevel } from './host-usage.ts';
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
              .describe('project: its own spurProjects; board-wide: top-level spurProjects.'),
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
  z.strictObject({
    totalBytes: z.number().nonnegative().describe(total),
    availableBytes: z.number().nonnegative().describe(available),
    usedPercent: z.number().min(0).max(100).describe(used),
  });

const hostVolumeSchema = z.strictObject({
  mount: z
    .string()
    .min(1)
    .describe(
      'Mount point of the volume: the topmost directory on the same device. A bind mount of the same device shows its parent mount.',
    ),
  ...hostUsageSchema(
    'Size of the volume in bytes, root-reserved blocks included.',
    'Free bytes an unprivileged user can still write, without root-reserved blocks.',
    'Percent of the volume in use, as df shows it: used over used plus available, without root-reserved blocks; one decimal.',
  ).shape,
});

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
    )
      .nullable()
      .describe('Host memory; null when unreadable.'),
    disk: hostVolumeSchema
      .nullable()
      .describe(
        'The volume closest to running out: the first of volumes, with the least free bytes; null when no volume could be read.',
      ),
    volumes: z
      .array(hostVolumeSchema)
      .describe(
        'Each distinct volume among /, the board data directory and the temp directory, least free bytes first. A volume that cannot be read is left out.',
      ),
  })
  .nullable()
  .describe(
    'Host CPU, memory and disk usage from the last sample of the daemon; null before the first sample.',
  );

const serviceSchema = z
  .strictObject({
    service: z
      .string()
      .min(1)
      .describe(
        'daemon, github, github-project, jira, spur, or a chat gateway kind such as slack.',
      ),
    state: z
      .enum(['healthy', 'degraded', 'failing'])
      .describe(
        'failing: a blind source, a github-project source whose last poll failed, or a gateway that is down; degraded: a source that never completed, is stale, warms up or waits for its rate budget, or a daemon with no completed board tick for over 120 seconds; else healthy. A source service takes its worst source.',
      ),
    since: z.iso
      .datetime()
      .nullable()
      .describe(
        'Healthy: since when the service has been usable in this daemon run. That is daemon.startedAt for the daemon, the latest healthySince of its sources for github, github-project, jira and spur, and for a gateway the end of its last recorded outage or daemon.startedAt, whichever is later. Failing gateway: when the outage started. Otherwise null.',
      ),
    lastGoodAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'Last sign of work: the last completed board tick for the daemon, the oldest latest observation of its sources for github, github-project, jira and spur (null when one has none); null for a gateway.',
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
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Project to limit the answer to, except sources and services, which always cover every project the caller may see; absent means every project the caller may see.',
    ),
  detail: z
    .boolean()
    .optional()
    .describe('Include full ticket, pull request and session facts; absent means compact rows.'),
});
export const statusOutputSchema = z.strictObject({
  items: z.array(statusItemSchema).describe('Actionable items in priority order.'),
  warmingUp: z
    .boolean()
    .describe('Whether a source of the requested projects or spur still needs a complete poll.'),
  spurUnavailable: z
    .string()
    .nullable()
    .describe('One combined Spur availability line, or null when available.'),
  hostLoad: z.string().nullable().describe('Host-load episode line, or null when absent.'),
  host: hostSchema,
  services: z
    .array(serviceSchema)
    .describe(
      'One health row per service: daemon, each chat gateway, then github, github-project (only when a column mirrors a GitHub Project), spur and jira when sources lists one. Daemon and gateway rows are board-wide; source services roll up the sources listed, which cover every project the caller may see whatever project says.',
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
  sources: z
    .array(sourceViewSchema)
    .describe(
      'Freshness and availability of each source of every project the caller may see, whatever project says, with spur first.',
    ),
  tasks: z
    .array(statusTaskSchema)
    .describe('Tasks with state, turn, PR summary arrays and navigation; full facts with detail.'),
  columnGroups: z
    .array(
      z
        .strictObject({
          id: z.enum(COLUMN_GROUPS).describe('Column group.'),
          columns: z
            .array(z.enum(COLUMN_IDS))
            .describe('Built-in columns of the group in canonical order, enabled or not.'),
        })
        .describe('One column group.'),
    )
    .describe(
      'Column groups, the same for every project. The dispatcher never moves a task between columns of one group; once work starts it moves the task to the first enabled column right of the group.',
    ),
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

export const blockFollowupInputSchema = z.strictObject({
  block: blockIdSchema,
  text: text('The follow-up.', TEXT_MAX),
});

export const itemInputSchema = z.strictObject({ item: itemIdSchema });
export const itemOutputSchema = z.strictObject({ item: itemViewSchema });

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
  submission: latestSubmissionSchema,
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
  comments: z
    .array(commentSchema)
    .describe(
      "Comments on the task, oldest first; a block's opening comment, by its author with its reason as text, is left out.",
    ),
  why: taskWhySchema.optional().describe('Present only with why.'),
});

export const taskHistoryInputSchema = z.strictObject({ task: taskKeyInputSchema });
const taskHistoryEventSchema = z
  .strictObject({
    at: z.iso.datetime().describe('When it happened, ISO 8601 UTC.'),
    kind: z.enum(EVENT_KINDS).describe('Journal event kind.'),
    actor: actorIdSchema,
    via: z
      .enum(VIAS)
      .optional()
      .describe(
        'Channel the write arrived through, whoever the actor: web or slack, or cli or mcp as the board client reported it; absent for scheduled and board writes and older clients.',
      ),
    summary: z.string().describe('What happened, in one line.'),
  })
  .describe('One journal event.');
export const taskHistoryOutputSchema = z.strictObject({
  task: taskViewSchema,
  events: z
    .array(taskHistoryEventSchema)
    .describe(
      'Journal events of the task, oldest first by time; facts events with nothing new to name, such as an update time alone, are left out.',
    ),
});
/** The browser's read of `task.history`: a kind or channel a newer daemon added still parses. */
const taskHistoryReadSchema = taskHistoryOutputSchema.extend({
  events: z.array(
    taskHistoryEventSchema.extend({
      kind: z.string().min(1),
      via: z.string().min(1).optional(),
    }),
  ),
});

/**
 * Operations the web shell calls. `input` and `output` are the catalog's own objects
 * (`ops.test.ts`). An optional `read` is the schema the browser parses an answer with instead of
 * `output`; it only widens values a newer daemon may add, so one unknown value never rejects the
 * whole answer.
 */
export const browserOperations = {
  'task.move': {
    id: 'task.move',
    kind: 'mutation',
    input: taskMoveInputSchema,
    output: taskMoveOutputSchema,
  },
  'columns.describe': {
    id: 'columns.describe',
    kind: 'query',
    input: configGetInputSchema,
    output: columnsDescribeOutputSchema,
  },
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
  'task.history': {
    id: 'task.history',
    kind: 'query',
    input: taskHistoryInputSchema,
    output: taskHistoryOutputSchema,
    read: taskHistoryReadSchema,
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
  'block.followup': {
    id: 'block.followup',
    kind: 'mutation',
    input: blockFollowupInputSchema,
    output: commentAddOutputSchema,
  },
  'item.close': {
    id: 'item.close',
    kind: 'mutation',
    input: itemInputSchema,
    output: itemOutputSchema,
  },
  ...turnWriteOperations,
} as const;
