import { OPERATIONS, type RichText } from '@spur-board/contracts';

function line(text: string): RichText[number] {
  return { kind: 'paragraph', children: [{ kind: 'text', text }] };
}

function quote(text: string): RichText[number] {
  return { kind: 'quote', children: [{ kind: 'text', text }] };
}

/** A compact Slack view of the same validated catalog output used by CLI and MCP. */
export function commandReply(
  id: 'status.get' | 'task.get' | 'task.history',
  value: unknown,
  input: unknown,
): { body: RichText; cliHint: string } {
  if (id === 'status.get') {
    const operation = OPERATIONS.find((entry) => entry.id === 'status.get');
    if (operation === undefined) throw new Error('status.get is missing from the catalog');
    const status = operation.output.parse(value);
    return {
      cliHint: `board ${operation.cli.command}`,
      body: [
        line(
          `Board status: ${String(status.tasks.length)} tasks, ${String(status.items.length)} items needing attention.`,
        ),
        // Items first: a long Slack reply is cut from the tail, so task lines drop before items.
        ...status.items.map((item) => line(`${item.key}: ${item.summary}`)),
        ...status.tasks.map((task) => line(`${task.key}: ${task.column} (${task.membership})`)),
        line(
          `Unlinked: ${String(status.unlinkedPrs.length)} pull requests, ${String(status.unlinkedSessions.length)} sessions${
            status.hiddenUnlinkedPrs + status.hiddenUnlinkedSessions === 0
              ? ''
              : `; ${String(status.hiddenUnlinkedPrs)} pull requests and ${String(status.hiddenUnlinkedSessions)} sessions finished over 7 days ago are hidden`
          }.`,
        ),
        ...status.sources.map((source) =>
          line(
            `${source.source}: ${source.blindReason !== null ? `blind (${source.blindReason})` : source.warmingUp ? 'warming up' : source.stale ? 'stale' : 'current'}`,
          ),
        ),
        ...(status.warmingUp ? [line('Sources are warming up.')] : []),
        ...(status.spurUnavailable === null ? [] : [line(status.spurUnavailable)]),
        ...(status.hostLoad === null ? [] : [line(status.hostLoad)]),
      ],
    };
  }
  if (id === 'task.get') {
    const operation = OPERATIONS.find((entry) => entry.id === 'task.get');
    if (operation === undefined) throw new Error('task.get is missing from the catalog');
    const result = operation.output.parse(value);
    const request = operation.input.parse(input);
    return {
      cliHint: `board ${operation.cli.command} ${request.task}`,
      body: [
        line(`Task ${result.task.key}: ${result.task.column} (${result.task.membership})`),
        ...result.blocks.flatMap((block) => [
          line(`Block ${block.id} (${block.state}, ${block.type}):`),
          quote(block.reason),
        ]),
        ...result.comments.flatMap((comment) => [
          line(`Comment ${comment.id} by ${comment.author}:`),
          quote(comment.text),
        ]),
      ],
    };
  }
  const operation = OPERATIONS.find((entry) => entry.id === 'task.history');
  if (operation === undefined) throw new Error('task.history is missing from the catalog');
  const history = operation.output.parse(value);
  const request = operation.input.parse(input);
  return {
    cliHint: `board ${operation.cli.command} ${request.task}`,
    body: [
      line(`Task ${history.task.key} history:`),
      ...history.events.map((event) => line(`${event.at}: ${event.summary} (${event.kind})`)),
    ],
  };
}
