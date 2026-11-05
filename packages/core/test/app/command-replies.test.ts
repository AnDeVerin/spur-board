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
});
