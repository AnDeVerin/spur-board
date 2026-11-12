import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERRORS,
  OPERATIONS,
  roleCanUseOperation,
  type SchemaRole,
} from '../packages/contracts/src/index.ts';
import { createProgram, exampleCommand } from '../packages/cli/src/cli.ts';

export const startMarker = '<!-- BEGIN GENERATED BOARD COMMANDS -->';
export const endMarker = '<!-- END GENERATED BOARD COMMANDS -->';
const target = fileURLToPath(new URL('../packages/skills/spur-board/SKILL.md', import.meta.url));
const referencesDir = fileURLToPath(
  new URL('../packages/skills/spur-board/references/', import.meta.url),
);
const referenceBudget = 8192;
type CatalogOperation = (typeof OPERATIONS)[number];
const roles = ['worker', 'orchestrator'] as const;
const visibleOperations = OPERATIONS.filter((operation) =>
  roles.some((role) => roleCanUseOperation(operation, role)),
);
const commonErrors =
  visibleOperations[0]?.errors.filter((code) =>
    visibleOperations.every((operation) => operation.errors.includes(code)),
  ) ?? [];
const cliByMcpName = new Map(OPERATIONS.map((operation) => [operation.mcp.name, operation]));
const keyStopWords = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'on',
  'after',
  'why',
  'which',
  'ask',
  'acknowledge',
  'leave',
  'correct',
  'wait',
  'escalate',
  'answer',
  'unblock',
  'explain',
  'withdraw',
]);
export interface CommandReference {
  fileName: string;
  commands: string[];
  content: string;
}
const program = createProgram({ io: { isTTY: false, stdout: () => {}, stderr: () => {} } });

function commandFor(path: string) {
  let command = program;
  for (const segment of path.split(' ')) {
    const next = command.commands.find((item) => item.name() === segment);
    if (next === undefined) throw new Error(`Unknown CLI command: ${path}`);
    command = next;
  }
  return command;
}

function flagsFor(operation: CatalogOperation, role: SchemaRole): string[] {
  const allowedModes = new Set(
    operation.cli.modes
      ?.filter((mode) => roleCanUseOperation(operation, role, mode.mode))
      .map((mode) => mode.flag) ?? [],
  );
  const modeFlags = new Set(operation.cli.modes?.map((mode) => mode.flag) ?? []);
  return commandFor(operation.cli.command)
    .options.filter(
      (option) => !modeFlags.has(option.long ?? '') || allowedModes.has(option.long ?? ''),
    )
    .map((option) => option.flags);
}

function exampleFor(
  operation: CatalogOperation,
  role: SchemaRole,
): { command: string; summary: string } {
  const example = operation.examples.find((candidate) => {
    const input = candidate.input as Record<string, unknown>;
    return typeof input['mode'] !== 'string' || roleCanUseOperation(operation, role, input['mode']);
  });
  if (example === undefined) throw new Error(`No ${role} example for ${operation.id}`);
  const input = example.input as Record<string, unknown>;
  const selectedInput = operation.id === 'schema.get' ? { ...input, role } : input;
  const command = exampleCommand(operation, selectedInput);
  const summary =
    operation.id === 'schema.get'
      ? `Describe the operations ${role === 'worker' ? 'a worker' : 'an orchestrator'} may call`
      : example.summary;
  if (operation.kind === 'query') return { command, summary };
  const operationKey = operation.cli.command.replaceAll(' ', '-');
  const meaning = example.summary
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => !keyStopWords.has(word))
    .slice(0, 2)
    .join('-');
  if (!meaning) throw new Error(`Example has no key meaning: ${operation.id}`);
  const key = `${operationKey}-PROJ-123-${meaning}-1432`;
  return { command: `${command} --key ${key}`, summary };
}

function cliGuidance(guidance: string): string {
  return guidance.replace(/\b[a-z][a-z0-9_]*\b/g, (word) => {
    const neighbour = cliByMcpName.get(word);
    if (neighbour === undefined) return word;
    const args = neighbour.cli.args.map((arg) => ` <${arg}>`).join('');
    return `\`board ${neighbour.cli.command}${args}\``;
  });
}

function renderOperation(operation: CatalogOperation): string {
  const visibleRoles = roles.filter((role) => roleCanUseOperation(operation, role));
  const flags = [...new Set(visibleRoles.flatMap((role) => flagsFor(operation, role)))];
  const examples = visibleRoles.map((role) => ({ role, ...exampleFor(operation, role) }));
  const distinctExamples = examples.filter(
    (example, index) => examples.findIndex((item) => item.command === example.command) === index,
  );
  const exampleLines = distinctExamples.map((example) =>
    distinctExamples.length === 1
      ? `Example: \`${example.command}\` — ${example.summary}.`
      : `${example.role === 'worker' ? 'Worker' : 'Orchestrator'} example: \`${example.command}\` — ${example.summary}.`,
  );
  const modes = operation.cli.modes;
  const modeGuidance =
    modes === null
      ? []
      : [
          `Modes by role: ${visibleRoles
            .map(
              (role) =>
                `${role}: ${modes
                  .filter((mode) => roleCanUseOperation(operation, role, mode.mode))
                  .map((mode) => `\`${mode.flag}\``)
                  .join(', ')}`,
            )
            .join('; ')}.`,
        ];
  const ownErrors = operation.errors.filter((code) => !commonErrors.includes(code));
  return [
    `### \`board ${operation.cli.command}\``,
    '',
    `Purpose: ${operation.description}`,
    `Arguments: ${operation.cli.args.length ? operation.cli.args.map((arg) => `\`<${arg}>\``).join(', ') : 'none'}.`,
    `Flags: ${flags.map((flag) => `\`${flag}\``).join(', ')}.`,
    ...modeGuidance,
    `Use when: ${operation.mcp.whenToUse}`,
    `Avoid when: ${cliGuidance(operation.mcp.whenNotToUse)}`,
    ...exampleLines,
    `Other errors: ${ownErrors.length === 0 ? 'none' : ownErrors.map((code) => `\`${code}\``).join(', ')}.`,
  ].join('\n');
}

export function renderCommandReferences(): CommandReference[] {
  const otherErrors = [
    ...new Set(visibleOperations.flatMap((operation) => operation.errors)),
  ].filter((code) => !commonErrors.includes(code));
  const commands = [
    '# Board command reference',
    '',
    'Every command can return the common errors in [errors.md](errors.md). Each entry lists its other codes; their hints are there too.',
    '',
    visibleOperations.map(renderOperation).join('\n\n'),
    '',
  ].join('\n');
  const errors = [
    '# Board error hints',
    '',
    '## Errors every command can return',
    '',
    ...commonErrors.map((code) => `- \`${code}\`: ${ERRORS[code].hint}`),
    '',
    '## Other error hints',
    '',
    ...otherErrors.map((code) => `- \`${code}\`: ${ERRORS[code].hint}`),
    '',
  ].join('\n');
  const references = [
    {
      fileName: 'commands.md',
      commands: visibleOperations.map((operation) => operation.cli.command),
      content: commands,
    },
    { fileName: 'errors.md', commands: [], content: errors },
  ];
  for (const { fileName, content } of references) {
    if (Buffer.byteLength(content) > referenceBudget) {
      throw new Error(
        `Reference ${fileName} is ${String(Buffer.byteLength(content))} bytes; limit is ${String(referenceBudget)}.`,
      );
    }
  }
  return references;
}

export function renderBoardCommands(references = renderCommandReferences()): string {
  return roles
    .map((role) => {
      const heading = role === 'worker' ? 'Worker' : 'Orchestrator';
      const entries = visibleOperations
        .filter((operation) => roleCanUseOperation(operation, role))
        .map((operation) => {
          const command = operation.cli.command;
          const reference = references.find((item) => item.commands.includes(command));
          if (reference === undefined) throw new Error(`No reference for ${operation.id}`);
          return `- [\`board ${command}\`](references/${reference.fileName}#board-${command.replaceAll(' ', '-')})`;
        });
      return `### ${heading}\n\n${entries.join('\n')}`;
    })
    .join('\n\n');
}

export function replaceGeneratedSection(
  skill: string,
  references = renderCommandReferences(),
): string {
  const start = skill.indexOf(startMarker);
  const end = skill.indexOf(endMarker);
  if (start < 0 || end < 0 || start >= end)
    throw new Error('Skill markers are missing or unordered.');
  if (skill.indexOf(startMarker, start + 1) >= 0 || skill.indexOf(endMarker, end + 1) >= 0)
    throw new Error('Skill markers must appear once.');
  return `${skill.slice(0, start + startMarker.length)}\n\n${renderBoardCommands(references)}\n\n${skill.slice(end)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const references = renderCommandReferences();
  const next = replaceGeneratedSection(readFileSync(target, 'utf8'), references);
  writeFileSync(target, next);
  mkdirSync(referencesDir, { recursive: true });
  for (const file of readdirSync(referencesDir)) {
    if (/^(?:worker|orchestrator)-[1-9][0-9]*\.md$|^(?:commands|errors)\.md$/.test(file)) {
      rmSync(join(referencesDir, file));
    }
  }
  for (const reference of references) {
    writeFileSync(join(referencesDir, reference.fileName), reference.content);
  }
  console.log(`wrote product skill and ${String(references.length)} references`);
}
