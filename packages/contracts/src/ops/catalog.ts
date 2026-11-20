import { taskMoveInputSchema, taskMoveOutputSchema } from './move-schemas.ts';
import {
  statusInputSchema,
  statusOutputSchema,
  commentAddInputSchema,
  commentAddOutputSchema,
  blockAnswerInputSchema,
  blockAnswerOutputSchema,
  blockFollowupInputSchema,
  configGetInputSchema,
  inboxOperatorInputSchema,
  inboxOperatorOutputSchema,
  itemInputSchema,
  itemOutputSchema,
  taskGetInputSchema,
  taskGetOutputSchema,
  taskHistoryInputSchema,
  taskHistoryOutputSchema,
} from '../browser.ts';
import {
  inboxAckInputSchema,
  inboxAckOutputSchema,
  taskReturnInputSchema,
  taskReturnOutputSchema,
  taskSubmitInputSchema,
  taskSubmitOutputSchema,
} from './turn-write-schemas.ts';
import { z } from 'zod';
import { configViewSchema } from './config-view-schema.ts';
import { columnsDescribeOutputSchema } from './columns-schema.ts';
import { BLOCK_TYPES, TOKEN_STATUSES } from '../enums.ts';
import { blockIdSchema, commentIdSchema, taskKeyInputSchema, taskKeySchema } from '../ids.ts';
import { defineOperation } from './define.ts';
import { SCHEMA_ROLES, schemaGetOutputSchema } from './schema-get-schema.ts';
import { blockViewSchema, commentSchema, taskViewSchema, taskWhySchema } from './schemas.ts';
import { type turnHandedSchema, turnViewSchema } from './turn-schemas.ts';

/** Longest free text an input takes: comments, questions, answers and reasons. */
const TEXT_MAX = 20_000;
/** Longest project, session or token name an input takes. */
const NAME_MAX = 256;
/** Names were limited only by the old 1 MiB request body before #242, so revoke must accept any of them. */
const LEGACY_TOKEN_NAME_MAX = 1_048_576;
/** Longest pull request URL or unblock reference an input takes. */
const REF_MAX = 2048;

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
const daemon = { version: '0.4.0', startedAt: '2026-01-05T08:00:00.000Z', lastDispatchAt: at };
const daemonService = {
  service: 'daemon',
  state: 'healthy',
  since: daemon.startedAt,
  lastGoodAt: at,
  reason: null,
} as const;
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
const devTurn = {
  id: 'T3',
  column: 'dev',
  addressee: 'worker',
  at,
  taken: null,
  closed: null,
} as const;
const later = '2026-01-05T10:15:00.000Z';
const handedReview: z.input<typeof turnHandedSchema> = {
  repo: 'acme/web',
  number: 42,
  kind: 'review',
  id: 'PRR_kwDOA1',
  postedAt: at,
  url: 'https://github.com/acme/web/pull/42#pullrequestreview-2001',
  comments: [
    {
      id: 'PRRC_kwDOA2',
      url: 'https://github.com/acme/web/pull/42#discussion_r3001',
      threadId: 'PRRT_kwDOA3',
    },
  ],
};
/** The return from Review that opened the Dev visit, with its code block. */
const returnFromReview = {
  by: 'agent:rev/rev-1',
  from: 'review',
  turn: 'T2',
  block: codeBlock.id,
  reason: codeBlock.reason,
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
 * Review waits for its review on head. Ready to Merge is disabled, so no column requires resolved
 * threads and Dev's `threads_resolved` is met.
 */
const reviewGates: GateView[] = [
  { column: 'todo', enabled: true, ok: true, blockedIn: null, conditions: [] },
  { column: 'triage', enabled: false, ok: true, blockedIn: null, conditions: [] },
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
      met('threads_resolved'),
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
const linkOutput = z.strictObject({ task: taskKeySchema, target });

const operatorOrProjectAgent = [{ grant: 'operator' }, { grant: 'project-agent' }] as const;
const operatorOnly = [{ grant: 'operator' }] as const;
const tokenStatus = z.enum(TOKEN_STATUSES).describe('Current token state.');
const tokenName = z.string().min(1).describe('Unique name of the operator token.');

/** The M1 operations. CLI, MCP and the daemon route are generated from this list. */
export const OPERATIONS = [
  defineOperation({
    id: 'status.get',
    web: true,
    kind: 'query',
    description:
      'List items, freshness, service health, host metrics, tasks with columnEnteredAt, turns and PRs; detail adds facts.',
    mcp: {
      whenToUse: 'Get a board overview.',
      whenNotToUse: 'Use task_get for one task.',
    },
    input: statusInputSchema,
    output: statusOutputSchema,
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
          host: {
            sampledAt: at,
            cpuPercent: 12.5,
            memory: { totalBytes: 17179869184, availableBytes: 8589934592, usedPercent: 50 },
            disk: {
              mount: '/',
              totalBytes: 107374182400,
              availableBytes: 64424509440,
              usedPercent: 40,
            },
            volumes: [
              {
                mount: '/',
                totalBytes: 107374182400,
                availableBytes: 64424509440,
                usedPercent: 40,
              },
              {
                mount: '/home',
                totalBytes: 536870912000,
                availableBytes: 375809638400,
                usedPercent: 30,
              },
            ],
          },
          services: [daemonService],
          transport: [],
          sources: [],
          tasks: [
            {
              ...task,
              columnEnteredAt: at,
              state: 'ticket not observed',
              prCount: 0,
              sessionCount: 0,
              openBlocks: 0,
              blocks: [],
              turn: null,
              prSummary: null,
              links: { ticket: null, prs: [], sessions: [] },
            },
          ],
          columnGroups: [{ id: 'todo', columns: ['todo', 'triage', 'ready-for-dev'] }],
          projectBlocks: [{ project: 'web', openBlocks: 0 }],
          unlinkedPrs: [],
          unlinkedSessions: [],
          hiddenUnlinkedPrs: 0,
          hiddenUnlinkedSessions: 0,
          bindings: {
            columns: [
              { project: 'web', column: 'review', orchestrator: 'web-review', source: 'project' },
            ],
            operators: [{ project: 'web', operator: 'hq', source: 'board-wide' }],
            defaultAddressee: { spurProject: 'hq', source: 'board-wide' },
          },
          daemon,
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
          host: null,
          services: [daemonService],
          transport: [],
          sources: [],
          tasks: [
            {
              ...task,
              columnEnteredAt: at,
              state: 'ticket not observed',
              prCount: 0,
              sessionCount: 0,
              openBlocks: 0,
              blocks: [],
              turn: null,
              prSummary: null,
              links: { ticket: null, prs: [], sessions: [] },
              ticket: null,
              prs: [],
              sessions: [],
            },
          ],
          columnGroups: [{ id: 'todo', columns: ['todo', 'triage', 'ready-for-dev'] }],
          projectBlocks: [{ project: 'web', openBlocks: 0 }],
          unlinkedPrs: [],
          unlinkedSessions: [],
          hiddenUnlinkedPrs: 0,
          hiddenUnlinkedSessions: 0,
          bindings: { columns: [], operators: [], defaultAddressee: null },
          daemon,
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.get',
    web: true,
    kind: 'query',
    description: 'Show a task; refresh reads GitHub PRs.',
    mcp: {
      whenToUse: 'Inspect a task; detail adds closed turns.',
      whenNotToUse: 'Use task_history for past events.',
    },
    input: taskGetInputSchema,
    output: taskGetOutputSchema,
    grants: operatorOrProjectAgent,
    errors: ['wrong_id_kind', 'not_found', 'github_unavailable'],
    cli: { command: 'task', args: ['task'] },
    slack: { kind: 'slash-command', usage: '/board task <KEY> [why]' },
    examples: [
      {
        summary: 'Show one task',
        input: { task: 'PROJ-123' },
        output: {
          task,
          turn: { ...devTurn, handed: [handedReview], returned: returnFromReview },
          links: [],
          blocks: [
            { ...question, answeredVia: null },
            { ...codeBlock, answeredVia: null },
          ],
          comments: [comment],
        },
      },
      {
        summary: 'Explain why a task waits in Review',
        input: { task: 'PROJ-123', why: true },
        output: {
          task: { ...task, column: 'review' },
          turn: {
            id: reviewTurn.id,
            column: reviewTurn.column,
            addressee: reviewTurn.addressee,
            at,
            taken: { by: 'agent:rev/rev-1', at },
            handed: [],
            closed: null,
          },
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
      {
        summary: 'Show a task with its last closed turns',
        input: { task: 'PROJ-123', detail: true },
        output: {
          task,
          turn: {
            ...devTurn,
            id: 'T4',
            at: later,
            taken: { by: 'agent:web/web-7', at: later },
            handed: [],
          },
          turns: [{ ...devTurn, handed: [], closed: { at: later, outcome: 'submitted' } }],
          links: [],
          blocks: [],
          comments: [],
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.history',
    web: true,
    kind: 'query',
    description:
      'List what happened to a task, oldest first by time, leaving out facts events with nothing new to name, such as an update time alone.',
    mcp: {
      whenToUse: 'Trace changes to one task.',
      whenNotToUse: 'Use task_get for current state.',
    },
    input: taskHistoryInputSchema,
    output: taskHistoryOutputSchema,
    grants: operatorOrProjectAgent,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'task history', args: ['task'] },
    slack: { kind: 'slash-command', usage: '/board task <KEY> history' },
    examples: [
      {
        summary: 'Show task history',
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
    web: true,
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
    id: 'inbox.operator',
    web: true,
    kind: 'query',
    description:
      "List what waits for the operator and what was handled in the last 24 hours; a project's own operator session sees only its operator projects, and _board entries only when no board-wide operator is configured.",
    mcp: {
      whenToUse:
        'As the operator, review every open operator item, block and turn across projects in one list.',
      whenNotToUse: 'Use inbox_get for the comments, blocks and turns addressed to an agent.',
    },
    input: inboxOperatorInputSchema,
    output: inboxOperatorOutputSchema,
    grants: operatorOnly,
    errors: [],
    cli: { command: 'inbox operator', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Read the operator inbox',
        input: {},
        output: {
          items: [
            {
              id: 'B12',
              project: 'web',
              kind: 'block',
              severity: 'attention',
              text: question.reason,
              at: later,
              task: 'PROJ-123',
              answeredVia: null,
            },
            {
              id: 'I9',
              project: '_board',
              kind: 'board_observation',
              severity: 'failure',
              text: 'example/web: main is red (build): open the failing run; fix or revert',
              action: 'open the failing run; fix or revert',
              url: 'https://github.com/example/web/actions/runs/42',
              at,
              task: null,
            },
            {
              id: 'T5',
              project: 'web',
              kind: 'turn',
              severity: 'attention',
              text: 'Your turn T5: The pull request is ready to merge.',
              at,
              task: 'PROJ-124',
              column: 'ready-to-merge',
            },
          ],
          handled: [
            {
              id: 'B11',
              project: 'web',
              kind: 'block',
              severity: 'attention',
              text: 'May the client drop v1?',
              at,
              task: 'PROJ-123',
              answeredVia: 'slack',
              handledAt: later,
            },
          ],
        },
      },
    ],
  }),
  defineOperation({
    id: 'inbox.ack',
    kind: 'mutation',
    description:
      'Mark comments, agent-addressed blocks, turns or doorbell rings as read; acking a turn makes the caller its taker.',
    mcp: {
      whenToUse:
        'Mark handled inbox items or a ring ID like N18-1 read; an item handled before comes back under alreadyHandled. The operator acks a turn ID to take over an open orchestrator turn, taken or not.',
      whenNotToUse: 'Use inbox_get to inspect them first.',
    },
    input: inboxAckInputSchema,
    output: inboxAckOutputSchema,
    web: true,
    grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
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
      {
        summary: 'Acknowledge a doorbell by the ring ID at the end of its text',
        input: { entries: [{ id: 'N18-1' }] },
        output: { acked: ['N18-1'] },
      },
      {
        summary: 'Acknowledge a block already closed by an answer',
        input: { entries: [{ id: 'B14' }] },
        output: { acked: ['B14'], alreadyHandled: ['B14'] },
      },
    ],
  }),
  defineOperation({
    id: 'token.list',
    kind: 'query',
    description:
      'List named operator tokens with their status and when each was created, approved and last used.',
    mcp: {
      whenToUse:
        'Inspect named operator tokens, their status, and when each was approved and last used.',
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
            createdAt: z.iso.datetime().describe('When the token was requested, ISO 8601 UTC.'),
            approvedAt: z.iso
              .datetime()
              .nullable()
              .describe(
                'When the token was approved, ISO 8601 UTC; null when it never was, or was revoked before approval times were kept.',
              ),
            lastUsedAt: z.iso
              .datetime()
              .nullable()
              .describe(
                'When a call last authenticated with the token, ISO 8601 UTC, recorded at most once every 5 minutes; null before the first call.',
              ),
          }),
        )
        .describe('Named tokens in creation order.'),
    }),
    grants: operatorOnly,
    errors: [],
    cli: { command: 'token list', args: [] },
    slack: { kind: 'slash-command', usage: '/board tokens' },
    examples: [
      {
        summary: 'List operator tokens',
        input: {},
        output: {
          tokens: [
            {
              name: 'desk',
              folder: 'workspace/desk',
              status: 'approved',
              createdAt: '2026-11-04T10:00:00.000Z',
              approvedAt: '2026-11-04T10:02:00.000Z',
              lastUsedAt: '2026-11-05T09:30:00.000Z',
            },
          ],
        },
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
    description:
      'Manually link a pull request, session, or additional ticket to a task. Pull request links first read current facts from GitHub.',
    mcp: {
      whenToUse: 'Attach a pull request, session, or additional ticket.',
      whenNotToUse: 'Use link_remove to detach one.',
    },
    input: linkInput,
    output: linkOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived', 'link_conflict', 'github_unavailable'],
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
    input: itemInputSchema,
    output: itemOutputSchema,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived', 'retry_not_applicable'],
    cli: { command: 'item retry', args: ['item'] },
    slack: { kind: 'button', label: 'Retry' },
    examples: [{ summary: 'Retry a failed deploy', input: { item: 'I7' }, output: { item } }],
  }),
  defineOperation({
    id: 'item.close',
    web: true,
    kind: 'mutation',
    description: 'Close a "from you" item without acting on it.',
    mcp: {
      whenToUse: 'Dismiss an item without retrying.',
      whenNotToUse: 'Use item_retry to try again.',
    },
    input: itemInputSchema,
    output: itemOutputSchema,
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
    id: 'project.ask',
    kind: 'mutation',
    description: 'Ask the operator about a project, not a task.',
    mcp: {
      whenToUse: 'A question has no task.',
      whenNotToUse: 'Use block_ask for a task question.',
      destructive: false,
    },
    input: z.strictObject({
      project: z.string().min(1).max(NAME_MAX).describe('Board project the question is about.'),
      to: z.literal('operator').describe('Who answers; only the operator.'),
      text: text('The question.', TEXT_MAX),
    }),
    output: blockOutput,
    grants: [{ grant: 'project-agent' }],
    errors: ['not_found'],
    cli: { command: 'project ask', args: ['project', 'text'] },
    slack: null,
    examples: [
      {
        summary: 'Ask to restart',
        input: { project: 'web', to: 'operator', text: 'Restart?' },
        output: {
          block: { ...question, id: 'B15', task: null, project: 'web', reason: 'Restart?' },
        },
      },
    ],
  }),
  defineOperation({
    id: 'comment.add',
    web: true,
    kind: 'mutation',
    description: 'Comment on a task.',
    mcp: {
      whenToUse: 'Add a new task comment.',
      whenNotToUse: 'Use comment_edit to revise your comment.',
      destructive: false,
    },
    input: commentAddInputSchema,
    output: commentAddOutputSchema,
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
        summary: 'Escalate a failing build',
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
    web: true,
    kind: 'mutation',
    description: 'Answer a question; the block closes unless it is an operator conversation.',
    mcp: {
      whenToUse: 'Answer an open question.',
      whenNotToUse: 'Use block_unblock to close without an answer.',
    },
    input: blockAnswerInputSchema,
    output: blockAnswerOutputSchema,
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
      {
        summary: 'Answer a question with a note',
        input: { block: 'B12', text: 'Target v2.', note: 'Checked the release plan.' },
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
    id: 'block.followup',
    web: true,
    kind: 'mutation',
    description:
      'Follow up on an unblocked block: the comment rings its author like an answer; the block stays closed.',
    mcp: {
      whenToUse: 'Add to an answer after the block was unblocked.',
      whenNotToUse: 'Use block_answer while the block is open.',
      destructive: false,
    },
    input: blockFollowupInputSchema,
    output: commentAddOutputSchema,
    grants: [{ grant: 'operator' }],
    errors: ['wrong_id_kind', 'not_found', 'block_still_open', 'task_archived'],
    cli: { command: 'followup', args: ['block', 'text'] },
    slack: { kind: 'thread-reply' },
    examples: [
      {
        summary: 'Follow up on an answered question',
        input: { block: 'B12', text: 'Also check v3.' },
        output: { comment: { ...comment, id: 'C4', text: 'Also check v3.' } },
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
        summary: 'Unblock after a fix',
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
      "Submit the task's pull request head for a turn the caller took; the turn closes; a pending result is final.",
    mcp: {
      whenToUse:
        'Hand in the work of a turn you took, at the pull request head. Declare tested (default), carried from a tested origin on this task, or skipped; carried requires from and reason, skipped requires reason. While the project dispatcher is in shadow mode no turn opens: the column executor submits with the task key.',
      whenNotToUse: 'Use task_return to send the task back to Dev instead.',
    },
    input: taskSubmitInputSchema,
    output: taskSubmitOutputSchema,
    web: true,
    grants: [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }, { grant: 'operator' }],
    errors: [
      'wrong_id_kind',
      'not_found',
      'task_archived',
      'turn_closed',
      'not_turn_taker',
      'submit_basis_invalid',
      'submit_source_not_tested',
      'head_mismatch',
      'github_unavailable',
    ],
    cli: { command: 'submit', args: ['turn', 'sha'] },
    slack: null,
    examples: [
      {
        summary: 'Submit the pull request head',
        input: { turn: 'T4', sha: submittedSha },
        output: {
          task: { ...task, column: 'review' },
          turn: 'T4',
          sha: submittedSha,
          status: 'confirmed',
        },
      },
      {
        summary: 'Carry tested work from a submission on this task',
        input: {
          turn: 'T4',
          sha: submittedSha,
          basis: 'carried',
          from: 'a'.repeat(40),
          reason: 'The tested work is unchanged.',
        },
        output: {
          task: { ...task, column: 'review' },
          turn: 'T4',
          sha: submittedSha,
          status: 'confirmed',
        },
      },
      {
        summary: 'Submit a dev turn before the board has seen the pull request',
        input: { turn: 'T3', sha: submittedSha },
        output: { task, turn: 'T3', sha: submittedSha, status: 'pending' },
      },
      {
        summary: 'Submit the pull request head by task key while the dispatcher is in shadow mode',
        input: { turn: 'PROJ-123', sha: submittedSha },
        output: {
          task: { ...task, column: 'review' },
          turn: null,
          sha: submittedSha,
          status: 'confirmed',
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.return',
    kind: 'mutation',
    description:
      'Return the task of a turn the caller took to Dev; the reason opens a worker code block.',
    mcp: {
      whenToUse: 'Send the task back to Dev when the work needs code changes.',
      whenNotToUse: 'Use task_submit to hand in the work instead.',
    },
    input: taskReturnInputSchema,
    output: taskReturnOutputSchema,
    web: true,
    grants: [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }, { grant: 'operator' }],
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
      {
        summary: 'Return a reviewed task to Dev with the number of findings',
        input: { turn: 'T4', reason: 'Fix the two review findings.', findings: 2 },
        output: {
          task,
          block: {
            ...codeBlock,
            id: 'B14',
            author: 'agent:rev/rev-1',
            reason: 'Fix the two review findings.',
          },
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.move',
    kind: 'mutation',
    description:
      'Move an idle task inside the Todo group, or correct its column and settle the gates.',
    mcp: {
      whenToUse:
        'Place idle work at the end of an enabled Todo-group column with a literal reason and explicit key, or correct a wrong column with mode correct.',
      whenNotToUse: 'Use task_get with why to read why the task is where it is.',
    },
    input: taskMoveInputSchema,
    output: taskMoveOutputSchema,
    explicitKeyModes: ['manual'],
    web: true,
    grants: operatorOnly,
    errors: [
      'wrong_id_kind',
      'not_found',
      'task_archived',
      'move_not_allowed',
      'move_outside_todo_group',
      'work_started',
      'column_mirrored',
    ],
    cli: {
      command: 'move',
      args: ['task', 'column'],
      modes: [
        { mode: 'manual', flag: '--manual', value: null },
        { mode: 'correct', flag: '--correct', value: null },
      ],
      defaultMode: 'manual',
    },
    slack: null,
    examples: [
      {
        summary: 'Place idle work at the end of Ready for Dev',
        input: {
          mode: 'manual',
          task: 'PROJ-123',
          column: 'ready-for-dev',
          reason: 'Ready for the next worker.',
        },
        output: { task, from: 'todo', to: 'ready-for-dev', column: 'ready-for-dev', settled: [] },
      },
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
  defineOperation({
    id: 'config.get',
    web: true,
    kind: 'query',
    description: 'Show effective project columns, executors, Spur bindings and web origins.',
    mcp: {
      whenToUse: 'Read configuration before rendering the Board overview.',
      whenNotToUse: 'Use status_get for task state and freshness.',
    },
    input: configGetInputSchema,
    output: configViewSchema,
    grants: operatorOrProjectAgent,
    errors: ['not_found'],
    cli: { command: 'config get', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Show effective configuration',
        input: {},
        output: {
          projects: [
            {
              id: 'web',
              columns: [{ id: 'dev', executor: { kind: 'worker', name: null } }],
              dispatcher: { mode: 'on' },
              spurProjects: [{ name: 'web-worker', role: 'worker', displayName: 'web-worker' }],
              ticketBrowseBase: 'https://jira.example.com/browse/',
              checksGate: 'dev',
            },
          ],
          web: { publicOrigin: 'http://127.0.0.1:4778', spurUiOrigin: null },
        },
      },
    ],
  }),
  defineOperation({
    id: 'columns.describe',
    web: true,
    kind: 'query',
    description: 'Describe effective column exit rules, returns, executors and escalation.',
    mcp: {
      whenToUse:
        'Read the project column policy before deciding how to progress work; selected sessions are project-level choices, not task-specific recipients.',
      whenNotToUse:
        'Use task_get with why for a task’s current gates and turn, or config_get for compact bindings and web origins.',
    },
    input: configGetInputSchema,
    output: columnsDescribeOutputSchema,
    grants: operatorOrProjectAgent,
    errors: ['not_found'],
    cli: { command: 'columns describe', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Describe project column policies',
        input: { project: 'web' },
        output: {
          projects: [
            {
              id: 'web',
              dispatcher: { mode: 'on' },
              checksGate: 'dev',
              reposWithoutCi: [],
              resolvedThreadsFrom: null,
              completion: {
                to: 'done',
                text: 'Completion bypasses normal gates: an eligible linked merged PR with a done ticket (GitHub closed or configured Jira doneStatuses), or a done ticket without open linked PRs/live workers and with fresh complete non-blind repository and Spur observations. Missing/unconfirmed merged-ticket status holds dispatch. An open ticket resumes work only once it changed at or after the newest merge, with in-filter or manual-inclusion evidence; when no merged PR has a stored merge time (facts from before the dispatcher), work resumes once the ticket, in filter or manually included, is observed open at or past the judged PR last update plus the tracker interval. Blind GitHub or a pending submit holds both routes.',
              },
              columns: [
                {
                  id: 'todo',
                  name: 'To Do',
                  group: 'todo',
                  exit: {
                    to: 'dev',
                    conditions: [
                      {
                        id: 'work_started',
                        text: 'Work has started: an open PR, or a live worker with a fresh source and no reopened ticket.',
                      },
                    ],
                  },
                  returns: [],
                  limits: null,
                  executor: {
                    kind: 'worker',
                    project: null,
                    role: null,
                    displayName: null,
                    session: null,
                    text: 'No executor turn opens in the Todo group, even with a configured binding.',
                  },
                  escalation: { chain: [], noRecipient: null, silent: null },
                  movedBy: {
                    kind: 'manual',
                    text: 'Manual placement; work starting leaves the whole Todo group.',
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  }),
] as const;

export type OperationId = (typeof OPERATIONS)[number]['id'];
