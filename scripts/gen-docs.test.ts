import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  OPERATIONS,
  SECRET_ENV_KEYS,
  configJsonSchema,
  configSchema,
} from '../packages/contracts/src/index.ts';
import {
  approvalRuleExample,
  approvalWatchExample,
  binaryRoutes,
  checksGateExample,
  formattedDocs,
  registeredCommands,
} from './gen-docs.ts';

const cli = readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
const configuration = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');

describe('generated public references', () => {
  it('documents the intended Spur UI session route, fallback and reachability check', () => {
    const section = configuration.split('## Spur UI session links')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    for (const text of [
      'web.spurUiOrigin',
      '<origin>/sessions/<session id>',
      'plain session IDs',
      '`board doctor --json`',
      'any HTTP response',
      'only warns on transport errors',
      'never block readiness or updates',
      'HTTP UI origins work on any host without voice',
      'TLS',
      'restart the daemon',
    ])
      expect(section).toContain(text);
    const doctor = registeredCommands().find(({ path }) => path === 'doctor');
    expect(doctor?.command.options.some(({ flags }) => flags.includes('--json'))).toBe(true);
  });
  it('the checksGate example parses', () => {
    const section = configuration.split('## Example: green checks at External Review')[1];
    const block = section?.split('```yaml\n')[1]?.split('```')[0];
    expect(block).toBe(checksGateExample);
    expect(configSchema.parse(YAML.parse(block ?? '')).projects[0]?.checksGate).toBe(
      'external-review',
    );
  });

  it('the approvalRule example parses with github-rules on External Review', () => {
    const section = configuration.split(
      '## Example: follow the GitHub review rule at External Review',
    )[1];
    const block = section?.split('```yaml\n')[1]?.split('```')[0];
    expect(block).toBe(approvalRuleExample);
    const project = configSchema.parse(YAML.parse(block ?? '')).projects[0];
    expect(project?.columns.find((c) => c.id === 'external-review')?.approvalRule).toBe(
      'github-rules',
    );
    for (const text of [
      'branch protection and rulesets',
      'undecided for 30 minutes',
      'board rollback',
    ])
      expect(section?.split('\n## ')[0]).toContain(text);
  });

  it('the approvalWatch example parses', () => {
    const section = configuration.split('## Example: watch what changed after an approval')[1];
    const block = section?.split('```yaml\n')[1]?.split('```')[0];
    expect(block).toBe(approvalWatchExample);
    expect(configSchema.parse(YAML.parse(block ?? '')).projects[0]?.approvalWatch).toEqual([
      'back/',
      'front/',
      'package.json',
    ]);
    for (const text of ['watchedAfter', 'board rollback'])
      expect(section?.split('\n## ')[0]).toContain(text);
  });

  it('cli.md names the review rule waits and their texts', () => {
    const section = cli.split('## Why a task waits')[1]?.split('\n## ')[0];
    expect(section).toContain('`approvalRule: github-rules` on External Review only');
    expect(section).toContain('`review_rule_satisfied`');
    const rows = (section ?? '').split('\n').map((line) => line.replace(/ +/g, ' '));
    for (const row of [
      '| `review_rule_blocked` | `merge blocked by the GitHub review rule` |',
      '| `changes_requested` | `changes requested` |',
      '| `merge_state_unknown` | `GitHub has not computed the merge state yet` |',
      '| `review_rule_unreadable` | `the GitHub review rule for the base branch could not be read` |',
    ])
      expect(rows).toContain(row);
  });

  it('configuration.md states the grace scope', () => {
    for (const text of [
      'checksGate',
      'about two GitHub poll intervals',
      'takes effect after a restart',
      'with `dev` it is red at once',
    ])
      expect(configuration).toContain(text);
  });

  it('cli.md names checks_pending, checks_red and both texts', () => {
    const section = cli.split('## Why a task waits')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    for (const text of [
      '`checks_pending`',
      '`checks_red`',
      '`waiting for CI on <sha>`',
      '`checks running, exit from <checksGate> waits for green`',
      '`checks red`, listed whenever red checks keep the task in Dev or a taken turn holds it in place',
      '`checks_not_red`',
    ])
      expect(section).toContain(text);
  });

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
      "A session whose Spur project is in no `projects[].spurProjects` or top-level `spurProjects` of the Board's `config.yaml`, or is listed under several Board projects, is refused with `forbidden` (exit 1), and the hint names the Spur project and the fix.",
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
    expect(login).toContain('by this login or by a bot (GitHub App) are not external');
    expect(login).toContain("the repo owner's and the human operator's included");
    const cycleLimit = configuration
      .split('\n')
      .find((line) => line.startsWith('| `projects[].columns[].cycleLimit` '));
    expect(cycleLimit).toContain(
      'a changes-requested review included (it is an external comment, not a separate return)',
    );
    expect(cycleLimit).not.toContain('changes requested and external comments');
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
