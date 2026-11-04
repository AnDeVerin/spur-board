import { OPERATIONS, type RichText } from '@spur-board/contracts';

function line(text: string): RichText[number] {
  return { kind: 'paragraph', children: [{ kind: 'text', text }] };
}

/** A compact Slack view of the same validated catalog output used by CLI and MCP. */
export function commandReply(
  id: 'status.get' | 'task.get' | 'task.history',
  value: unknown,
): RichText {
  if (id === 'status.get') {
    const status = OPERATIONS[0].output.parse(value);
    return [
      line(
        `Board status: ${String(status.tasks.length)} tasks, ${String(status.items.length)} items needing attention.`,
      ),
      ...status.tasks.map((task) => line(`${task.key}: ${task.column} (${task.membership})`)),
      ...status.items.map((item) => line(`${item.key}: ${item.summary}`)),
      line(
        `Unlinked: ${String(status.unlinkedPrs.length)} pull requests, ${String(status.unlinkedSessions.length)} sessions.`,
      ),
      ...status.sources.map((source) =>
        line(
          `${source.source}: ${source.blindReason !== null ? `blind (${source.blindReason})` : source.warmingUp ? 'warming up' : source.stale ? 'stale' : 'current'}`,
        ),
      ),
      ...(status.warmingUp ? [line('Sources are warming up.')] : []),
      ...(status.spurUnavailable === null ? [] : [line(status.spurUnavailable)]),
      ...(status.hostLoad === null ? [] : [line(status.hostLoad)]),
    ];
  }
  if (id === 'task.get') {
    const result = OPERATIONS[1].output.parse(value);
    return [
      line(`Task ${result.task.key}: ${result.task.column} (${result.task.membership})`),
      ...result.blocks.map((block) => line(`Block ${block.id} (${block.state}): ${block.reason}`)),
      ...result.comments.flatMap((comment) => [
        line(`Comment ${comment.id} by ${comment.author}:`),
        { kind: 'quote' as const, children: [{ kind: 'text' as const, text: comment.text }] },
      ]),
    ];
  }
  const history = OPERATIONS[2].output.parse(value);
  return [
    line(`Task ${history.task.key} history:`),
    ...history.events.map((event) => line(`${event.at}: ${event.summary} (${event.kind})`)),
  ];
}
