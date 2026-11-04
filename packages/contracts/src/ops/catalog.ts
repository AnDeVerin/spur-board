import { z } from 'zod';
import { BLOCK_TYPES } from '../enums.ts';
import { EVENT_KINDS } from '../events.ts';
import {
  actorIdSchema,
  blockIdSchema,
  commentIdSchema,
  itemIdSchema,
  taskKeySchema,
} from '../ids.ts';
import { defineOperation } from './define.ts';
import {
  SCHEMA_ROLES,
  blockViewSchema,
  commentSchema,
  itemViewSchema,
  schemaGetOutputSchema,
  sourceViewSchema,
  statusItemSchema,
  statusSessionFactsSchema,
  statusTaskSchema,
  taskViewSchema,
} from './schemas.ts';
import { prFactsSchema } from '../facts.ts';

const project = z
  .string()
  .min(1)
  .optional()
  .describe('Project to limit the answer to; absent means every project the caller may see.');
const text = (what: string) => z.string().min(1).describe(what);
const target = text('What to link: a spur session name, or a pull request as owner/repo#n.');

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
const item = { id: 'I7', task: 'PROJ-123', at, summary: 'Deploy of PROJ-123 failed.' } as const;

const taskOutput = z.strictObject({ task: taskViewSchema });
const blockOutput = z.strictObject({ block: blockViewSchema });
const itemOutput = z.strictObject({ item: itemViewSchema });
const linkOutput = z.strictObject({ task: taskKeySchema, target });

const operatorOrProjectAgent = [{ grant: 'operator' }, { grant: 'project-agent' }] as const;
const operatorOnly = [{ grant: 'operator' }] as const;

/** The M1 operations. CLI, MCP and the daemon route are generated from this list. */
export const OPERATIONS = [
  defineOperation({
    id: 'status.get',
    kind: 'query',
    description: 'List tasks, observations, source freshness and actionable items.',
    input: z.strictObject({ project }),
    output: z.strictObject({
      tasks: z.array(statusTaskSchema).describe('Tasks on the board with facts and links.'),
      items: z.array(statusItemSchema).describe('Actionable items in priority order.'),
      unlinkedPrs: z.array(prFactsSchema).describe('Observed pull requests without a task link.'),
      unlinkedSessions: z
        .array(statusSessionFactsSchema)
        .describe('Observed sessions without a task link.'),
      sources: z.array(sourceViewSchema).describe('Freshness and availability of each source.'),
      warmingUp: z.boolean().describe('Whether required sources still need a complete poll.'),
      spurUnavailable: z
        .string()
        .nullable()
        .describe('One combined Spur availability line, or null when available.'),
      hostLoad: z.string().nullable().describe('Host-load episode line, or null when absent.'),
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
          tasks: [{ ...task, ticket: null, prs: [], sessions: [], links: [] }],
          items: [],
          unlinkedPrs: [],
          unlinkedSessions: [],
          sources: [],
          warmingUp: true,
          spurUnavailable: null,
          hostLoad: null,
        },
      },
    ],
  }),
  defineOperation({
    id: 'task.get',
    kind: 'query',
    description: 'Show a task with its blocks and comments.',
    input: z.strictObject({ task: taskKeySchema }),
    output: z.strictObject({
      task: taskViewSchema,
      blocks: z.array(blockViewSchema).describe('Blocks on the task, open and unblocked.'),
      comments: z.array(commentSchema).describe('Comments on the task, oldest first.'),
    }),
    grants: operatorOrProjectAgent,
    errors: ['wrong_id_kind', 'not_found'],
    cli: { command: 'task', args: ['task'] },
    slack: { kind: 'slash-command', usage: '/board task <KEY>' },
    examples: [
      {
        summary: 'Show one task',
        input: { task: 'PROJ-123' },
        output: { task, blocks: [question], comments: [comment] },
      },
    ],
  }),
  defineOperation({
    id: 'task.history',
    kind: 'query',
    description: 'List what happened to a task, oldest first.',
    input: z.strictObject({ task: taskKeySchema }),
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
              mcp: { name: 'comment_add', key: 'idempotencyKey' },
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
    description: 'List the comments and blocks addressed to the caller and not yet handled.',
    input: z.strictObject({ project }),
    output: z.strictObject({
      comments: z.array(commentSchema).describe('Comments not yet acknowledged.'),
      blocks: z.array(blockViewSchema).describe('Open blocks addressed to the caller.'),
    }),
    grants: [{ grant: 'project-agent' }, { grant: 'operator' }],
    errors: ['not_found'],
    cli: { command: 'inbox', args: [] },
    slack: null,
    examples: [
      {
        summary: 'Read the inbox',
        input: {},
        output: { comments: [comment], blocks: [codeBlock] },
      },
    ],
  }),
  defineOperation({
    id: 'inbox.ack',
    kind: 'mutation',
    description: 'Mark comments or agent-addressed blocks as read in the inbox.',
    input: z.strictObject({
      entries: z
        .array(
          z.union([
            z.strictObject({
              id: commentIdSchema,
              revision: z.int().positive().describe('Revision the caller read.'),
            }),
            z.strictObject({ id: blockIdSchema }),
          ]),
        )
        .min(1)
        .describe('Comment revisions and blocks to acknowledge.'),
    }),
    output: z.strictObject({
      acked: z
        .array(z.union([commentIdSchema, blockIdSchema]))
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
    ],
  }),
  defineOperation({
    id: 'task.add',
    kind: 'mutation',
    description: 'Put a tracker task on the board.',
    input: z.strictObject({ task: taskKeySchema }),
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
    input: z.strictObject({ task: taskKeySchema }),
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
    description: 'Link a spur session or a pull request to a task.',
    input: z.strictObject({ task: taskKeySchema, target }),
    output: linkOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'link', args: ['task', 'target'] },
    slack: null,
    examples: [
      {
        summary: 'Link a pull request',
        input: { task: 'PROJ-123', target: 'acme/web#7' },
        output: { task: 'PROJ-123', target: 'acme/web#7' },
      },
    ],
  }),
  defineOperation({
    id: 'link.remove',
    kind: 'mutation',
    description: 'Remove a link between a task and a spur session or a pull request.',
    input: z.strictObject({ task: taskKeySchema, target }),
    output: linkOutput,
    grants: operatorOnly,
    errors: ['wrong_id_kind', 'not_found', 'task_archived'],
    cli: { command: 'unlink', args: ['task', 'target'] },
    slack: null,
    examples: [
      {
        summary: 'Unlink a session',
        input: { task: 'PROJ-123', target: 'web-7' },
        output: { task: 'PROJ-123', target: 'web-7' },
      },
    ],
  }),
  defineOperation({
    id: 'item.retry',
    kind: 'mutation',
    description: 'Retry the action behind a "from you" item.',
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
    description: 'Ask the operator a question; the task is blocked until it is answered.',
    input: z.strictObject({ task: taskKeySchema, text: text('The question.') }),
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
    input: z.strictObject({
      task: taskKeySchema,
      block: blockIdSchema.optional().describe('Block conversation to join, if any.'),
      text: text('Comment text.'),
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
    input: z.strictObject({
      comment: commentIdSchema,
      text: text('Replacement comment text.'),
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
    input: z.strictObject({
      task: taskKeySchema,
      type: z.enum(BLOCK_TYPES).extract(['dependency', 'external']).describe('Block type.'),
      reason: text('What the task waits for.'),
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
    input: z.strictObject({ block: blockIdSchema }),
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
    ],
  }),
  defineOperation({
    id: 'block.answer',
    kind: 'mutation',
    description: 'Answer a question block; the answer becomes a comment and the block closes.',
    input: z.strictObject({ block: blockIdSchema, text: text('The answer.') }),
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
    input: z.discriminatedUnion('mode', [
      z
        .strictObject({
          mode: z.literal('done').describe('The blocking work is done.'),
          block: blockIdSchema,
          ref: text('What resolved the block, e.g. a commit SHA or a pull request.').optional(),
        })
        .describe('Unblock because the work is done.'),
      z
        .strictObject({
          mode: z.literal('reason').describe('Unblock with an explanation.'),
          block: blockIdSchema,
          reason: text('Why the block no longer applies.'),
        })
        .describe('Unblock with a reason.'),
      z
        .strictObject({
          mode: z
            .literal('withdraw')
            .describe('The author takes their own question back (needs_input only).'),
          block: blockIdSchema,
          answer: text('Answer received outside the board.'),
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
        summary: 'Withdraw a question',
        input: { mode: 'withdraw', block: 'B12', answer: 'Answered outside the board.' },
        output: {
          block: {
            ...question,
            state: 'unblocked',
            outcome: 'withdrawn',
            unblockedBy: 'agent:web/web-7',
            unblockedAt: at,
          },
        },
      },
    ],
  }),
] as const;

export type OperationId = (typeof OPERATIONS)[number]['id'];
