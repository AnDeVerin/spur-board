import { OPERATIONS, type RichText } from '@spur-board/contracts';
import type { z } from 'zod';

function line(text: string): RichText[number] {
  return { kind: 'paragraph', children: [{ kind: 'text', text }] };
}

function quote(text: string): RichText[number] {
  return { kind: 'quote', children: [{ kind: 'text', text }] };
}

type TaskGet = z.output<Extract<(typeof OPERATIONS)[number], { id: 'task.get' }>['output']>;

/**
 * The why reply: the column and holds, each enabled column whose own conditions fail, the
 * waiver, the open turn, the open blocks and the last moves. Agent and operator text is quoted.
 */
function whyLines(
  key: string,
  why: NonNullable<TaskGet['why']>,
  blocks: TaskGet['blocks'],
): RichText {
  const mode =
    why.dispatcher === null
      ? ' (project not configured)'
      : why.dispatcher === 'shadow'
        ? ' (shadow)'
        : '';
  const here = why.gates.find((gate) => gate.column === why.column);
  const turn = why.turn;
  return [
    line(`Task ${key} is in ${why.column}${mode}.`),
    ...(why.holds.length === 0 ? [] : [line(`Held: ${why.holds.join(', ')}.`)]),
    ...why.gates
      .filter((gate) => gate.enabled && !gate.ok)
      .map((gate) =>
        line(
          `${gate.column}: ${gate.conditions
            .filter((condition) => condition.state === 'failed' || condition.state === 'waiting')
            .map(
              (condition) =>
                `${condition.condition} ${condition.state} (${condition.reason ?? 'unknown'})`,
            )
            .join(', ')}`,
        ),
      ),
    ...(here === undefined
      ? []
      : [
          line(
            here.blockedIn === null
              ? `The ${why.column} gate passes.`
              : `The ${why.column} gate is blocked at ${here.blockedIn}.`,
          ),
        ]),
    ...(why.checksWaivedBy === null
      ? []
      : [line(`Dev checks are waived by ${why.checksWaivedBy}.`)]),
    line(
      turn === null
        ? 'No open turn.'
        : `Turn ${turn.id} (${turn.column}, ${turn.addressee}): ${turn.taken === null ? 'not taken' : `taken by ${turn.taken.by}`}.`,
    ),
    ...blocks
      .filter((block) => block.state === 'open')
      .flatMap((block) => [line(`Open block ${block.id} (${block.type}):`), quote(block.reason)]),
    ...why.moves.flatMap((move) => {
      const gate = move.gate.length === 0 ? '' : `: ${move.gate.join(', ')}`;
      const text = move.reason === 'returned' && move.text !== null ? ` ${move.text}` : '';
      const moved = line(`${move.at}: ${move.from} to ${move.to} (${move.reason}${text}${gate})`);
      return move.reason === 'corrected' && move.text !== null
        ? [moved, quote(move.text)]
        : [moved];
    }),
  ];
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
    if (request.why === true && result.why !== undefined) {
      return {
        cliHint: `board ${operation.cli.command} ${request.task} --why`,
        body: whyLines(result.task.key, result.why, result.blocks),
      };
    }
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
