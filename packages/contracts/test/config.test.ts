import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import {
  COLUMN_IDS,
  DEFAULT_HTTP_PORT,
  type Config,
  configJsonSchema,
  configSchema,
} from '../src/index.ts';
import { walk as walkJsonSchema } from './json-schema-walk.ts';

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
const columns = (...ids: string[]) => ids.map((id) => ({ id }));

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

/** The adapter, source, GitHub and health defaults every config gets when it omits them. */
const adapterDefaults: Pick<Config, 'adapters' | 'sources' | 'github' | 'health'> = {
  adapters: {
    spur: { intervalMs: 15_000, baseUrl: 'http://127.0.0.1:4310' },
    github: { intervalMs: 60_000 },
    jira: { intervalMs: 120_000 },
  },
  sources: { authRetryMs: 900_000, goneAfterPolls: 3 },
  github: { reserveRemaining: 1000 },
  health: {
    errorAfterMs: 90_000,
    needsInputAfterMs: 120_000,
    idleInDevAfterMs: 1_800_000,
    flipSmoothingMs: 30_000,
    hostLoad: { sessions: 3, windowMs: 60_000, maxEpisodeMs: 300_000 },
  },
};

function adapterKeys(config: Config): Pick<Config, 'adapters' | 'sources' | 'github' | 'health'> {
  const { adapters, sources, github, health } = config;
  return { adapters, sources, github, health };
}

describe('fixtures', () => {
  it('pins the default HTTP port', () => {
    expect(DEFAULT_HTTP_PORT).toBe(4311);
  });

  it('parses the Jira project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('jira-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.thresholds.blockOpenMs).toBe(86_400_000);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    expect(config.doorbells).toEqual({
      firstRetryMs: 120_000,
      secondRetryMs: 300_000,
      unansweredAfterMs: 900_000,
    });
    expect(config.http.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.slack.channels).toEqual({});
    expect(config.slack.command).toBe('/board');
    expect(config.slack.appName).toBe('spur-board');
    expect(adapterKeys(config)).toEqual(adapterDefaults);
    const project = config.projects[0];
    expect(project?.tracker.type === 'jira' && project.tracker.projectKeys).toEqual([]);
    expect(project?.spurProjects).toEqual([{ name: 'qa-bot', role: 'worker' }]);
    expect(project?.columns).toEqual(
      COLUMN_IDS.map((id) => ({
        id,
        enabled: true,
        orchestrator: id === 'qa' ? 'qa-bot' : 'none',
      })),
    );
  });

  it('parses the github-issues project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('github-issues-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.thresholds.blockOpenMs).toBe(86_400_000);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    expect(config.http.port).toBe(4311);
    expect(config.slack.channels).toEqual({});
    expect(adapterKeys(config)).toEqual(adapterDefaults);
    const project = config.projects[0];
    expect(project?.tracker).not.toHaveProperty('projectKeys');
    expect(project?.spurProjects).toEqual([]);
    expect(project?.columns.find((c) => c.id === 'qa')?.orchestrator).toBe('operator');
    expect(project?.columns.filter((c) => !c.enabled).map((c) => c.id)).toEqual(['ready-for-dev']);
  });

  it('gives a project without columns all seven columns, enabled, orchestrator none', () => {
    const config = configSchema.parse(validConfig());
    expect(config.projects[0]?.columns).toEqual([
      { id: 'todo', enabled: true, orchestrator: 'none' },
      { id: 'ready-for-dev', enabled: true, orchestrator: 'none' },
      { id: 'dev', enabled: true, orchestrator: 'none' },
      { id: 'review', enabled: true, orchestrator: 'none' },
      { id: 'qa', enabled: true, orchestrator: 'none' },
      { id: 'ready-to-merge', enabled: true, orchestrator: 'none' },
      { id: 'done', enabled: true, orchestrator: 'none' },
    ]);
    expect(config.projects[0]?.spurProjects).toEqual([]);
  });

  it('accepts configured Slack channel IDs', () => {
    const config = configSchema.parse(
      validConfig(
        {},
        {
          slack: {
            appName: 'My Board',
            command: '/board-x',
            appId: 'A123ABC',
            channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
          },
        },
      ),
    );
    expect(config.slack.channels).toEqual({ orchestrators: 'C_ORCH', feed: 'C_FEED' });
    expect(config.slack.command).toBe('/board-x');
    expect(config.slack.appName).toBe('My Board');
    expect(config.slack.appId).toBe('A123ABC');
  });

  it('accepts an explicit HTTP port', () => {
    expect(configSchema.parse(validConfig({}, { http: { port: 4312 } })).http.port).toBe(4312);
    expect(configSchema.parse(validConfig({}, { http: { port: 0 } })).http.port).toBe(0);
  });
});

describe('invalid configs', () => {
  it.each<[string, unknown, string, string]>([
    [
      'blank Slack app name',
      validConfig({}, { slack: { appName: '  ' } }),
      'Too small',
      'slack.appName',
    ],
    [
      'invalid Slack command',
      validConfig({}, { slack: { command: 'board' } }),
      'Expected a slash command such as /board',
      'slack.command',
    ],
    [
      'invalid Slack app ID',
      validConfig({}, { slack: { appId: 'bad' } }),
      'Expected a Slack app ID',
      'slack.appId',
    ],
    [
      'nonpositive block threshold',
      validConfig({}, { thresholds: { blockOpenMs: 0 } }),
      'Too small',
      'thresholds.blockOpenMs',
    ],
    [
      'invalid doorbell retry pause',
      validConfig({}, { doorbells: { firstRetryMs: 0 } }),
      'Too small: expected number to be >=1',
      'doorbells.firstRetryMs',
    ],
    [
      'decreasing doorbell retry pause',
      validConfig({}, { doorbells: { firstRetryMs: 600_000, secondRetryMs: 1000 } }),
      'Second retry pause must exceed the first retry pause',
      'doorbells.secondRetryMs',
    ],
    [
      'decreasing final unanswered pause',
      validConfig({}, { doorbells: { secondRetryMs: 600_000, unansweredAfterMs: 1000 } }),
      'Final unanswered pause must exceed the second retry pause',
      'doorbells.unansweredAfterMs',
    ],
    [
      'unknown tracker key',
      validConfig({ tracker: { ...jiraTracker, foo: 1 } }),
      'Unrecognized key: "foo"',
      'projects[0].tracker',
    ],
    [
      'custom column id',
      validConfig({ columns: columns('todo', 'triage', 'dev', 'done') }),
      'Unknown column "triage": custom columns arrive with custom matchers and are not supported yet',
      'projects[0].columns[1].id',
    ],
    [
      'column display name instead of its id',
      validConfig({ columns: columns('todo', 'QA', 'dev', 'done') }),
      'Unknown column "QA"',
      'projects[0].columns[1].id',
    ],
    [
      'duplicate project id',
      { ...validConfig(), projects: [jiraProject(), jiraProject()] },
      'Duplicate project id: "web"',
      'projects[1].id',
    ],
    [
      'duplicate column',
      validConfig({ columns: columns('todo', 'dev', 'qa', 'qa', 'done') }),
      'Duplicate column: "qa"',
      'projects[0].columns[3].id',
    ],
    [
      'missing required column',
      validConfig({ columns: columns('todo', 'review', 'done') }),
      'Missing required column "dev"',
      'projects[0].columns',
    ],
    [
      'disabled required column',
      validConfig({
        columns: [...columns('todo'), { id: 'dev', enabled: false }, ...columns('done')],
      }),
      'Required column "dev" cannot be disabled',
      'projects[0].columns[1].enabled',
    ],
    [
      'built-in columns out of order',
      validConfig({ columns: columns('todo', 'dev', 'qa', 'review', 'done') }),
      'Column "review" is out of order: built-in columns go in the order todo, ready-for-dev, dev, review, qa, ready-to-merge, done',
      'projects[0].columns[3].id',
    ],
    [
      'unknown orchestrator',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'qa', orchestrator: 'ghost' },
          ...columns('done'),
        ],
      }),
      'Unknown orchestrator "ghost"',
      'projects[0].columns[2].orchestrator',
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
      'empty Slack feed channel',
      validConfig({}, { slack: { channels: { feed: '' } } }),
      'Too small: expected string to have >=1 characters',
      'slack.channels.feed',
    ],
    [
      'lowercase Jira project key',
      validConfig({ tracker: { ...jiraTracker, projectKeys: ['proj'] } }),
      'Expected a Jira project key like PROJ',
      'projects[0].tracker.projectKeys[0]',
    ],
    [
      'zero gone-after polls',
      validConfig({}, { sources: { goneAfterPolls: 0 } }),
      'Too small: expected number to be >=1',
      'sources.goneAfterPolls',
    ],
    [
      'HTTP port above the TCP range',
      validConfig({}, { http: { port: 65_536 } }),
      'Too big: expected number to be <=65535',
      'http.port',
    ],
    [
      'invalid Spur base URL',
      validConfig({}, { adapters: { spur: { baseUrl: 'file:///tmp/spur.sock' } } }),
      'Invalid URL',
      'adapters.spur.baseUrl',
    ],
    [
      'zero error-after duration',
      validConfig({}, { health: { errorAfterMs: 0 } }),
      'Too small: expected number to be >=1',
      'health.errorAfterMs',
    ],
    [
      'a duration key without its unit',
      validConfig({}, { health: { errorAfter: 90_000 } }),
      'Unrecognized key: "errorAfter"',
      'health',
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
    ['Jira project keys', { tracker: { ...jiraTracker, projectKeys: ['PROJ'] } }, {}],
    ['github-issues with only a label', { tracker: { ...githubTracker, label: 'board' } }, {}],
    ['github-issues with only a milestone', { tracker: { ...githubTracker, milestone: 'v1' } }, {}],
    ['a board without the optional columns', { columns: columns('todo', 'dev', 'done') }, {}],
    [
      'disabled optional columns',
      { columns: [...columns('todo', 'dev'), { id: 'qa', enabled: false }, ...columns('done')] },
      {},
    ],
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

  it('names every millisecond key with Ms', () => {
    const { properties } = walkJsonSchema(z.toJSONSchema(configSchema, { io: 'output' }));
    for (const { path, name, node } of properties) {
      const description = typeof node['description'] === 'string' ? node['description'] : '';
      expect(name.endsWith('Ms'), path).toBe(description.includes('milliseconds'));
    }
    const msPaths = properties
      .filter(({ name }) => name.endsWith('Ms'))
      .map(({ path }) => path)
      .sort();
    expect(msPaths).toEqual([
      '.adapters.github.intervalMs',
      '.adapters.jira.intervalMs',
      '.adapters.spur.intervalMs',
      '.doorbells.firstRetryMs',
      '.doorbells.secondRetryMs',
      '.doorbells.unansweredAfterMs',
      '.health.errorAfterMs',
      '.health.flipSmoothingMs',
      '.health.hostLoad.maxEpisodeMs',
      '.health.hostLoad.windowMs',
      '.health.idleInDevAfterMs',
      '.health.needsInputAfterMs',
      '.sources.authRetryMs',
      '.thresholds.blockOpenMs',
    ]);
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
