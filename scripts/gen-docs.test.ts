import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, SECRET_ENV_KEYS, configJsonSchema } from '../packages/contracts/src/index.ts';
import { binaryRoutes, formattedDocs, registeredCommands } from './gen-docs.ts';

const cli = readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
const configuration = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');

describe('generated public references', () => {
  it('keeps the committed references equal to source generation', async () => {
    const rendered = await formattedDocs();
    expect(cli).toBe(rendered.cli);
    expect(configuration).toBe(rendered.configuration);
  });

  it('documents that a session outranks a token and how an unknown Spur project is refused', () => {
    const section = cli.split('## Daemon address and caller identity')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    expect(section).toContain(
      'Inside a Spur session the session wins over a token: `SPUR_SESSION` is sent and neither `BOARD_TOKEN` nor `.spur-board/token` is read.',
    );
    expect(section).toContain(
      "A session whose Spur project is in no `projects[].spurProjects` of the Board's `config.yaml`, or is listed under several Board projects, is refused with `forbidden` (exit 1), and the hint names the Spur project and the fix.",
    );
  });

  it('covers catalog, setup, and direct binary commands with registered flags', () => {
    const registered = registeredCommands();
    const expected = [...registered.map(({ path }) => path), ...binaryRoutes()];
    expect([...cli.matchAll(/^### `board ([^`]+)`$/gm)].map((match) => match[1])).toEqual(expected);
    for (const operation of OPERATIONS) {
      const heading = `### \`board ${operation.cli.command}\``;
      const section = cli.split(heading)[1]?.split('\n### ')[0];
      expect(section, operation.id).toBeDefined();
      for (const code of operation.errors) expect(section).toContain(`\`${code}\` (exit `);
      expect(section).toContain('Example: `board ');
      if (operation.kind === 'mutation') expect(section).toContain(' --key ');
    }
    for (const { path, command } of registered) {
      const section = cli.split(`### \`board ${path}\``)[1]?.split('\n### ')[0] ?? '';
      for (const option of command.options) expect(section).toContain(`\`${option.flags}\``);
    }
    expect(cli).not.toMatch(/ —$/m);
  });

  it('documents config fields and every recognized secret name without values', () => {
    const schema = configJsonSchema();
    for (const name of Object.keys(schema.properties ?? {}))
      expect(configuration).toMatch(new RegExp('^\\| `' + name + '` +\\|', 'm'));
    expect(configuration).toContain('`slack.command`');
    expect(configuration).toContain('`"/board"`');
    const fieldRows = (configuration.split('## config.yaml fields')[1]?.split('\n## ')[0] ?? '')
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split(/(?<!\\)\|/).map((cell) => cell.trim()));
    expect(fieldRows.map((cells) => cells[1])).toContain('`projects[].id`');
    expect(
      fieldRows
        .filter((cells) => cells[2] !== 'object' && cells[6] === '—')
        .map((cells) => cells[1]),
    ).toEqual([]);
    const row = (name: string) =>
      configuration.split('\n').find((line) => line.startsWith(`| \`projects[].link.${name}\` `));
    const link = configuration.split('\n').find((line) => line.startsWith('| `projects[].link` '));
    expect(link).toContain('tracker.projectKeys');
    expect(link).toContain('Jira');
    expect(link).not.toContain('ignores');
    expect(row('sources')).toContain('`["closing","branch","title"]`');
    expect(row('sources')).toContain('first source that yields an issue number wins');
    expect(row('sources[]')).toContain('one of closing, branch, title');
    expect(row('branchPattern')).toContain('`"^[A-Za-z]+-([1-9][0-9]*)"`');
    expect(row('branchPattern')).toContain('PR head branch');
    expect(row('titlePattern')).toContain('`"^[a-z]+(?:\\\\([^)]*\\\\))?!?: #([1-9][0-9]*)"`');
    expect(row('titlePattern')).toContain('PR title');
    expect(configuration).not.toContain('branchPattern (github-issues)');
    const login = configuration
      .split('\n')
      .find((line) => line.startsWith('| `projects[].operatorGithubLogin` '));
    expect(login).toContain('author');
    expect(login).toContain('open PRs under');
    const sessionLinks = configuration.split('## Session links')[1]?.split('\n## ')[0];
    expect(sessionLinks).toBeDefined();
    for (const token of [
      'board-worker',
      'board-other',
      '/browse/',
      '/issues/',
      'role: worker',
      'any Spur project',
      'spur slots',
      '`board link',
    ])
      expect(sessionLinks).toContain(token);
    const linkSpans = [...(sessionLinks ?? '').matchAll(/`board (link|unlink) ([^`]*)`/g)];
    expect(linkSpans.map((match) => match[1])).toEqual(['link', 'unlink']);
    for (const [, path, args] of linkSpans) {
      const flags = (
        registeredCommands().find((command) => command.path === path)?.command.options ?? []
      ).map((option) => option.long);
      for (const flag of args?.match(/--[a-z-]+/g) ?? []) expect(flags).toContain(flag);
    }
    expect(
      [...configuration.matchAll(/^\| `([A-Z][A-Z_]+)` +\|/gm)].map((match) => match[1]),
    ).toEqual(SECRET_ENV_KEYS.map(({ name }) => name));
    expect(configuration).not.toContain('=github-test-value');
  });
});
