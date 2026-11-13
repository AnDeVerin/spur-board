import { z } from 'zod';
import { BLOCK_TYPES, COLUMN_IDS } from '../enums.ts';
import { EVENT_KINDS } from '../events.ts';
import {
  actorIdSchema,
  blockIdSchema,
  commentIdSchema,
  itemIdSchema,
  taskKeyInputSchema,
  taskKeySchema,
  turnIdSchema,
} from '../ids.ts';
import { commitShaSchema } from '../facts.ts';
import { defineOperation } from './define.ts';
import {
  SCHEMA_ROLES,
  blockViewSchema,
  commentSchema,
  itemViewSchema,
  linkViewSchema,
  moveViewSchema,
  schemaGetOutputSchema,
  sourceViewSchema,
  statusItemSchema,
  statusTaskSchema,
  statusUnlinkedPrSchema,
  statusUnlinkedSessionSchema,
  taskViewSchema,
  taskWhySchema,
  turnViewSchema,
} from './schemas.ts';
import { SPACE_IDS } from '../gateway/schemas.ts';

/** Longest free text an input takes: comments, questions, answers and reasons. */
const TEXT_MAX = 20_000;
/** Longest project, session or token name an input takes. */
const NAME_MAX = 256;
/** Names were limited only by the old 1 MiB request body before #242, so revoke must accept any of them. */
const LEGACY_TOKEN_NAME_MAX = 1_048_576;
/** Longest pull request URL or unblock reference an input takes. */
const REF_MAX = 2048;
/** Most entries one `inbox.ack` call acknowledges. */
const ACK_ENTRIES_MAX = 100;

const project = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .optional()
  .describe('Project to limit the answer to; absent means every project the caller may see.');
const text = (what: string, max: number) => z.string().min(1).max(max).describe(what);
const target = z.string().min(1).describe('Pull request, session, or ticket linked to the task.');
const linkInput = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('pr').describe('Link a pull request.'),
    task: taskKeyInputSchema,
    pr: z
      .url({ protocol: /^https?$/ })
      .max(REF_MAX)
      .describe('Pull request URL.'),
    reason: text('Why this link is being changed.', TEXT_MAX),
  }),
  z.strictObject({
    mode: z.literal('session').describe('Link a spur session.'),
    task: taskKeyInputSchema,
    session: text('Spur session ID.', NAME_MAX),
    reason: text('Why this link is being changed.', TEXT_MAX),
  }),
  z.strictObject({
    mode: z.literal('ticket').describe('Link an additional tracker ticket.'),
    task: taskKeyInputSchema,
    ticket: taskKeyInputSchema,
    reason: text('Why this link is being changed.', TEXT_MAX),
  }),
]);
const linkModes = [
  { mode: 'pr', flag: '--pr', value: 'pr' },
  { mode: 'session', flag: '--session', value: 'session' },
  { mode: 'ticket', flag: '--ticket', value: 'ticket' },
] as const;

const at = '2026-01-05T09:30:00.000Z';
const task = {
  key: 'PROJ-123',
  project: 'web',
  column: 'dev',
  membership: 'active',
} as const;
const question = {
  id: 'B12',
  task: 'PROJ-123',
  type: 'needs_input',
  state: 'open',
  author: 'agent:web/web-7',
  addressee: 'operator',
  reason: 'Which API version should the client target?',
  at,
  outcome: null,
  outcomeReason: null,
  unblockedBy: null,
  unblockedAt: null,
} as const;
const codeBlock = {
  ...question,
  id: 'B13',
  type: 'code',
  author: 'agent:web/web-8',
  addressee: 'worker',
  reason: 'Tests fail on the main branch.',
} as const;
const comment = {
  id: 'C3',
  task: 'PROJ-123',
  block: 'B12',
  author: 'operator',
  at,
  text: 'Target v2.',
  revision: 1,
  ackedRevision: null,
  untrusted: true,
} as const;
const reviewTurn = {
  id: 'T4',
  task: 'PROJ-123',
  column: 'review',
  addressee: 'orchestrator:review',
  reason: 'The pull request is ready for review.',
  head: '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4',
  at,
  taken: null,
} as const;
const handedReview = {
  repo: 'acme/web',
  number: 42,
  kind: 'review',
  id: 'PRR_kwDOA1',
  postedAt: at,
} as const;
const submittedSha = '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4';
const item = { id: 'I7', task: 'PROJ-123', at, summary: 'Deploy of PROJ-123 failed.' } as const;

type GateView = z.input<typeof taskWhySchema>['gates'][number];
type ConditionView = GateView['conditions'][number];
const met = (condition: ConditionView['condition']): ConditionView => ({
  condition,
  state: 'met',
  reason: null,
});
const failed = (
  condition: ConditionView['condition'],
  reason: NonNullable<ConditionView['reason']>,
): ConditionView => ({ condition, state: 'failed', reason });
/**
 * The gates of a task in Review on a project with To Do, Dev, Review and Done enabled: Dev passes,
 * Review waits for its review on head.
 */
const reviewGates: GateView[] = [
  { column: 'todo', enabled: true, ok: true, blockedIn: null, conditions: [] },
  { column: 'ready-for-dev', enabled: false, ok: true, blockedIn: null, conditions: [] },
  {
    column: 'dev',
    enabled: true,
    ok: true,
    blockedIn: null,
    conditions: [
      met('pr_open'),
      met('not_draft'),
      met('checks_green'),
      met('no_conflict'),
      met('external_comments_handled'),
      met('comment_history_read'),
      met('submit_on_head'),
    ],
  },
  {
    column: 'review',
    enabled: true,
    ok: false,
    blockedIn: 'review',
    conditions: [failed('review_on_head', 'no_review_on_head')],
  },
  {
    column: 'product-review',
    enabled: false,
    ok: false,
    blockedIn: 'review',
    conditions: [failed('review_on_head', 'no_review_on_head')],
  },
  {
    column: 'external-review',
    enabled: false,
    ok: false,
    blockedIn: 'review',
    conditions: [failed('approved', 'not_approved')],
  },
  {
    column: 'qa',
    enabled: false,
    ok: false,
    blockedIn: 'review',
    conditions: [failed('submit_on_head', 'no_submit_on_head')],
  },
  {
    column: 'ready-to-merge',
    enabled: false,
    ok: false,
    blockedIn: 'review',
    conditions: [failed('merged', 'not_merged')],
  },
  { column: 'done', enabled: true, ok: true, blockedIn: 'review', conditions: [] },
];

const taskOutput = z.strictObject({ task: taskViewSchema });
const blockOutput = z.strictObject({ block: blockViewSchema });
const itemOutput = z.strictObject({ item: itemViewSchema });
const linkOutput = z.strictObject({ task: taskKeySchema, target });

const operatorOrProjectAgent = [{ grant: 'operator' }, { grant: 'project-agent' }] as const;
const operatorOnly = [{ grant: 'operator' }] as const;
const tokenStatus = z
  .enum(['pending', 'approved', 'denied', 'expired', 'revoked'])
  .describe('Current token state.');
const tokenName = z.string().min(1).describe('Unique name of the operator token.');

/** The M1 operations. CLI, MCP and the daemon route are generated from this list. */
export const OPERATIONS = [
  defineOperation({
    id: 'status.get',
    kind: 'query',
    description:
      'List actionable items, source freshness and compact tasks; detail adds full facts and links.',
    mcp: {
      whenToUse:
        'Get a board overview; pass detail for full ticket, pull request and session facts.',
      whenNotToUse: 'Use task_get for one task.',
    },
    input: z.strictObject({
      project,
      detail: z
        .boolean()
        .optional()
        .describe(
          'Include full ticket, pull request and session facts and links; absent means compact rows.',
        ),
    }),
    output: z.strictObject({
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
              reason: z
                .string()
                .nullable()
                .describe('Reason of the earliest outage, or null when up.'),
              spaces: z.array(z.enum(SPACE_IDS)).describe('Spaces whose delivery is suspended.'),
            })
            .describe('Transport health of one gateway.'),
        )
        .describe('Transport health of each chat gateway.'),
      sources: z.array(sourceViewSchema).describe('Freshness and availability of each source.'),
      tasks: z
        .array(statusTaskSchema)
        .describe('Tasks on the board with state and counts; facts and links with detail.'),
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
    }),
    grants: operatorOrProjectAgent,
    errors: ['not_found'],
    cli: { command: 'status', args: [] },
    slack: { kind: 'slash-command', usage: '/board status' },
    examples: [
      {
        summary: 'Show the board',
        input: {},
        output: {
          items: [],
          warmingUp: true,
          spurUnavailable: null,
          hostLoad: null,
          transport: [],
          sources: [],
          tasks: [
            {
              ...task,
              state: 'ticket not observed',
              prCount: 0,
              sessionCount: 0,
              openBlocks: 0,
            },
          ],
          unlinkedPrs: [],
          unlinkedSessions: [],
          hiddenUnlinkedPrs: 0,
          hiddenUnlinkedSessions: 0,
        },
      },
      {
        summary: 'Show the board with full facts and links',
        input: { detail: true },
        output: {
          items: [],
          warmingUp: false,
          spurUnavailable: null,
          hostLoad: null,
          transport: [],
          sources: [],
          tasks: [
            {
              ...task,
              state: 'ticket not observed',
              prCount: 0,
              sessionCount: 0,
              openBlocks: 0,
              ticket: null,
              prs: [],
              sessions: [],
              links: [],
            },
          ],
          unlinkedPrs: [],
          unlinkedSessions: [],
          hiddenUnlinkedPrs: 0,
          hiddenUnlinkedSessions: 0,
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.get',
    kind: 'query',
    description: 'Show a task with its links, blocks and comments.',
    mcp: { whenToUse: 'Inspect one task now.', whenNotToUse: 'Use task_history for past events.' },
    input: z.strictObject({
      task: taskKeyInputSchema,
      why: z
        .boolean()
        .optional()
        .describe(
          'Explain why the task is in its column: gates, holds, the open turn and the last moves; absent means no explanation.',
        ),
    }),
    output: z.strictObject({
      task: taskViewSchema,
      links: z.array(linkViewSchema).describe('Effective pull request, session, and ticket links.'),
      blocks: z.array(blockViewSchema).describe('Blocks on the task, open and unblocked.'),
      comments: z.array(commentSchema).describe('Comments on the task, oldest first.'),
      why: taskWhySchema.optional().describe('Present only with why.'),
    }),
    grants: operatorOrProjectAgent,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'task', args: ['task'] },
    slack: { kind: 'slash-command', usage: '/board task <KEY> [why]' },
    examples: [
      {
        summary: 'Show one task',
        input: { task: 'PROJ-123' },
        output: { task, links: [], blocks: [question], comments: [comment] },
      },
      {
        summary: 'Explain why a task waits in Review',
        input: { task: 'PROJ-123', why: true },
        output: {
          task: { ...task, column: 'review' },
          links: [],
          blocks: [],
          comments: [],
          why: {
            column: 'review',
            dispatcher: 'on',
            holds: [],
            gates: reviewGates,
            checksWaivedBy: null,
            turn: {
              ...reviewTurn,
              handed: [],
              taken: { by: 'agent:rev/rev-1', at },
            },
            moves: [
              {
                at,
                kind: 'task_moved',
                actor: 'system',
                from: 'dev',
                to: 'review',
                reason: 'gate_passed',
                gate: [],
                text: null,
              },
            ],
          },
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.history',
    kind: 'query',
    description: 'List what happened to a task, oldest first.',
    mcp: {
      whenToUse: 'Trace changes to one task.',
      whenNotToUse: 'Use task_get for current state.',
    },
    input: z.strictObject({ task: taskKeyInputSchema }),
    output: z.strictObject({
      task: taskViewSchema,
      events: z
        .array(
          z
            .strictObject({
              at: z.iso.datetime().describe('When it happened, ISO 8601 UTC.'),
              kind: z.enum(EVENT_KINDS).describe('Journal event kind.'),
              actor: actorIdSchema,
              summary: z.string().describe('What happened, in one line.'),
            })
            .describe('One journal event.'),
        )
        .describe('Journal events of the task, oldest first.'),
    }),
    grants: operatorOrProjectAgent,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'task history', args: ['task'] },
    slack: { kind: 'slash-command', usage: '/board task <KEY> history' },
    examples: [
      {
        summary: 'Show the history of a task',
        input: { task: 'acme/web#42' },
        output: {
          task: { ...task, key: 'acme/web#42' },
          events: [{ at, kind: 'task_added', actor: 'operator', summary: 'Added to Dev.' }],
        },
      },
    ],
  }),
  defineOperation({
    id: 'schema.get',
    kind: 'query',
    description: 'Describe the operations: inputs, outputs, errors and bindings.',
    mcp: {
      whenToUse: 'Discover operation contracts.',
      whenNotToUse: 'Use status_get for board data.',
    },
    input: z.strictObject({
      role: z
        .enum(SCHEMA_ROLES)
        .optional()
        .describe('Limit the answer to operations this role may call.'),
    }),
    output: schemaGetOutputSchema,
    grants: 'any',
    errors: [],
    cli: { command: 'schema', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Describe the operations a worker may call',
        input: { role: 'worker' },
        output: {
          version: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          operations: [
            {
              id: 'comment.add',
              kind: 'mutation',
              description: 'Comment on a task.',
              grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
              errors: [
                'usage',
                'wrong_id_kind',
                'forbidden',
                'not_found',
                'task_archived',
                'idempotency_key_mismatch',
                'identity_unavailable',
              ],
              cli: { command: 'comment', args: ['task', 'text'], modes: null, key: '--key' },
              mcp: {
                name: 'comment_add',
                key: 'idempotencyKey',
                whenToUse: 'Add a task comment.',
                whenNotToUse: 'Use comment_edit to revise an existing comment.',
                destructive: false,
              },
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            },
          ],
        },
      },
    ],
  }),
  defineOperation({
    id: 'inbox.get',
    kind: 'query',
    description: 'List the comments, blocks and turns addressed to the caller and not yet handled.',
    mcp: {
      whenToUse: 'Read items awaiting the caller.',
      whenNotToUse: 'Use inbox_ack to mark them read.',
    },
    input: z.strictObject({ project }),
    output: z.strictObject({
      comments: z.array(commentSchema).describe('Comments not yet acknowledged.'),
      blocks: z.array(blockViewSchema).describe('Open blocks addressed to the caller.'),
      turns: z
        .array(turnViewSchema)
        .describe('Unclosed turns the caller may take or has taken; at most one per task.'),
    }),
    grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
    errors: ['not_found'],
    cli: { command: 'inbox', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Read the inbox',
        input: {},
        output: {
          comments: [comment],
          blocks: [codeBlock],
          turns: [{ ...reviewTurn, handed: [handedReview] }],
        },
      },
    ],
  }),
  defineOperation({
    id: 'inbox.ack',
    kind: 'mutation',
    description:
      'Mark comments, agent-addressed blocks or turns as read; acking a turn makes the caller its taker.',
    mcp: {
      whenToUse: 'Mark handled inbox items read.',
      whenNotToUse: 'Use inbox_get to inspect them first.',
    },
    input: z.strictObject({
      entries: z
        .array(
          z.union([
            z.strictObject({
              id: commentIdSchema,
              revision: z.int().positive().describe('Revision the caller read.'),
            }),
            z.strictObject({ id: blockIdSchema }),
            z.strictObject({ id: turnIdSchema }),
          ]),
        )
        .min(1)
        .max(ACK_ENTRIES_MAX)
        .describe('Comment revisions, blocks and turns to acknowledge.'),
    }),
    output: z.strictObject({
      acked: z
        .array(z.union([commentIdSchema, blockIdSchema, turnIdSchema]))
        .describe('Entries now acknowledged.'),
    }),
    grants: [{ grant: 'project-agent' }],
    errors: ['wrong_id_kind', 'not_found', 'stale_comment_revision'],
    cli: { command: 'inbox ack', args: ['entries'] },
    slack: null,
    examples: [
      {
        summary: 'Acknowledge a comment revision',
        input: { entries: [{ id: 'C3', revision: 1 }] },
        output: { acked: ['C3'] },
      },
      {
        summary: 'Acknowledge an agent-addressed block',
        input: { entries: [{ id: 'B13' }] },
        output: { acked: ['B13'] },
      },
      {
        summary: 'Take a turn',
        input: { entries: [{ id: 'T4' }] },
        output: { acked: ['T4'] },
      },
    ],
  }),
  defineOperation({
    id: 'token.list',
    kind: 'query',
    description: 'List named operator tokens and their current status.',
    mcp: {
      whenToUse: 'Inspect named operator tokens and their current status.',
      whenNotToUse: 'Use token_revoke to disable a token.',
    },
    input: z.strictObject({}),
    output: z.strictObject({
      tokens: z
        .array(
          z.strictObject({
            name: tokenName,
            folder: z.string().min(1).describe('Folder where the token file was created.'),
            status: tokenStatus,
          }),
        )
        .describe('Named tokens in creation order.'),
    }),
    grants: operatorOnly,
    errors: [],
    cli: { command: 'token list', args: [] },
    slack: null,
    examples: [
      {
        summary: 'List operator tokens',
        input: {},
        output: { tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'approved' }] },
      },
    ],
  }),
  defineOperation({
    id: 'token.revoke',
    kind: 'mutation',
    description: 'Revoke a named operator token immediately.',
    mcp: {
      whenToUse: 'Disable a named operator token immediately.',
      whenNotToUse: 'Use token_list to inspect tokens without changing them.',
    },
    input: z.strictObject({ name: tokenName.max(LEGACY_TOKEN_NAME_MAX) }),
    output: z.strictObject({ name: tokenName, status: tokenStatus }),
    grants: operatorOnly,
    errors: ['not_found'],
    cli: { command: 'token revoke', args: ['name'] },
    slack: null,
    examples: [
      {
        summary: 'Revoke an operator token',
        input: { name: 'desk' },
        output: { name: 'desk', status: 'revoked' },
      },
    ],
  }),
  defineOperation({
    id: 'task.add',
    kind: 'mutation',
    description: 'Put a tracker task on the board.',
    mcp: {
      whenToUse: 'Add a task to the board.',
      whenNotToUse: 'Use task_get if it already exists.',
    },
    input: z.strictObject({ task: taskKeyInputSchema }),
    output: taskOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'task add', args: ['task'] },
    slack: null,
    examples: [{ summary: 'Add a task', input: { task: 'PROJ-123' }, output: { task } }],
  }),
  defineOperation({
    id: 'task.archive',
    kind: 'mutation',
    description: 'Take a task off the board.',
    mcp: {
      whenToUse: 'Remove a task from active view.',
      whenNotToUse: 'Use task_get to inspect its current state.',
    },
    input: z.strictObject({ task: taskKeyInputSchema }),
    output: taskOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'task archive', args: ['task'] },
    slack: null,
    examples: [
      {
        summary: 'Archive a task',
        input: { task: 'PROJ-123' },
        output: { task: { ...task, membership: 'archived' } },
      },
    ],
  }),
  defineOperation({
    id: 'link.add',
    kind: 'mutation',
    description: 'Manually link a pull request, session, or additional ticket to a task.',
    mcp: {
      whenToUse: 'Attach a pull request, session, or additional ticket.',
      whenNotToUse: 'Use link_remove to detach one.',
    },
    input: linkInput,
    output: linkOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived', 'link_conflict'],
    cli: { command: 'link', args: ['task'], modes: linkModes },
    slack: null,
    examples: [
      {
        summary: 'Link a pull request',
        input: {
          mode: 'pr',
          task: 'PROJ-123',
          pr: 'https://github.com/example/web/pull/7',
          reason: 'Attach work started before the ticket was named.',
        },
        output: { task: 'PROJ-123', target: 'example/web#7' },
      },
    ],
  }),
  defineOperation({
    id: 'link.remove',
    kind: 'mutation',
    description: 'Manually remove a pull request, session, or ticket link from a task.',
    mcp: {
      whenToUse: 'Detach a linked pull request, session, or ticket.',
      whenNotToUse: 'Use link_add to attach one.',
    },
    input: linkInput,
    output: linkOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'unlink', args: ['task'], modes: linkModes },
    slack: null,
    examples: [
      {
        summary: 'Unlink a session',
        input: { mode: 'session', task: 'PROJ-123', session: 'web-7', reason: 'Wrong task.' },
        output: { task: 'PROJ-123', target: 'web-7' },
      },
    ],
  }),
  defineOperation({
    id: 'item.retry',
    kind: 'mutation',
    description: 'Retry the action behind a "from you" item.',
    mcp: {
      whenToUse: 'Retry an actionable item.',
      whenNotToUse: 'Use item_close when no retry is wanted.',
    },
    input: z.strictObject({ item: itemIdSchema }),
    output: itemOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived', 'retry_not_applicable'],
    cli: { command: 'item retry', args: ['item'] },
    slack: { kind: 'button', label: 'Retry' },
    examples: [{ summary: 'Retry a failed deploy', input: { item: 'I7' }, output: { item } }],
  }),
  defineOperation({
    id: 'item.close',
    kind: 'mutation',
    description: 'Close a "from you" item without acting on it.',
    mcp: {
      whenToUse: 'Dismiss an item without retrying.',
      whenNotToUse: 'Use item_retry to try again.',
    },
    input: z.strictObject({ item: itemIdSchema }),
    output: itemOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'item close', args: ['item'] },
    slack: { kind: 'button', label: 'Close' },
    examples: [
      {
        summary: 'Close a board-wide item',
        input: { item: 'I8' },
        output: { item: { ...item, id: 'I8', task: null } },
      },
    ],
  }),
  defineOperation({
    id: 'block.ask',
    kind: 'mutation',
    description:
      'Ask a blocking question; the Board routes it to the column orchestrator, the curator or the operator.',
    mcp: {
      whenToUse: 'Ask a blocking question.',
      whenNotToUse: 'Use comment_add for a nonblocking note.',
      destructive: false,
    },
    input: z.strictObject({ task: taskKeyInputSchema, text: text('The question.', TEXT_MAX) }),
    output: blockOutput,
    grants: [{ grant: 'project-agent' }],
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'ask', args: ['task', 'text'] },
    slack: null,
    examples: [
      {
        summary: 'Ask which API version to target',
        input: { task: 'PROJ-123', text: question.reason },
        output: { block: question },
      },
    ],
  }),
  defineOperation({
    id: 'comment.add',
    kind: 'mutation',
    description: 'Comment on a task.',
    mcp: {
      whenToUse: 'Add a new task comment.',
      whenNotToUse: 'Use comment_edit to revise your comment.',
      destructive: false,
    },
    input: z.strictObject({
      task: taskKeyInputSchema,
      block: blockIdSchema.optional().describe('Block conversation to join, if any.'),
      text: text('Comment text.', TEXT_MAX),
    }),
    output: z.strictObject({ comment: commentSchema }),
    grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'comment', args: ['task', 'text'] },
    slack: null,
    examples: [
      {
        summary: 'Leave a note on a task',
        input: { task: 'PROJ-123', text: 'Target v2.' },
        output: { comment: { ...comment, block: null } },
      },
    ],
  }),
  defineOperation({
    id: 'comment.edit',
    kind: 'mutation',
    description: 'Edit a comment written by the caller; the revision advances.',
    mcp: {
      whenToUse: 'Revise your existing comment.',
      whenNotToUse: 'Use comment_add for a new comment.',
    },
    input: z.strictObject({
      comment: commentIdSchema,
      text: text('Replacement comment text.', TEXT_MAX),
    }),
    output: z.strictObject({ comment: commentSchema }),
    grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'comment edit', args: ['comment', 'text'] },
    slack: null,
    examples: [
      {
        summary: 'Correct a comment',
        input: { comment: 'C3', text: 'Target v3.' },
        output: { comment: { ...comment, text: 'Target v3.', revision: 2 } },
      },
    ],
  }),
  defineOperation({
    id: 'block.create',
    kind: 'mutation',
    description: 'Block a task on a dependency or an external party.',
    mcp: {
      whenToUse: 'Record a dependency or external block.',
      whenNotToUse: 'Use block_ask for a question.',
      destructive: false,
    },
    input: z.strictObject({
      task: taskKeyInputSchema,
      type: z.enum(BLOCK_TYPES).extract(['dependency', 'external']).describe('Block type.'),
      reason: text('What the task waits for.', TEXT_MAX),
    }),
    output: blockOutput,
    grants: [{ grant: 'column-orchestrator' }, { grant: 'operator' }],
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'block', args: ['task'] },
    slack: null,
    examples: [
      {
        summary: 'Wait for another task',
        input: { task: 'PROJ-123', type: 'dependency', reason: 'Needs PROJ-120 merged first.' },
        output: {
          block: {
            ...question,
            id: 'B14',
            type: 'dependency',
            author: 'operator',
            reason: 'Needs PROJ-120 merged first.',
          },
        },
      },
    ],
  }),
  defineOperation({
    id: 'block.escalate',
    kind: 'mutation',
    description: 'Pass a block on to the next addressee up the chain.',
    mcp: {
      whenToUse: 'Escalate an open block.',
      whenNotToUse: 'Use block_answer to answer a question.',
    },
    input: z.strictObject({
      block: blockIdSchema,
      note: z
        .string()
        .min(1)
        .max(TEXT_MAX)
        .optional()
        .describe('Context for the next addressee, posted after the original text.'),
    }),
    output: blockOutput,
    grants: [{ grant: 'block-addressee' }],
    errors: ['wrong_id_kind', 'not_found', 'block_not_open', 'task_archived'],
    cli: { command: 'escalate', args: ['block'] },
    slack: null,
    examples: [
      {
        summary: 'Escalate a failing build to the operator',
        input: { block: 'B13' },
        output: { block: { ...codeBlock, addressee: 'operator' } },
      },
      {
        summary: 'Escalate a question with a note',
        input: { block: 'B12', note: 'The API owner is away until Monday.' },
        output: { block: { ...question, addressee: 'operator' } },
      },
    ],
  }),
  defineOperation({
    id: 'block.answer',
    kind: 'mutation',
    description: 'Answer a question block; the answer becomes a comment and the block closes.',
    mcp: {
      whenToUse: 'Answer an open question.',
      whenNotToUse: 'Use block_unblock to close without an answer.',
    },
    input: z.strictObject({ block: blockIdSchema, text: text('The answer.', TEXT_MAX) }),
    output: z.strictObject({ block: blockViewSchema, comment: commentSchema }),
    grants: [{ grant: 'block-addressee' }, { grant: 'operator' }],
    preconditions: { blockTypes: ['needs_input'] },
    errors: ['wrong_id_kind', 'not_found', 'block_not_open', 'wrong_block_type', 'task_archived'],
    cli: { command: 'answer', args: ['block', 'text'] },
    slack: { kind: 'thread-reply' },
    examples: [
      {
        summary: 'Answer a question',
        input: { block: 'B12', text: 'Target v2.' },
        output: {
          block: {
            ...question,
            state: 'unblocked',
            outcome: 'done',
            unblockedBy: 'operator',
            unblockedAt: at,
          },
          comment,
        },
      },
    ],
  }),
  defineOperation({
    id: 'block.unblock',
    kind: 'mutation',
    description: 'Close a block: the work is done, a reason is given, or its author withdraws it.',
    mcp: {
      whenToUse: 'Close an open block.',
      whenNotToUse: 'Use block_answer for a question answer.',
    },
    input: z.discriminatedUnion('mode', [
      z
        .strictObject({
          mode: z.literal('done').describe('The blocking work is done.'),
          block: blockIdSchema,
          ref: text(
            'What resolved the block, e.g. a commit SHA or a pull request.',
            REF_MAX,
          ).optional(),
        })
        .describe('Unblock because the work is done.'),
      z
        .strictObject({
          mode: z.literal('reason').describe('Unblock with an explanation.'),
          block: blockIdSchema,
          reason: text('Why the block no longer applies.', TEXT_MAX),
        })
        .describe('Unblock with a reason.'),
      z
        .strictObject({
          mode: z
            .literal('withdraw')
            .describe('The author takes their own question back (needs_input only).'),
          block: blockIdSchema,
          answer: text(
            'Why it is withdrawn, e.g. the answer received outside the board.',
            TEXT_MAX,
          ),
        })
        .describe('Withdraw the block.'),
    ]),
    output: blockOutput,
    grants: [
      { grant: 'task-worker', mode: 'done', blockTypes: ['code'] },
      { grant: 'block-addressee', mode: 'reason' },
      { grant: 'column-orchestrator', mode: 'reason', blockTypes: ['code'] },
      { grant: 'operator', mode: 'reason' },
      { grant: 'block-author', mode: 'withdraw', blockTypes: ['needs_input'] },
    ],
    errors: ['wrong_id_kind', 'not_found', 'block_not_open', 'task_archived'],
    cli: {
      command: 'unblock',
      args: ['block'],
      modes: [
        { mode: 'done', flag: '--done', value: 'ref' },
        { mode: 'reason', flag: '--reason', value: 'reason' },
        { mode: 'withdraw', flag: '--withdraw', value: 'answer' },
      ],
    },
    slack: null,
    examples: [
      {
        summary: 'Unblock after fixing the build',
        input: { mode: 'done', block: 'B13', ref: 'example/web#9' },
        output: {
          block: {
            ...codeBlock,
            state: 'unblocked',
            outcome: 'done',
            outcomeReason: 'example/web#9',
            unblockedBy: 'agent:web/web-8',
            unblockedAt: at,
          },
        },
      },
      {
        summary: 'Explain why a code block no longer applies',
        input: { mode: 'reason', block: 'B13', reason: 'The build issue was resolved.' },
        output: {
          block: {
            ...codeBlock,
            state: 'unblocked',
            outcome: 'reason',
            outcomeReason: 'The build issue was resolved.',
            unblockedBy: 'agent:web/web-8',
            unblockedAt: at,
          },
        },
      },
      {
        summary: 'Withdraw a question',
        input: { mode: 'withdraw', block: 'B12', answer: 'Answered outside the board.' },
        output: {
          block: {
            ...question,
            state: 'unblocked',
            outcome: 'withdrawn',
            outcomeReason: 'Answered outside the board.',
            unblockedBy: 'agent:web/web-7',
            unblockedAt: at,
          },
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.submit',
    kind: 'mutation',
    description:
      "Submit the commit at the head of the task's pull request for a turn this session took; the turn closes.",
    mcp: {
      whenToUse:
        'Hand in the work of a turn you took, at the pull request head. While the project dispatcher is in shadow mode no turn opens: the column executor submits with the task key.',
      whenNotToUse: 'Use task_return to send the task back to Dev instead.',
    },
    input: z.strictObject({
      turn: z
        .union([turnIdSchema, taskKeyInputSchema])
        .describe(
          'Turn ID you took (T4); while the project dispatcher is in shadow mode, the task key instead.',
        ),
      sha: commitShaSchema
        .max(64)
        .describe('Full commit SHA at the head of the pull request, lowercase.'),
    }),
    output: z.strictObject({
      task: taskViewSchema,
      turn: turnIdSchema
        .nullable()
        .describe('The closed turn; null for a submit by task key in shadow mode.'),
      sha: commitShaSchema.describe('The submitted commit SHA.'),
    }),
    grants: [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }],
    errors: [
      'wrong_id_kind',
      'not_found',
      'task_archived',
      'turn_closed',
      'not_turn_taker',
      'head_mismatch',
      'github_unavailable',
    ],
    cli: { command: 'submit', args: ['turn', 'sha'] },
    slack: null,
    examples: [
      {
        summary: 'Submit the pull request head for a review turn',
        input: { turn: 'T4', sha: submittedSha },
        output: { task: { ...task, column: 'review' }, turn: 'T4', sha: submittedSha },
      },
      {
        summary: 'Submit the pull request head by task key while the dispatcher is in shadow mode',
        input: { turn: 'PROJ-123', sha: submittedSha },
        output: { task: { ...task, column: 'review' }, turn: null, sha: submittedSha },
      },
    ],
  }),
  defineOperation({
    id: 'task.return',
    kind: 'mutation',
    description:
      'Return the task of a turn this session took to Dev, opening a code block on the worker with the reason.',
    mcp: {
      whenToUse: 'Send the task back to Dev because the work needs code changes.',
      whenNotToUse: 'Use task_submit to hand in the work instead.',
    },
    input: z.strictObject({
      turn: turnIdSchema,
      reason: text('What the worker must change, sent to the worker as a code block.', TEXT_MAX),
    }),
    output: z.strictObject({ task: taskViewSchema, block: blockViewSchema }),
    grants: [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }],
    errors: [
      'wrong_id_kind',
      'not_found',
      'task_archived',
      'turn_closed',
      'not_turn_taker',
      'return_not_allowed',
    ],
    cli: { command: 'return', args: ['turn', 'reason'] },
    slack: null,
    examples: [
      {
        summary: 'Return a reviewed task to Dev',
        input: { turn: 'T4', reason: 'Handle the empty list in the parser.' },
        output: {
          task,
          block: {
            ...codeBlock,
            id: 'B14',
            author: 'agent:rev/rev-1',
            reason: 'Handle the empty list in the parser.',
          },
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.move',
    kind: 'mutation',
    description:
      'Correct the column of a task by hand; the gates then settle the task from that column at once.',
    mcp: {
      whenToUse:
        'Put a task the board moved wrongly into the right column, Done excluded; the reply names the column it settled in.',
      whenNotToUse: 'Use task_get with why to read why the task is where it is.',
    },
    input: z.discriminatedUnion('mode', [
      z.strictObject({
        mode: z.literal('correct').describe('Correct a wrong column by hand.'),
        task: taskKeyInputSchema,
        column: z
          .enum(COLUMN_IDS)
          .exclude(['done'])
          .describe('Enabled column to put the task in; Done is reached only from the facts.'),
        reason: text('Why the column is corrected, kept in the journal.', TEXT_MAX),
      }),
    ]),
    output: z.strictObject({
      task: taskViewSchema,
      from: z.enum(COLUMN_IDS).describe('Column the dispatcher worked from before the correction.'),
      to: z.enum(COLUMN_IDS).describe('Column the correction put the task in.'),
      column: z
        .enum(COLUMN_IDS)
        .describe(
          'Column the gates settled the task in; the shadow column while the dispatcher is in shadow mode.',
        ),
      settled: z
        .array(moveViewSchema)
        .describe('The dispatcher moves from the corrected column, oldest first.'),
    }),
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived', 'move_not_allowed'],
    cli: {
      command: 'move',
      args: ['task', 'column'],
      modes: [{ mode: 'correct', flag: '--correct', value: null }],
    },
    slack: null,
    examples: [
      {
        summary: 'Correct a task the board put in Done by mistake',
        input: {
          mode: 'correct',
          task: 'PROJ-123',
          column: 'dev',
          reason: 'The linked pull request belongs to another ticket.',
        },
        output: { task, from: 'done', to: 'dev', column: 'dev', settled: [] },
      },
      {
        summary: 'Correct a task into Review while its Dev gate is broken',
        input: {
          mode: 'correct',
          task: 'PROJ-123',
          column: 'review',
          reason: 'The review was done outside the board.',
        },
        output: {
          task,
          from: 'dev',
          to: 'review',
          column: 'dev',
          settled: [
            {
              at,
              kind: 'task_moved',
              actor: 'system',
              from: 'review',
              to: 'dev',
              reason: 'gate_broken',
              gate: ['external_comments'],
              text: null,
            },
          ],
        },
      },
    ],
  }),
] as const;

export type OperationId = (typeof OPERATIONS)[number]['id'];
