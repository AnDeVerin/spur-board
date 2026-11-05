import { OPERATIONS, type InboundEvent } from '@spur-board/contracts';

type Command = Extract<InboundEvent, { kind: 'command' }>['command'];
type QueryId = Extract<Command, { kind: 'query' }>['id'];

/** The catalog's slash bindings are the parser and help text's single source. */
function descriptors(commandName: string) {
  return OPERATIONS.filter(
    (operation) => operation.kind === 'query' && operation.slack?.kind === 'slash-command',
  ).map((operation) => ({
    operation,
    usage:
      operation.slack?.kind === 'slash-command'
        ? operation.slack.usage.replace(/^\/\S+/, commandName)
        : '',
  }));
}

export function commandUsage(commandName: string): string {
  return `Usage:\n${descriptors(commandName)
    .map(({ usage }) => usage)
    .join('\n')}`;
}

export function parseCommand(text: string, commandName: string): Command {
  const usage = (): Command => ({ kind: 'usage', text: commandUsage(commandName) });
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: 'query', id: 'status.get', input: {} };
  for (const { operation, usage: form } of descriptors(commandName)) {
    const pattern = form.slice(commandName.length).trim().split(/\s+/);
    if (pattern.length !== parts.length) continue;
    const input: Record<string, string> = {};
    const matches = pattern.every((piece, index) => {
      const value = parts[index];
      if (value === undefined) return false;
      if (piece === '<KEY>') {
        const field = operation.cli.args[0];
        if (field === undefined) return false;
        input[field] = value;
        return true;
      }
      return piece === value;
    });
    if (!matches || !operation.input.safeParse(input).success) continue;
    return { kind: 'query', id: operation.id as QueryId, input };
  }
  return usage();
}
