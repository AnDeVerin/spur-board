import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ERRORS,
  OPERATIONS,
  roleCanUseOperation,
  type SchemaRole,
} from '../../contracts/src/index.ts';
import { createProgram } from '../../cli/src/cli.ts';
import {
  endMarker,
  renderCommandReferences,
  replaceGeneratedSection,
  startMarker,
} from '../../../scripts/gen-skill.ts';

const skillPath = fileURLToPath(new URL('../spur-board/SKILL.md', import.meta.url));
const setupSkillPath = fileURLToPath(new URL('../setup/SKILL.md', import.meta.url));
const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));
const setupGuidePath = fileURLToPath(new URL('../../../SETUP.md', import.meta.url));
const troubleshootingPath = fileURLToPath(new URL('../../../TROUBLESHOOTING.md', import.meta.url));
const runbookPath = fileURLToPath(new URL('../../../docs/runbook.md', import.meta.url));
const setupReferencesPath = fileURLToPath(new URL('../setup/references/', import.meta.url));
const binaryPath = fileURLToPath(new URL('../../cli/src/bin.mjs', import.meta.url));
const referencesPath = fileURLToPath(new URL('../spur-board/references/', import.meta.url));
const skill = readFileSync(skillPath, 'utf8');
const setupSkill = readFileSync(setupSkillPath, 'utf8');
const publicGuides = [readmePath, setupGuidePath, troubleshootingPath, runbookPath].map((path) =>
  readFileSync(path, 'utf8'),
);
const setupReferenceNames = ['secrets.md', 'slack.md', 'update.md', 'worker-links.md'];
const setupReferenceTexts = setupReferenceNames.map((name) =>
  readFileSync(new URL(`../setup/references/${name}`, import.meta.url), 'utf8'),
);
const setupFullText = [setupSkill, ...setupReferenceTexts].join('\n');
const binarySource = readFileSync(binaryPath, 'utf8');
const references = renderCommandReferences();
const referenceTexts = references.map((reference) =>
  readFileSync(new URL(`../spur-board/references/${reference.fileName}`, import.meta.url), 'utf8'),
);
const referenceText = referenceTexts.join('\n');
const fullText = [skill, ...referenceTexts].join('\n');
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
  const fenced = /```([^\n]*)\n([\s\S]*?)```/g;
  const withoutFences = text.replace(fenced, (_match, language: string, body: string) => {
    if (['', 'sh', 'bash', 'shell'].includes(language.trim())) {
      for (const line of body.split('\n')) {
        const command = line.trim().replace(/^\$\s*/, '');
        if (command.startsWith('board ')) found.push({ command, example: true });
      }
    }
    return ' ';
  });
  const inline = /`([^`\n]+)`/g;
  const prose = withoutFences.replace(inline, (_match, content: string, offset: number) => {
    if (content.startsWith('board ')) {
      const lineStart = withoutFences.lastIndexOf('\n', offset) + 1;
      const line = withoutFences.slice(lineStart, offset);
      found.push({
        command: content,
        example: /(?:Example:|for example[, :]?)\s*$/i.test(line),
      });
    }
    return ' ';
  });
  const withoutNouns = prose
    .replace(/\bspur-board\b/g, 'Spur Board')
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
    const hasPlaceholder = tail.some((word) => /^<[^>]+>$/.test(word));
    if (operation.kind === 'mutation' && (example || (tail.length > 0 && !hasPlaceholder))) {
      const keyIndex = tail.indexOf('--key');
      const key = tail[keyIndex + 1];
      const prefix = operation.cli.command.replaceAll(' ', '-');
      if (
        keyIndex < 0 ||
        key === undefined ||
        !new RegExp(
          `^${prefix}-[A-Z][A-Z0-9]*-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)?-(?:[01][0-9]|2[0-3])[0-5][0-9]$`,
        ).test(key) ||
        /-(?:worker|orchestrator)-/.test(key)
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

function binaryCommands(source: string): Set<string> {
  const commands = new Set<string>();
  for (const match of source.matchAll(
    /(?:^|\n)(?:if|} else if) \(argv\.length === 1 && ([^\n]+)\) \{/g,
  )) {
    for (const route of match[1]?.matchAll(/argv\[0\] === '([^']+)'/g) ?? []) {
      if (route[1] !== undefined) commands.add(route[1]);
    }
  }
  return commands;
}

function validateSetupInvocations(text: string, dispatcher = binarySource): string[] {
  const errors: string[] = [];
  const directCommands = binaryCommands(dispatcher);
  for (const { command } of invocations(text)) {
    if (command === 'unformatted board invocation') {
      errors.push(command);
      continue;
    }
    const words = tokens(command);
    if (words.length === 2 && words[1] !== undefined && directCommands.has(words[1])) continue;
    let registered = program;
    let index = 1;
    while (index < words.length) {
      const next = registered.commands.find((candidate) => candidate.name() === words[index]);
      if (next === undefined) break;
      registered = next;
      index++;
    }
    if (index === 1 || registered.commands.length > 0) {
      errors.push(`unknown command: ${command}`);
      continue;
    }
    const flags = new Set([...registered.options, ...program.options].map((option) => option.long));
    for (const flag of words
      .slice(index)
      .filter((word) => word.startsWith('--'))
      .map((word) => word.split('=')[0] ?? word)) {
      if (!flags.has(flag)) errors.push(`unknown flag: ${flag}`);
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
  it('keeps the skill and bounded references equal to fresh generation', () => {
    expect(replaceGeneratedSection(skill)).toBe(skill);
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(5120);
    expect(references.map((reference) => reference.fileName)).toEqual(['commands.md']);
    expect(readdirSync(referencesPath).sort()).toEqual(
      references.map((reference) => reference.fileName).sort(),
    );
    for (const [index, reference] of references.entries()) {
      expect(referenceTexts[index]).toBe(reference.content);
      expect(Buffer.byteLength(reference.content)).toBeLessThanOrEqual(8192);
    }
  });

  it.each(['worker', 'orchestrator'] as const)('indexes exactly the %s grants', (role) => {
    const section = roleSection(role);
    const expected = OPERATIONS.filter((operation) => roleCanUseOperation(operation, role));
    expect(
      [...section.matchAll(/^- `board ([^`]+)` — \[details\]/gm)].map((match) => match[1]),
    ).toEqual(expected.map((operation) => operation.cli.command));
    for (const operation of expected)
      expect(section).toContain(
        `references/commands.md#board-${operation.cli.command.replaceAll(' ', '-')}`,
      );
  });

  it('renders each command once with CLI guidance, role modes, and shared error hints', () => {
    const agentRoles = ['worker', 'orchestrator'] as const;
    const visible = OPERATIONS.filter((operation) =>
      agentRoles.some((role) => roleCanUseOperation(operation, role)),
    );
    expect([...referenceText.matchAll(/^### `board ([^`]+)`$/gm)].map((match) => match[1])).toEqual(
      visible.map((operation) => operation.cli.command),
    );
    const common = visible[0]?.errors.filter((code) =>
      visible.every((operation) => operation.errors.includes(code)),
    );
    const commonSection = referenceText.slice(
      referenceText.indexOf('## Errors every command can return'),
      referenceText.indexOf('## Other error hints'),
    );
    for (const code of common ?? []) {
      expect(commonSection).toContain(`\`${code}\`: ${ERRORS[code].hint}`);
      expect(referenceText.split(`\`${code}\`: ${ERRORS[code].hint}`).length - 1).toBe(1);
    }
    for (const operation of visible) {
      const title = `### \`board ${operation.cli.command}\``;
      const start = referenceText.indexOf(title);
      const end = referenceText.indexOf('\n### ', start + title.length);
      const block = referenceText.slice(start, end < 0 ? undefined : end);
      expect(block).toContain(`Purpose: ${operation.description}`);
      expect(block).toContain(`Use when: ${operation.mcp.whenToUse}`);
      expect(block).toContain('Avoid when: Use `board ');
      expect(block).toMatch(/(?:Example|Worker example|Orchestrator example): `board /);
      for (const code of operation.errors)
        expect(referenceText).toContain(`\`${code}\`: ${ERRORS[code].hint}`);
      const ownErrors = operation.errors.filter((code) => !(common ?? []).includes(code));
      expect(block).toContain(
        `Other errors: ${ownErrors.length === 0 ? 'none' : ownErrors.map((code) => `\`${code}\``).join(', ')}.`,
      );
      const flags = block.match(/^Flags: (.+)\.$/m)?.[1] ?? '';
      for (const option of commandFor(operation.cli.command).options) {
        const mode = operation.cli.modes?.find((item) => item.flag === option.long);
        const allowed =
          mode === undefined ||
          agentRoles.some((role) => roleCanUseOperation(operation, role, mode.mode));
        expect(flags.includes(`\`${option.flags}\``)).toBe(allowed);
      }
      if (operation.id === 'schema.get') {
        expect(block).toContain('board schema --role worker');
        expect(block).toContain('board schema --role orchestrator');
      }
      for (const role of agentRoles) {
        if (!roleCanUseOperation(operation, role)) continue;
        for (const mode of operation.cli.modes ?? []) {
          const roleModes = block.match(new RegExp(`${role}: ([^;\\n]+)`))?.[1] ?? '';
          expect(roleModes.includes(`\`${mode.flag}\``)).toBe(
            roleCanUseOperation(operation, role, mode.mode),
          );
        }
      }
      for (const match of block.matchAll(/^(Worker|Orchestrator) example: `([^`]+)`/gm)) {
        const role = match[1] === 'Worker' ? 'worker' : 'orchestrator';
        const command = match[2] ?? '';
        for (const mode of operation.cli.modes ?? []) {
          if (tokens(command).includes(mode.flag)) {
            expect(roleCanUseOperation(operation, role, mode.mode)).toBe(true);
          }
        }
      }
    }
    for (const operation of OPERATIONS)
      expect(referenceText).not.toMatch(new RegExp(`\\b${operation.mcp.name}\\b`));
    for (const line of referenceText.split('\n').filter((line) => line.startsWith('Avoid when:')))
      expect(line).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b/);
  });

  it('validates every invocation and mutation example in the whole skill', () => {
    expect(validateInvocations(fullText)).toEqual([]);
    expect(invocations(fullText).length).toBeGreaterThan(40);
  });

  it('tells workers how to link their session', () => {
    expect(skill).toContain('--link board-worker=');
    expect(skill).toContain('`board link`');
  });

  it('gives workers operator-safe recovery for archived tasks', () => {
    expect(ERRORS.task_archived.hint).toContain('Ask an operator');
    expect(referenceText).toContain(`\`task_archived\`: ${ERRORS.task_archived.hint}`);
  });

  it('rejects a renamed flag, missing or malformed key, invalid command, and bare prose call', () => {
    expect(
      validateInvocations(
        fullText.replace(
          '`board schema --role worker --json`',
          '`board schema --roel worker --json`',
        ),
      ),
    ).toContain('unknown flag: --roel');
    const example = /Example: `board inbox ack ([^`]+)`/;
    expect(
      validateInvocations(
        fullText.replace(
          example,
          (_full, body: string) => `Example: \`board inbox ack ${body.replace(/ --key \S+/, '')}\``,
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    expect(
      validateInvocations(
        fullText.replace(
          example,
          (_full, body: string) =>
            `Example: \`board inbox ack ${body.replace(/--key \S+/, '--key bad')}\``,
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    expect(validateInvocations(`${fullText}\n\`board no-such-command\`\n`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^unknown command:/)]),
    );
    expect(validateInvocations(`${fullText}\nRun board no-such-command today.\n`)).toContain(
      'unformatted board invocation',
    );
    expect(validateInvocations(`${fullText}\nDo board no-such-command today.\n`)).toContain(
      'unformatted board invocation',
    );
    expect(
      validateInvocations(`${fullText}\n\`\`\`sh\nboard schema --roel worker\n\`\`\`\n`),
    ).toContain('unknown flag: --roel');
    expect(
      validateInvocations(`${fullText}\nFor example, \`board ask PROJ-123 "Which version?"\`.\n`),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    expect(
      validateInvocations(`${fullText}\nTry \`board ask PROJ-123 "Which version?"\`.\n`),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
    const key = fullText.match(/inbox-ack-PROJ-123-[a-z-]+-1432/)?.[0] ?? '';
    expect(key).not.toBe('');
    expect(
      validateInvocations(fullText.replace(key, key.replace(/-1432$/, '-worker-1432'))),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^invalid key:/)]));
  });
});

describe('setup skill sync', () => {
  it('keeps the skill and references within their byte budgets', () => {
    expect(Buffer.byteLength(setupSkill)).toBeLessThanOrEqual(5120);
    expect(readdirSync(setupReferencesPath).sort()).toEqual(setupReferenceNames);
    for (const [index, name] of setupReferenceNames.entries()) {
      expect(setupSkill).toContain(`references/${name}`);
      expect(Buffer.byteLength(setupReferenceTexts[index] ?? '')).toBeLessThanOrEqual(8192);
    }
  });

  it('asks for the PR-author login and checks worker links', () => {
    expect(setupSkill).toContain('open PRs under');
    expect(setupSkill).toContain('references/worker-links.md');
    expect(setupFullText).toContain('--link board-worker=');
    expect(setupFullText).toContain('tracker.repo');
  });

  it('uses only registered board commands and flags', () => {
    expect(validateSetupInvocations(setupFullText)).toEqual([]);
    expect(invocations(setupFullText).length).toBeGreaterThan(8);
  });

  it('rejects misspelled setup commands and flags, including binary routes', () => {
    expect(validateSetupInvocations('`board doctro --offline`')).toContain(
      'unknown command: board doctro --offline',
    );
    expect(validateSetupInvocations('`board doctor --offlien`')).toContain(
      'unknown flag: --offlien',
    );
    expect(validateSetupInvocations('`board mcpx`')).toContain('unknown command: board mcpx');
    expect(validateSetupInvocations('`board --versoin`')).toContain(
      'unknown command: board --versoin',
    );
    expect(
      validateSetupInvocations('`board mcp`', binarySource.replace("argv[0] === 'mcp'", 'false')),
    ).toContain('unknown command: board mcp');
    expect(
      validateSetupInvocations(
        '`board --version`',
        binarySource.replace("argv[0] === '--version'", 'false'),
      ),
    ).toContain('unknown command: board --version');
  });
});

describe('public guide command mentions', () => {
  it('still checks shell commands after a YAML example', () => {
    expect(
      validateSetupInvocations('```yaml\nkey: value\n```\n```sh\nboard doctro --offline\n```'),
    ).toContain('unknown command: board doctro --offline');
  });

  it('uses only registered board commands and flags in each guide', () => {
    for (const guide of publicGuides) expect(validateSetupInvocations(guide)).toEqual([]);
    expect(publicGuides.flatMap(invocations).length).toBeGreaterThan(12);
  });

  it('documents worker session links and the PR-author login', () => {
    const setup = publicGuides[1];
    expect(setup).toContain('open PRs under');
    const section = setup?.split('## 6. Link worker sessions to tasks')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    for (const token of [
      'docs/configuration.md#session-links',
      '--link board-worker=',
      '`board link`',
      'any Spur project',
      'role: worker',
    ])
      expect(section).toContain(token);
  });

  it('keeps the agent bootstrap line and GitHub permission recovery', () => {
    const [readme, setup, troubleshooting] = publicGuides;
    expect(readme).toMatch(/^npx -y spur-board@latest skills install$/m);
    expect(readme).toContain('`spur-board-setup`');
    for (const guide of [setup, troubleshooting]) {
      expect(guide).toContain('classic personal access token');
      expect(guide).toContain('`repo`');
      expect(guide).toContain('`read:org`');
      expect(guide).toContain('SSO');
      expect(guide).toContain('`FORBIDDEN`');
      expect(guide).toContain('`CheckRun`');
      expect(guide).toContain('`INSUFFICIENT_SCOPES`');
    }
  });
});
