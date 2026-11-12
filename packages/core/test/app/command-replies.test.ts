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
