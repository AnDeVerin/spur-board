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
  });

  it('documents config fields and every recognized secret name without values', () => {
    const schema = configJsonSchema();
    for (const name of Object.keys(schema.properties ?? {}))
      expect(configuration).toMatch(new RegExp('^\\| `' + name + '` +\\|', 'm'));
    expect(configuration).toContain('`slack.command`');
    expect(configuration).toContain('`"/board"`');
    const row = (name: string) =>
      configuration.split('\n').find((line) => line.startsWith(`| \`projects[].link.${name}\` `));
    expect(row('sources')).toContain('`["closing","branch","title"]`');
    expect(row('sources')).toContain('first source that yields an issue number wins');
    expect(row('sources[]')).toContain('one of closing, branch, title');
    expect(row('branchPattern')).toContain('`"^[A-Za-z]+-([1-9][0-9]*)"`');
    expect(row('branchPattern')).toContain('PR head branch');
    expect(row('titlePattern')).toContain('`"^[a-z]+(?:\\\\([^)]*\\\\))?!?: #([1-9][0-9]*)"`');
    expect(row('titlePattern')).toContain('PR title');
    expect(configuration).not.toContain('branchPattern (github-issues)');
    expect(
      [...configuration.matchAll(/^\| `([A-Z][A-Z_]+)` +\|/gm)].map((match) => match[1]),
    ).toEqual(SECRET_ENV_KEYS.map(({ name }) => name));
    expect(configuration).not.toContain('=github-test-value');
  });
});
