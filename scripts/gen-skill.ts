import { readFileSync, writeFileSync } from 'node:fs';
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
type CatalogOperation = (typeof OPERATIONS)[number];
const roles = ['worker', 'orchestrator'] as const;
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
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const key = `${operationKey}-PROJ-123-${meaning}-${role}-1432`;
  return { command: `${command} --key ${key}`, summary };
}

function renderOperation(operation: CatalogOperation, role: SchemaRole): string {
  const errors = operation.errors.map((code) => `- \`${code}\`: ${ERRORS[code].hint}`).join('\n');
  const example = exampleFor(operation, role);
  return [
    `#### \`board ${operation.cli.command}\``,
    '',
    `Purpose: ${operation.description}`,
    `Arguments: ${operation.cli.args.length ? operation.cli.args.map((arg) => `\`<${arg}>\``).join(', ') : 'none'}.`,
    `Flags: ${flagsFor(operation, role)
      .map((flag) => `\`${flag}\``)
      .join(', ')}.`,
    `Use when: ${operation.mcp.whenToUse}`,
    `Avoid when: ${operation.mcp.whenNotToUse}`,
    `Example: \`${example.command}\` — ${example.summary}.`,
    'Errors:',
    '',
    errors,
  ].join('\n');
}

export function renderBoardCommands(): string {
  return roles
    .map((role) => {
      const operations = OPERATIONS.filter((operation) => roleCanUseOperation(operation, role));
      const heading = role === 'worker' ? 'Worker' : 'Orchestrator';
      return `### ${heading}\n\n${operations.map((operation) => renderOperation(operation, role)).join('\n\n')}`;
    })
    .join('\n\n');
}

export function replaceGeneratedSection(skill: string): string {
  const start = skill.indexOf(startMarker);
  const end = skill.indexOf(endMarker);
  if (start < 0 || end < 0 || start >= end)
    throw new Error('Skill markers are missing or unordered.');
  if (skill.indexOf(startMarker, start + 1) >= 0 || skill.indexOf(endMarker, end + 1) >= 0)
    throw new Error('Skill markers must appear once.');
  return `${skill.slice(0, start + startMarker.length)}\n\n${renderBoardCommands()}\n\n${skill.slice(end)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = replaceGeneratedSection(readFileSync(target, 'utf8'));
  writeFileSync(target, next);
  console.log('wrote packages/skills/spur-board/SKILL.md');
}
