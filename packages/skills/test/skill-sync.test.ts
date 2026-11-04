import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ERRORS,
  OPERATIONS,
  roleCanUseOperation,
  type SchemaRole,
} from '../../contracts/src/index.ts';
import { createProgram } from '../../cli/src/cli.ts';
import { endMarker, replaceGeneratedSection, startMarker } from '../../../scripts/gen-skill.ts';

const skillPath = fileURLToPath(new URL('../spur-board/SKILL.md', import.meta.url));
const skill = readFileSync(skillPath, 'utf8');
const operations = [...OPERATIONS].sort(
  (left, right) => right.cli.command.split(' ').length - left.cli.command.split(' ').length,
);
const program = createProgram({ io: { isTTY: false, stdout: () => {}, stderr: () => {} } });

function tokens(command: string): string[] {
  return command.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];
}

function commandFor(path: string) {
  let command = program;
  for (const segment of path.split(' ')) {
    const next = command.commands.find((candidate) => candidate.name() === segment);
    if (next === undefined) throw new Error(`Missing registered command: ${path}`);
    command = next;
  }
  return command;
}

function operationFor(command: string) {
  const words = tokens(command);
  if (words[0] !== 'board') return undefined;
  return operations.find((operation) =>
    operation.cli.command.split(' ').every((segment, index) => words[index + 1] === segment),
  );
}

function invocations(text: string): { command: string; example: boolean }[] {
  const found: { command: string; example: boolean }[] = [];
  const fenced = /```(?:sh|bash|shell)?\n([\s\S]*?)```/g;
  const withoutFences = text.replace(fenced, (_match, body: string) => {
    for (const line of body.split('\n')) {
      const command = line.trim().replace(/^\$\s*/, '');
      if (command.startsWith('board ')) found.push({ command, example: true });
    }
    return ' ';
  });
  const inline = /`([^`\n]+)`/g;
  const prose = withoutFences.replace(inline, (_match, content: string, offset: number) => {
    if (content.startsWith('board ')) {
      const lineStart = withoutFences.lastIndexOf('\n', offset) + 1;
      const line = withoutFences.slice(lineStart, offset);
      found.push({ command: content, example: /Example:\s*$/.test(line) });
    }
    return ' ';
  });
  const withoutNouns = prose
    .replace(/\ba board overview\b/g, 'a Board overview')
    .replace(/\bfor board data\b/g, 'for Board data')
    .replace(/\bthe board again\b/g, 'the Board again');
  if (/\bboard[ \t]+[a-z]/.test(withoutNouns)) {
    found.push({ command: 'unformatted board invocation', example: false });
  }
  return found;
}

function validateInvocations(text: string): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const { command, example } of invocations(text)) {
    if (command === 'unformatted board invocation') {
      errors.push(command);
      continue;
    }
    const operation = operationFor(command);
    if (operation === undefined) {
      errors.push(`unknown command: ${command}`);
      continue;
    }
    const words = tokens(command);
    const commandWords = operation.cli.command.split(' ');
    const tail = words.slice(commandWords.length + 1);
    const registeredFlags = new Set(
      commandFor(operation.cli.command).options.map((option) => option.long),
    );
    for (const flag of tail
      .filter((word) => word.startsWith('--'))
      .map((word) => word.split('=')[0] ?? word)) {
      if (!registeredFlags.has(flag)) errors.push(`unknown flag: ${flag}`);
    }
    if (operation.kind === 'mutation' && example) {
      const keyIndex = tail.indexOf('--key');
      const key = tail[keyIndex + 1];
      const prefix = operation.cli.command.replaceAll(' ', '-');
      if (
        keyIndex < 0 ||
        key === undefined ||
        !new RegExp(
          `^${prefix}-[A-Z][A-Z0-9]*-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-(?:[01][0-9]|2[0-3])[0-5][0-9]$`,
        ).test(key)
      ) {
        errors.push(`invalid key: ${command}`);
      } else if (keys.has(key)) {
        errors.push(`duplicate key: ${key}`);
      } else {
        keys.add(key);
      }
    }
  }
  return errors;
}

function roleSection(role: SchemaRole): string {
  const generated = skill.slice(skill.indexOf(startMarker), skill.indexOf(endMarker));
  const worker = generated.indexOf('### Worker');
  const orchestrator = generated.indexOf('### Orchestrator');
  return role === 'worker' ? generated.slice(worker, orchestrator) : generated.slice(orchestrator);
}

describe('product skill sync', () => {
  it('keeps the marked command section equal to fresh generation', () => {
    expect(replaceGeneratedSection(skill)).toBe(skill);
  });

  it.each(['worker', 'orchestrator'] as const)('lists only %s grants with CLI metadata', (role) => {
    const section = roleSection(role);
    const expected = OPERATIONS.filter((operation) => roleCanUseOperation(operation, role));
    expect([...section.matchAll(/^#### `board ([^`]+)`$/gm)].map((match) => match[1])).toEqual(
      expected.map((operation) => operation.cli.command),
    );
    for (const operation of expected) {
      const title = `#### \`board ${operation.cli.command}\``;
      const start = section.indexOf(title);
      const end = section.indexOf('\n#### ', start + title.length);
      const block = section.slice(start, end < 0 ? undefined : end);
      expect(block).toContain(`Purpose: ${operation.description}`);
      expect(block).toContain(`Use when: ${operation.mcp.whenToUse}`);
      expect(block).toContain(`Avoid when: ${operation.mcp.whenNotToUse}`);
      expect(block).toMatch(/Example: `board /);
      for (const code of operation.errors) {
        expect(block).toContain(`\`${code}\``);
        expect(block).toContain(ERRORS[code].hint);
      }
      const flags = block.match(/^Flags: (.+)\.$/m)?.[1] ?? '';
      for (const option of commandFor(operation.cli.command).options) {
        const mode = operation.cli.modes?.find((item) => item.flag === option.long);
        const allowed = mode === undefined || roleCanUseOperation(operation, role, mode.mode);
        expect(flags.includes(`\`${option.flags}\``)).toBe(allowed);
      }
      const example = block.match(/^Example: `([^`]+)`/m)?.[1] ?? '';
      if (operation.id === 'schema.get') {
        expect(block).toContain(
          `Describe the operations ${role === 'worker' ? 'a worker' : 'an orchestrator'} may call`,
        );
      }
      for (const mode of operation.cli.modes ?? []) {
        if (tokens(example).includes(mode.flag)) {
          expect(roleCanUseOperation(operation, role, mode.mode)).toBe(true);
        }
      }
    }
  });

  it('validates every invocation and mutation example in the whole skill', () => {
    expect(validateInvocations(skill)).toEqual([]);
    expect(invocations(skill).length).toBeGreaterThan(40);
  });

  it('rejects a renamed flag, missing or malformed key, invalid command, and bare prose call', () => {
    expect(
      validateInvocations(
        skill.replace('`board schema --role worker --json`', '`board schema --roel worker --json`'),
      ),
    ).toContain('unknown flag: --roel');
    const example = /Example: `board inbox ack ([^`]+)`/;
    expect(
      validateInvocations(
        skill.replace(
          example,
          (_full, body: string) => `Example: \`board inbox ack ${body.replace(/ --key \S+/, '')}\``,
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    expect(
      validateInvocations(
        skill.replace(
          example,
          (_full, body: string) =>
            `Example: \`board inbox ack ${body.replace(/--key \S+/, '--key bad')}\``,
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    expect(validateInvocations(`${skill}\n\`board no-such-command\`\n`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^unknown command:/)]),
    );
    expect(validateInvocations(`${skill}\nRun board no-such-command today.\n`)).toContain(
      'unformatted board invocation',
    );
    expect(validateInvocations(`${skill}\nDo board no-such-command today.\n`)).toContain(
      'unformatted board invocation',
    );
    expect(
      validateInvocations(`${skill}\n\`\`\`sh\nboard schema --roel worker\n\`\`\`\n`),
    ).toContain('unknown flag: --roel');
  });
});
