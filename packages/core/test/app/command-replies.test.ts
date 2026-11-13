import { OPERATIONS } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { commandReply } from '../../src/app/command-replies.ts';

describe('commandReply', () => {
  it('renders each slash-bound operation and uses its matching CLI command', () => {
    const agentReason = ['<!chan', 'nel> *bold*'].join('');
    const statusOperation = OPERATIONS.find((entry) => entry.id === 'status.get');
    const taskOperation = OPERATIONS.find((entry) => entry.id === 'task.get');
    const historyOperation = OPERATIONS.find((entry) => entry.id === 'task.history');
    if (!statusOperation || !taskOperation || !historyOperation) {
      throw new Error('Missing M1 slash operation');
    }

    const status = commandReply('status.get', statusOperation.examples[0].output, {});
    expect(status.cliHint).toBe('board status');
    expect(status.body[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Board status: 1 tasks, 0 items needing attention.' }],
    });
    const unlinked = (text: string) => ({ kind: 'paragraph', children: [{ kind: 'text', text }] });
    expect(status.body).toContainEqual(unlinked('Unlinked: 0 pull requests, 0 sessions.'));
    const hidden = commandReply(
      'status.get',
      { ...statusOperation.examples[0].output, hiddenUnlinkedPrs: 3, hiddenUnlinkedSessions: 200 },
      {},
    );
    expect(hidden.body).toContainEqual(
      unlinked(
        'Unlinked: 0 pull requests, 0 sessions; 3 pull requests and 200 sessions finished over 7 days ago are hidden.',
      ),
    );

    const task = commandReply(
      'task.get',
      {
        ...taskOperation.examples[0].output,
        blocks: taskOperation.examples[0].output.blocks.map((block) => ({
          ...block,
          reason: agentReason,
        })),
      },
      { task: 'PROJ-123' },
    );
    expect(task.cliHint).toBe('board task PROJ-123');
    expect(task.body).toContainEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Block B12 (open, needs_input):' }],
    });
    expect(task.body).toContainEqual({
      kind: 'quote',
      children: [{ kind: 'text', text: agentReason }],
    });
    expect(task.body).toContainEqual({
      kind: 'quote',
      children: [{ kind: 'text', text: 'Target v2.' }],
    });

    const history = commandReply('task.history', historyOperation.examples[0].output, {
      task: 'acme/web#42',
    });
    expect(history.cliHint).toBe('board task history acme/web#42');
    expect(history.body).toContainEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Task acme/web#42 history:' }],
    });
    expect(JSON.stringify(history.body)).toContain('Added to Dev.');
  });

  it('marks the shadow column only on task lines where it differs', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'status.get');
    if (!operation) throw new Error('Missing status.get');
    const example = operation.examples[0].output;
    const [row] = example.tasks;
    if (row === undefined) throw new Error('Missing the status example row');
    const reply = commandReply(
      'status.get',
      {
        ...example,
        tasks: [
          { ...row, key: 'o/r#9', column: 'todo', shadowColumn: 'review', shadowDiffers: true },
          { ...row, key: 'o/r#10', column: 'dev', shadowColumn: 'dev', shadowDiffers: false },
          { ...row, key: 'o/r#11', column: 'review' },
        ],
      },
      {},
    );
    const paragraph = (text: string) => ({ kind: 'paragraph', children: [{ kind: 'text', text }] });
    expect(reply.body.slice(1, 4)).toEqual([
      paragraph('o/r#9: todo, shadow review (active)'),
      paragraph('o/r#10: dev (active)'),
      paragraph('o/r#11: review (active)'),
    ]);
  });

  it('renders the status reply without shadow marks when rows have no shadow fields', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'status.get');
    if (!operation) throw new Error('Missing status.get');
    expect(commandReply('status.get', operation.examples[0].output, {}).body)
      .toMatchInlineSnapshot(`
        [
          {
            "children": [
              {
                "kind": "text",
                "text": "Board status: 1 tasks, 0 items needing attention.",
              },
            ],
            "kind": "paragraph",
          },
          {
            "children": [
              {
                "kind": "text",
                "text": "PROJ-123: dev (active)",
              },
            ],
            "kind": "paragraph",
          },
          {
            "children": [
              {
                "kind": "text",
                "text": "Unlinked: 0 pull requests, 0 sessions.",
              },
            ],
            "kind": "paragraph",
          },
          {
            "children": [
              {
                "kind": "text",
                "text": "Sources are warming up.",
              },
            ],
            "kind": "paragraph",
          },
        ]
      `);
  });

  it('renders the why explanation with failing conditions first and the passing gates', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'task.get');
    if (!operation) throw new Error('Missing task.get');
    const explained = operation.examples[1];
    if (explained === undefined) throw new Error('Missing the why example');
    const example = operation.output.parse(explained.output);
    if (example.why === undefined) throw new Error('Missing the why example');
    const correction = ['<!chan', 'nel> wrong PR'].join('');
    const reply = commandReply(
      'task.get',
      {
        ...example,
        blocks: [
          { ...operation.examples[0].output.blocks[0], reason: 'Which API version?' },
          {
            ...operation.examples[0].output.blocks[0],
            id: 'B13',
            state: 'unblocked',
            reason: 'Old question.',
          },
        ],
        why: {
          ...example.why,
          holds: ['spur_blind'],
          moves: [
            ...example.why.moves,
            {
              at: '2026-01-05T09:31:00.000Z',
              kind: 'task_corrected',
              actor: 'operator',
              from: 'review',
              to: 'dev',
              reason: 'corrected',
              gate: [],
              text: correction,
            },
            {
              at: '2026-01-05T09:31:00.000Z',
              kind: 'task_moved',
              actor: 'agent:rev/rev-1',
              from: 'review',
              to: 'dev',
              reason: 'returned',
              gate: [],
              text: 'B13',
            },
          ],
        },
      },
      { task: 'PROJ-123', why: true },
    );
    expect(reply.cliHint).toBe('board task PROJ-123 --why');
    const text = (value: string) => ({
      kind: 'paragraph',
      children: [{ kind: 'text', text: value }],
    });
    const quoted = (value: string) => ({
      kind: 'quote',
      children: [{ kind: 'text', text: value }],
    });
    expect(reply.body).toEqual([
      text('Task PROJ-123 is in review.'),
      text('Held: spur_blind.'),
      text('review: review_on_head failed (no_review_on_head)'),
      text('Gates passing: todo, dev, done.'),
      text('The review gate is blocked at review.'),
      text('Turn T4 (review, orchestrator:review): taken by agent:rev/rev-1.'),
      text('Open block B12 (needs_input):'),
      quoted('Which API version?'),
      text('2026-01-05T09:30:00.000Z: dev to review (gate_passed)'),
      text('2026-01-05T09:31:00.000Z: review to dev (corrected)'),
      quoted(correction),
      text('2026-01-05T09:31:00.000Z: review to dev (returned B13)'),
    ]);
  });

  it('lists every condition of a failing gate, so a task with no PR shows unchecked Dev checks', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'task.get');
    if (!operation) throw new Error('Missing task.get');
    const explained = operation.examples[1];
    if (explained === undefined) throw new Error('Missing the why example');
    const example = operation.output.parse(explained.output);
    if (example.why === undefined) throw new Error('Missing the why example');
    const unchecked = (condition: 'not_draft' | 'checks_green' | 'no_conflict') => ({
      condition,
      state: 'unchecked' as const,
      reason: null,
    });
    const reply = commandReply(
      'task.get',
      {
        ...example,
        blocks: [],
        why: {
          ...example.why,
          column: 'dev',
          turn: null,
          moves: [],
          gates: [
            { column: 'todo', enabled: true, ok: true, blockedIn: null, conditions: [] },
            {
              column: 'dev',
              enabled: true,
              ok: false,
              blockedIn: 'dev',
              conditions: [
                unchecked('not_draft'),
                { condition: 'pr_open', state: 'failed', reason: 'no_pr' },
                { condition: 'comment_history_read', state: 'met', reason: null },
                unchecked('checks_green'),
                { condition: 'submit_on_head', state: 'waiting', reason: 'checks_pending' },
                unchecked('no_conflict'),
              ],
            },
            {
              column: 'review',
              enabled: false,
              ok: false,
              blockedIn: 'dev',
              conditions: [
                { condition: 'review_on_head', state: 'failed', reason: 'no_review_on_head' },
              ],
            },
          ],
        },
      },
      { task: 'PROJ-123', why: true },
    );
    const text = (value: string) => ({
      kind: 'paragraph',
      children: [{ kind: 'text', text: value }],
    });
    expect(reply.body).toEqual([
      text('Task PROJ-123 is in dev.'),
      text(
        'dev: pr_open failed (no_pr), submit_on_head waiting (checks_pending), not_draft unchecked, checks_green unchecked, no_conflict unchecked, comment_history_read met',
      ),
      text('Gates passing: todo.'),
      text('The dev gate is blocked at dev.'),
      text('No open turn.'),
    ]);
  });

  it('puts status items right after the header, ahead of every task line', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'status.get');
    if (!operation) throw new Error('Missing status.get');
    const example = operation.examples[0].output;
    const [task] = example.tasks;
    if (!task) throw new Error('Missing example task');
    const item = (id: string, summary: string) => ({
      id,
      task: null,
      at: '2026-11-04T12:00:00.000Z',
      summary,
      key: `ITEM-${id}`,
      unconfirmed: false,
      factAt: null,
    });
    const status = commandReply(
      'status.get',
      {
        ...example,
        tasks: Array.from({ length: 60 }, (_, index) => ({
          ...task,
          key: `TASK-${String(index + 1)}`,
        })),
        items: [item('I1', 'Worker ended without a PR'), item('I2', 'Inbound gap on C_ORCH')],
      },
      {},
    );
    const paragraph = (text: string) => ({ kind: 'paragraph', children: [{ kind: 'text', text }] });
    expect(status.body.slice(1, 3)).toEqual([
      paragraph('ITEM-I1: Worker ended without a PR'),
      paragraph('ITEM-I2: Inbound gap on C_ORCH'),
    ]);
    const isTask = (block: unknown) => JSON.stringify(block).includes('"text":"TASK-');
    expect(status.body.findIndex(isTask)).toBeGreaterThan(2);
    expect(status.body.filter(isTask)).toHaveLength(60);
  });
});
