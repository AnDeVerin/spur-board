import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import { COLUMNS, configJsonSchema, configSchema } from '../src/index.ts';

function readFixture(name: string): unknown {
  return YAML.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
}

const jiraTracker = {
  type: 'jira',
  baseUrl: 'https://example.atlassian.net',
  jql: 'project = PROJ',
  doneStatuses: ['Done'],
  readyStatuses: ['Ready for Dev'],
};

function jiraProject(): Record<string, unknown> {
  return {
    id: 'web',
    tracker: jiraTracker,
    repos: ['example-org/web'],
    operatorGithubLogin: 'octocat',
  };
}

/** A valid config with one Jira project; `project` and `root` override its keys. */
function validConfig(
  project: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projects: [{ ...jiraProject(), ...project }],
    operator: { slack: 'U0000000000' },
    digest: { tz: 'Europe/Berlin' },
    ...root,
  };
}

function withoutOperator(): Record<string, unknown> {
  const config = validConfig();
  delete config.operator;
  return config;
}

const githubTracker = { type: 'github-issues', repo: 'example-org/board' };
const columns = (...names: string[]) => names.map((column) => ({ column }));

/** The error printed for an invalid config, or a failure if it parsed. */
function errorFor(input: unknown): string {
  const result = configSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? '' : z.prettifyError(result.error);
}

function pathLines(error: string): string[] {
  return error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('→ at '));
}

describe('fixtures', () => {
  it('parses the Jira project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('jira-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    const project = config.projects[0];
    expect(project?.spurProjects).toEqual([{ name: 'qa-bot', role: 'worker' }]);
    expect(project?.columns.map((c) => [c.column, c.orchestrator])).toEqual(
      COLUMNS.map((column) => [column, column === 'QA' ? 'qa-bot' : 'none']),
    );
  });

  it('parses the github-issues project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('github-issues-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    const project = config.projects[0];
    expect(project?.spurProjects).toEqual([]);
    expect(project?.columns.find((c) => c.column === 'QA')?.orchestrator).toBe('operator');
  });

  it('gives a project without columns all seven columns, orchestrator none', () => {
    const config = configSchema.parse(validConfig());
    expect(config.projects[0]?.columns).toEqual([
      { column: 'To Do', orchestrator: 'none' },
      { column: 'Ready for Dev', orchestrator: 'none' },
      { column: 'Dev', orchestrator: 'none' },
      { column: 'Review', orchestrator: 'none' },
      { column: 'QA', orchestrator: 'none' },
      { column: 'Ready to Merge', orchestrator: 'none' },
      { column: 'Done', orchestrator: 'none' },
    ]);
    expect(config.projects[0]?.spurProjects).toEqual([]);
  });
});

describe('invalid configs', () => {
  it.each<[string, unknown, string, string]>([
    [
      'unknown tracker key',
      validConfig({ tracker: { ...jiraTracker, foo: 1 } }),
      'Unrecognized key: "foo"',
      'projects[0].tracker',
    ],
    [
      'column outside the enum',
      validConfig({ columns: columns('Foo') }),
      'Invalid option',
      'projects[0].columns[0].column',
    ],
    [
      'duplicate project id',
      { ...validConfig(), projects: [jiraProject(), jiraProject()] },
      'Duplicate project id: "web"',
      'projects[1].id',
    ],
    [
      'duplicate column',
      validConfig({ columns: columns('QA', 'QA') }),
      'Duplicate column: "QA"',
      'projects[0].columns[1].column',
    ],
    [
      'unknown orchestrator',
      validConfig({
        columns: [
          ...columns('To Do', 'Ready for Dev', 'Dev', 'Review'),
          { column: 'QA', orchestrator: 'ghost' },
        ],
      }),
      'Unknown orchestrator "ghost"',
      'projects[0].columns[4].orchestrator',
    ],
    [
      'github-issues with label and milestone',
      validConfig({ tracker: { ...githubTracker, label: 'board', milestone: 'v1' } }),
      'Set exactly one of label or milestone',
      'projects[0].tracker.label',
    ],
    [
      'github-issues with neither label nor milestone',
      validConfig({ tracker: githubTracker }),
      'Set exactly one of label or milestone',
      'projects[0].tracker.label',
    ],
    [
      'duplicate spur project',
      validConfig({
        spurProjects: [
          { name: 'qa-bot', role: 'worker' },
          { name: 'qa-bot', role: 'operator' },
        ],
      }),
      'Duplicate spur project name: "qa-bot"',
      'projects[0].spurProjects[1].name',
    ],
    [
      'unknown time zone',
      validConfig({}, { digest: { tz: 'Not/AZone' } }),
      'Unknown IANA time zone',
      'digest.tz',
    ],
    [
      'missing operator',
      withoutOperator(),
      'Invalid input: expected object, received undefined',
      'operator',
    ],
  ])('rejects %s', (_name, input, message, path) => {
    const error = errorFor(input);
    expect(error).toContain(message);
    expect(pathLines(error)).toContain(`→ at ${path}`);
  });

  it('rejects an unknown root key without a path', () => {
    const error = errorFor(validConfig({}, { bogus: 1 }));
    expect(error).toContain('Unrecognized key: "bogus"');
    expect(error).not.toContain('→ at');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['time zone UTC', {}, { digest: { tz: 'UTC' } }],
    ['github-issues with only a label', { tracker: { ...githubTracker, label: 'board' } }, {}],
    ['github-issues with only a milestone', { tracker: { ...githubTracker, milestone: 'v1' } }, {}],
  ])('accepts %s', (_name, project, root) => {
    expect(configSchema.safeParse(validConfig(project, root)).success).toBe(true);
  });
});

describe('JSON Schema', () => {
  it('matches the committed config.schema.json', () => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'),
    );
    expect(committed, 'config.schema.json is stale: run pnpm gen:config-schema').toEqual(
      configJsonSchema(),
    );
  });

  it('converts in output mode too (no transform or preprocess)', () => {
    expect(() => z.toJSONSchema(configSchema, { io: 'output' })).not.toThrow();
  });

  it('has no secret-like property names', () => {
    const names: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'properties' && typeof value === 'object' && value !== null) {
            names.push(...Object.keys(value));
          }
          walk(value);
        }
      }
    };
    walk(configJsonSchema());
    expect(names).toContain('staleMultiplier');
    expect(names.filter((name) => /token|secret|password/i.test(name))).toEqual([]);
  });
});
