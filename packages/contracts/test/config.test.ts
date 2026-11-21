import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_STAND_PORT_RANGE,
  resolveWebOrigin,
  RESERVED_PROJECT,
  type Config,
  approvalRuleOf,
  configBindings,
  configJsonSchema,
  columnTurnTimings,
  configSchema,
  defaultAddressee,
  mirrorSourceId,
  readyMirrorOf,
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

/** A valid config with board projects web and api and top-level `spurProjects`. */
function boardWide(
  spurProjects: unknown[],
  web: Record<string, unknown> = {},
  api: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): Record<string, unknown> {
  return validConfig(
    {},
    {
      projects: [
        { ...jiraProject(), ...web },
        { ...jiraProject(), id: 'api', repos: ['example-org/api'], ...api },
      ],
      spurProjects,
      ...root,
    },
  );
}

const br = { name: 'br', role: 'orchestrator', columns: ['review'] };

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
    githubIssues: { intervalMs: 120_000 },
    jira: { intervalMs: 120_000 },
  },
  sources: { authRetryMs: 900_000, goneAfterPolls: 3 },
  github: { reserveRemaining: 1000 },
  health: {
    turnStallAfterMs: 600_000,
    errorAfterMs: 90_000,
    needsInputAfterMs: 120_000,
    idleInDevAfterMs: 1_800_000,
    flipSmoothingMs: 30_000,
    hostLoad: { sessions: 3, windowMs: 60_000, maxEpisodeMs: 300_000 },
    turnWait: { maxWaits: 8, maxTotalMs: 7_200_000 },
  },
};

function adapterKeys(config: Config): Pick<Config, 'adapters' | 'sources' | 'github' | 'health'> {
  const { adapters, sources, github, health } = config;
  return { adapters, sources, github, health };
}

describe('fixtures', () => {
  it('pins the default HTTP port', () => {
    expect(DEFAULT_HTTP_PORT).toBe(4777);
  });

  it('parses the Jira project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('jira-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.thresholds.blockOpenMs).toBe(86_400_000);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    expect(config.operatorAccess.unusedAfterDays).toBe(14);
    expect(config.doorbells).toEqual({
      firstRetryMs: 120_000,
      secondRetryMs: 300_000,
      unansweredAfterMs: 900_000,
    });
    expect(config.http.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.spurProjects).toEqual([]);
    expect(config.slack.channels).toEqual({});
    expect(config.slack.command).toBe('/board');
    expect(config.slack.appName).toBe('spur-board');
    expect(adapterKeys(config)).toEqual(adapterDefaults);
    const project = config.projects[0];
    expect(project?.tracker.type === 'jira' && project.tracker.projectKeys).toEqual([]);
    expect(project?.checksGate).toBe('dev');
    expect(project?.spurProjects).toEqual([{ name: 'qa-bot', role: 'orchestrator' }]);
    expect(project?.columns).toEqual([
      { id: 'todo', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'ready-for-dev', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'dev', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'review', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'qa', enabled: true, orchestrator: 'qa-bot', cycleLimit: 10, courseCheck: 3 },
      { id: 'ready-to-merge', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'done', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
    ]);
  });

  it('parses the github-issues project and fills the defaults', () => {
    const config = configSchema.parse(readFixture('github-issues-project.yaml'));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.thresholds.blockOpenMs).toBe(86_400_000);
    expect(config.archive.doneWeekday).toBe('saturday');
    expect(config.commands.retentionDays).toBe(7);
    expect(config.http.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.spurProjects).toEqual([]);
    expect(config.slack.channels).toEqual({});
    expect(adapterKeys(config)).toEqual(adapterDefaults);
    const project = config.projects[0];
    expect(project?.tracker).not.toHaveProperty('projectKeys');
    expect(project?.checksGate).toBe('dev');
    expect(project?.link).toEqual({
      sources: ['closing', 'branch', 'title'],
      branchPattern: '^[A-Za-z]+-([1-9][0-9]*)',
      titlePattern: '^[a-z]+(?:\\([^)]*\\))?!?: #([1-9][0-9]*)',
    });
    expect(project?.spurProjects).toEqual([]);
    expect(project?.columns.find((c) => c.id === 'qa')?.orchestrator).toBe('operator');
    expect(project?.columns.filter((c) => !c.enabled).map((c) => c.id)).toEqual(['ready-for-dev']);
  });

  it('gives a project without columns every built-in column with orchestrator none, triage listed disabled', () => {
    const config = configSchema.parse(validConfig());
    expect(config.projects[0]?.columns).toEqual([
      { id: 'todo', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'triage', enabled: false, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'ready-for-dev', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'dev', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'review', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'product-review', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      {
        id: 'external-review',
        enabled: true,
        orchestrator: 'none',
        cycleLimit: 10,
        courseCheck: 3,
      },
      { id: 'qa', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'ready-to-merge', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
      { id: 'done', enabled: true, orchestrator: 'none', cycleLimit: 10, courseCheck: 3 },
    ]);
    // The enabled columns are the nine of 0.117.1.
    expect(config.projects[0]?.columns.filter((c) => c.enabled).map((c) => c.id)).toEqual([
      'todo',
      'ready-for-dev',
      'dev',
      'review',
      'product-review',
      'external-review',
      'qa',
      'ready-to-merge',
      'done',
    ]);
    expect(config.projects[0]?.spurProjects).toEqual([]);
    expect(config.projects[0]?.reposWithoutCi).toEqual([]);
  });

  it('parses the checks gate fixture with External Review as the green checks column', () => {
    const config = configSchema.parse(readFixture('checks-gate-project.yaml'));
    expect(config.projects[0]?.checksGate).toBe('external-review');
  });

  it('approvalWatch: parses approvalWatch from the example fixture and leaves it out when absent', () => {
    const config = configSchema.parse(readFixture('approval-watch-project.yaml'));
    expect(config.projects[0]?.approvalWatch).toEqual(['back/', 'front/', 'package.json']);
    const project = configSchema.parse(validConfig()).projects[0];
    expect(project?.approvalWatch).toBeUndefined();
    expect(project).not.toHaveProperty('approvalWatch');
  });

  it('approvalRule: parses the approval rule fixture with github-rules on External Review', () => {
    const config = configSchema.parse(readFixture('approval-rule-project.yaml'));
    const project = config.projects[0];
    expect(project?.columns.find((c) => c.id === 'external-review')?.approvalRule).toBe(
      'github-rules',
    );
    expect(project === undefined ? undefined : approvalRuleOf(project)).toBe('github-rules');
  });

  it.each(['any-approval', 'github-rules'] as const)(
    'approvalRule: accepts %s on external-review',
    (approvalRule) => {
      const config = configSchema.parse(
        validConfig({
          columns: [
            ...columns('todo', 'dev'),
            { id: 'external-review', approvalRule },
            ...columns('done'),
          ],
        }),
      );
      const project = config.projects[0];
      expect(project?.columns[2]?.approvalRule).toBe(approvalRule);
      expect(project === undefined ? undefined : approvalRuleOf(project)).toBe(approvalRule);
    },
  );

  it('approvalRule: any-approval without the key, on a disabled column and without External Review', () => {
    const parse = (external: Record<string, unknown>[]) =>
      configSchema.parse(
        validConfig({ columns: [...columns('todo', 'dev'), ...external, ...columns('done')] }),
      ).projects[0];
    const plain = parse([{ id: 'external-review' }]);
    expect(plain?.columns[2]).not.toHaveProperty('approvalRule');
    for (const project of [
      plain,
      parse([{ id: 'external-review', enabled: false, approvalRule: 'github-rules' }]),
      parse([]),
      configSchema.parse(validConfig()).projects[0],
    ])
      expect(project === undefined ? undefined : approvalRuleOf(project)).toBe('any-approval');
  });

  it('source: parses the ready mirror fixture with a tracker source on ready-for-dev', () => {
    const project = configSchema.parse(readFixture('ready-mirror-project.yaml')).projects[0];
    expect(project?.columns.find((c) => c.id === 'ready-for-dev')?.source).toEqual({
      type: 'tracker',
      project: 'example-org/3',
      field: 'Status',
      value: 'Ready',
    });
    expect(project === undefined ? undefined : readyMirrorOf(project)).toEqual({
      project: 'example-org/3',
      owner: 'example-org',
      number: 3,
      field: 'Status',
      value: 'Ready',
    });
    expect(project === undefined ? undefined : mirrorSourceId(project)).toBe(
      'github-project:web:example-org/3',
    );
  });

  it('source: manual and an absent key mirror nothing', () => {
    const parse = (readyForDev: Record<string, unknown>) =>
      configSchema.parse(
        validConfig({
          tracker: githubTracker,
          columns: [...columns('todo'), readyForDev, ...columns('dev', 'done')],
        }),
      ).projects[0];
    const manual = parse({ id: 'ready-for-dev', source: 'manual' });
    expect(manual?.columns[1]?.source).toBe('manual');
    const plain = parse({ id: 'ready-for-dev' });
    expect(plain?.columns[1]).not.toHaveProperty('source');
    for (const project of [manual, plain, configSchema.parse(validConfig()).projects[0]]) {
      expect(project === undefined ? undefined : readyMirrorOf(project)).toBeUndefined();
      expect(project === undefined ? undefined : mirrorSourceId(project)).toBeUndefined();
    }
  });

  it('parses the QA turn timings fixture and resolves the column timings', () => {
    const config = configSchema.parse(readFixture('qa-turn-timings.yaml'));
    expect(columnTurnTimings(config, 'web', 'qa')).toEqual({
      orchestrator: 'qa-bot',
      quietTurnAfterMs: 5_400_000,
      noRecipientAfterMs: 900_000,
    });
    expect(columnTurnTimings(config, 'web', 'review')).toBeNull();
    expect(columnTurnTimings(config, 'web', 'missing')).toBeNull();
  });

  it('applies the turn timing defaults and keeps column objects without the keys unchanged', () => {
    const input = validConfig({
      spurProjects: [{ name: 'qa-bot', role: 'orchestrator' }],
      columns: [
        ...columns('todo', 'dev'),
        { id: 'qa', orchestrator: 'qa-bot' },
        ...columns('done'),
      ],
    });
    const config = configSchema.parse(input);
    expect(config.projects[0]?.columns.find((c) => c.id === 'qa')).toEqual({
      id: 'qa',
      enabled: true,
      orchestrator: 'qa-bot',
      cycleLimit: 10,
      courseCheck: 3,
    });
    expect(columnTurnTimings(config, 'web', 'qa')).toEqual({
      orchestrator: 'qa-bot',
      quietTurnAfterMs: 1_800_000,
      noRecipientAfterMs: 600_000,
    });
  });

  it('accepts turn timings on a board-wide filled column', () => {
    const config = configSchema.parse(
      boardWide([br], {
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', quietTurnAfterMs: 60_000, noRecipientAfterMs: 120_000 },
          ...columns('done'),
        ],
      }),
    );
    expect(columnTurnTimings(config, 'web', 'review')).toEqual({
      orchestrator: 'br',
      quietTurnAfterMs: 60_000,
      noRecipientAfterMs: 120_000,
    });
  });

  it.each(['dev', 'review', 'product-review', 'external-review'])(
    'accepts checksGate %s on the default board',
    (gate) => {
      expect(configSchema.parse(validConfig({ checksGate: gate })).projects[0]?.checksGate).toBe(
        gate,
      );
    },
  );

  it('accepts the whole Todo group: todo, triage and ready-for-dev', () => {
    const config = configSchema.parse(
      validConfig({ columns: columns('todo', 'triage', 'ready-for-dev', 'dev', 'done') }),
    );
    expect(config.projects[0]?.columns.map((c) => [c.id, c.enabled])).toEqual([
      ['todo', true],
      ['triage', true],
      ['ready-for-dev', true],
      ['dev', true],
      ['done', true],
    ]);
  });

  it('accepts courseCheck 0, which turns the course check off', () => {
    const config = configSchema.parse(
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'review', courseCheck: 0 }, ...columns('done')],
      }),
    );
    expect(config.projects[0]?.columns.find((c) => c.id === 'review')?.courseCheck).toBe(0);
  });

  it('accepts courseCheckTo operator, the curator or a column orchestrator, and leaves it unset by default', () => {
    const courseCheckTo = (value: string | undefined) => {
      const config = configSchema.parse(
        validConfig({
          spurProjects: [
            { name: 'rev-bot', role: 'orchestrator' },
            { name: 'cur', role: 'curator' },
          ],
          columns: [
            ...columns('todo', 'dev'),
            { id: 'review', orchestrator: 'rev-bot', courseCheckTo: value },
            ...columns('done'),
          ],
        }),
      );
      return config.projects[0]?.columns.find((c) => c.id === 'review')?.courseCheckTo;
    };
    expect(courseCheckTo(undefined)).toBeUndefined();
    expect(courseCheckTo('operator')).toBe('operator');
    expect(courseCheckTo('cur')).toBe('cur');
    expect(courseCheckTo('rev-bot')).toBe('rev-bot');
  });

  it('runs the dispatcher in shadow mode by default and accepts on', () => {
    expect(configSchema.parse(validConfig()).projects[0]?.dispatcher).toEqual({
      mode: 'shadow',
      submitConfirmMs: 180_000,
    });
    expect(
      configSchema.parse(validConfig({ dispatcher: { mode: 'on' } })).projects[0]?.dispatcher,
    ).toEqual({ mode: 'on', submitConfirmMs: 180_000 });
  });

  it('accepts a repo without CI from repos, in any letter case', () => {
    const config = configSchema.parse(
      validConfig({
        repos: ['example-org/web', 'example-org/api'],
        reposWithoutCi: ['Example-Org/API'],
      }),
    );
    expect(config.projects[0]?.reposWithoutCi).toEqual(['Example-Org/API']);
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

  it.each(['orchestrator', 'curator'] as const)('accepts named %s column executors', (role) => {
    const config = configSchema.parse(
      validConfig({
        spurProjects: [
          { name: 'executor', role },
          { name: 'second', role: 'orchestrator' },
        ],
        columns: [{ id: 'todo' }, { id: 'dev', orchestrator: 'executor' }, { id: 'done' }],
      }),
    );
    expect(config.projects[0]?.spurProjects).toHaveLength(2);
    expect(config.projects[0]?.columns[1]?.orchestrator).toBe('executor');
  });

  it.each(['worker', 'operator'] as const)(
    'rejects named %s column executors at the column path',
    (role) => {
      const result = configSchema.safeParse(
        validConfig({
          spurProjects: [{ name: 'executor', role }],
          columns: [{ id: 'todo' }, { id: 'dev', orchestrator: 'executor' }, { id: 'done' }],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['projects', 0, 'columns', 1, 'orchestrator'],
            message: expect.stringContaining('role orchestrator or curator') as unknown,
          }),
        );
    },
  );

  it('accepts one curator per board project', () => {
    const config = configSchema.parse(
      validConfig(
        {},
        {
          projects: [
            {
              ...jiraProject(),
              spurProjects: [
                { name: 'worker-a', role: 'worker' },
                { name: 'curator-a', role: 'curator' },
              ],
            },
            {
              ...jiraProject(),
              id: 'api',
              repos: ['example-org/api'],
              spurProjects: [{ name: 'curator-b', role: 'curator' }],
            },
          ],
        },
      ),
    );
    expect(
      config.projects.map(
        (project) => project.spurProjects.find((spur) => spur.role === 'curator')?.name,
      ),
    ).toEqual(['curator-a', 'curator-b']);
  });

  it('accepts a display name and icon on every role', () => {
    const spurProjects = [
      { name: 'worker-a', role: 'worker' },
      { name: 'worker-b', role: 'worker', displayName: 'Worker B' },
      { name: 'board-pm', role: 'operator', displayName: 'PM', icon: ':memo:' },
      { name: 'orch', role: 'orchestrator', displayName: 'Orch', icon: ':gear:' },
      { name: 'cur', role: 'curator', displayName: 'Cur Bot', icon: ':owl:' },
    ];
    const config = configSchema.parse(validConfig({ spurProjects }));
    expect(config.projects[0]?.spurProjects).toEqual(spurProjects);
  });

  it('accepts short names and a default addressee, and leaves both unset by default', () => {
    expect(configSchema.parse(validConfig()).slack.defaultAddressee).toBeUndefined();
    const config = configSchema.parse(
      validConfig(
        {
          spurProjects: [
            { name: 'cur', role: 'curator', shortName: 'cur' },
            { name: 'board-pm', role: 'operator', shortName: 'pm' },
          ],
        },
        { slack: { defaultAddressee: 'pm' } },
      ),
    );
    expect(config.projects[0]?.spurProjects.map((spur) => spur.shortName)).toEqual(['cur', 'pm']);
    expect(config.slack.defaultAddressee).toBe('pm');
  });

  it('accepts an explicit HTTP port', () => {
    expect(configSchema.parse(validConfig({}, { http: { port: 4312 } })).http.port).toBe(4312);
    expect(configSchema.parse(validConfig({}, { http: { port: 0 } })).http.port).toBe(0);
  });
});

describe('board-wide spur projects', () => {
  const orchestrator = (config: Config, project: number, column: string) =>
    config.projects[project]?.columns.find((entry) => entry.id === column)?.orchestrator;

  it('fills enabled columns left at none in every board project and keeps project bindings', () => {
    const config = configSchema.parse(
      validConfig(
        {},
        {
          projects: [
            {
              ...jiraProject(),
              id: 'alpha',
              spurProjects: [{ name: 'rev', role: 'orchestrator' }],
              columns: [
                ...columns('todo', 'dev'),
                { id: 'review', orchestrator: 'rev' },
                ...columns('qa', 'done'),
              ],
            },
            {
              ...jiraProject(),
              id: 'beta',
              columns: [
                ...columns('todo', 'dev'),
                { id: 'review', orchestrator: 'none' },
                { id: 'qa', enabled: false },
                ...columns('done'),
              ],
            },
            { ...jiraProject(), id: 'gamma', columns: columns('todo', 'dev', 'done') },
          ],
          spurProjects: [
            {
              name: 'br',
              role: 'orchestrator',
              columns: ['review', 'qa'],
              shortName: 'br',
              displayName: 'BR',
              icon: ':eyes:',
            },
          ],
        },
      ),
    );
    const synthetic = {
      name: 'br',
      role: 'orchestrator',
      shortName: 'br',
      displayName: 'BR',
      icon: ':eyes:',
    };
    expect(orchestrator(config, 0, 'review')).toBe('rev');
    expect(orchestrator(config, 0, 'qa')).toBe('br');
    expect(orchestrator(config, 1, 'review')).toBe('br');
    expect(orchestrator(config, 1, 'qa')).toBe('none');
    expect(config.projects[0]?.spurProjects).toStrictEqual([
      { name: 'rev', role: 'orchestrator' },
      synthetic,
    ]);
    expect(config.projects[1]?.spurProjects).toStrictEqual([synthetic]);
    expect(config.projects[2]?.spurProjects).toStrictEqual([]);
    expect(config.projects[2]?.columns.map((column) => column.orchestrator)).toEqual([
      'none',
      'none',
      'none',
    ]);
    expect(config.spurProjects).toEqual([
      {
        name: 'br',
        role: 'orchestrator',
        columns: ['review', 'qa'],
        shortName: 'br',
        displayName: 'BR',
        icon: ':eyes:',
      },
    ]);
  });

  it('keeps a column bound to the operator literal', () => {
    const config = configSchema.parse(
      boardWide([br], {
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', orchestrator: 'operator' },
          ...columns('done'),
        ],
      }),
    );
    expect(orchestrator(config, 0, 'review')).toBe('operator');
    expect(config.projects[0]?.spurProjects).toEqual([]);
    expect(orchestrator(config, 1, 'review')).toBe('br');
  });

  it('adds the board-wide operator only to board projects without their own', () => {
    const config = configSchema.parse(
      boardWide([{ name: 'hq', role: 'operator' }], {
        spurProjects: [{ name: 'web-ops', role: 'operator' }],
      }),
    );
    expect(config.projects[0]?.spurProjects).toStrictEqual([{ name: 'web-ops', role: 'operator' }]);
    expect(config.projects[1]?.spurProjects).toStrictEqual([{ name: 'hq', role: 'operator' }]);
  });

  it('lists the effective bindings of the requested board projects with their sources', () => {
    const config = configSchema.parse(
      boardWide(
        [br, { name: 'hq', role: 'operator' }],
        {
          spurProjects: [
            { name: 'rev', role: 'orchestrator' },
            { name: 'web-ops', role: 'operator' },
          ],
          columns: [
            ...columns('todo', 'dev'),
            { id: 'review', orchestrator: 'rev' },
            { id: 'qa', orchestrator: 'operator' },
            ...columns('done'),
          ],
        },
        { columns: columns('todo', 'dev', 'review', 'done') },
      ),
    );
    expect(configBindings(config, new Set(['web', 'api']))).toEqual({
      columns: [
        { project: 'web', column: 'review', orchestrator: 'rev', source: 'project' },
        { project: 'web', column: 'qa', orchestrator: 'operator', source: 'project' },
        { project: 'api', column: 'review', orchestrator: 'br', source: 'board-wide' },
      ],
      operators: [
        { project: 'web', operator: 'web-ops', source: 'project' },
        { project: 'api', operator: 'hq', source: 'board-wide' },
      ],
      defaultAddressee: { spurProject: 'hq', source: 'board-wide' },
    });
    expect(configBindings(config, new Set(['api']))).toMatchObject({
      columns: [{ project: 'api' }],
      operators: [{ project: 'api' }],
    });
  });

  it("lists another board project's operator while no board-wide operator exists", () => {
    const config = configSchema.parse(
      boardWide([], { spurProjects: [{ name: 'web-ops', role: 'operator' }] }),
    );
    expect(configBindings(config, new Set(['web', 'api'])).operators).toEqual([
      { project: 'web', operator: 'web-ops', source: 'project' },
      { project: 'api', operator: 'web-ops', source: 'other-project' },
    ]);
  });

  it.each<[string, Record<string, unknown>[], Record<string, unknown>[], unknown]>([
    [
      'both projects have an operator, no board-wide one',
      [],
      [{ name: 'api-ops', role: 'operator' }],
      [
        { project: 'web', operator: 'web-ops', source: 'project' },
        { project: 'web', operator: 'api-ops', source: 'other-project' },
        { project: 'api', operator: 'api-ops', source: 'project' },
        { project: 'api', operator: 'web-ops', source: 'other-project' },
      ],
    ],
    [
      'only one project has an operator, no board-wide one',
      [],
      [],
      [
        { project: 'web', operator: 'web-ops', source: 'project' },
        { project: 'api', operator: 'web-ops', source: 'other-project' },
      ],
    ],
    [
      'a board-wide operator exists',
      [{ name: 'hq', role: 'operator' }],
      [],
      [
        { project: 'web', operator: 'web-ops', source: 'project' },
        { project: 'api', operator: 'hq', source: 'board-wide' },
      ],
    ],
  ])('lists the operators acting on each project when %s', (_, top, api, operators) => {
    const config = configSchema.parse(
      boardWide(
        top,
        { spurProjects: [{ name: 'web-ops', role: 'operator' }] },
        { spurProjects: api },
      ),
    );
    expect(configBindings(config, new Set(['web', 'api'])).operators).toEqual(operators);
  });

  describe('defaultAddressee', () => {
    const hq = { name: 'hq', role: 'operator' };
    const alphaOps = { spurProjects: [{ name: 'alpha-ops', role: 'operator' }] };
    const named = { spurProjects: [{ name: 'cur', role: 'curator', shortName: 'cur' }] };

    it.each<[string, Record<string, unknown>, unknown]>([
      [
        'slack.defaultAddressee, which always wins',
        boardWide(
          [hq],
          { spurProjects: [{ name: 'alpha-ops', role: 'operator', shortName: 'ops' }] },
          {},
          { slack: { defaultAddressee: 'ops' } },
        ),
        { spurProject: 'alpha-ops', source: 'config' },
      ],
      [
        'a board-wide short name set as slack.defaultAddressee',
        boardWide(
          [{ ...br, shortName: 'br' }],
          alphaOps,
          {},
          { slack: { defaultAddressee: 'br' } },
        ),
        { spurProject: 'br', source: 'config' },
      ],
      [
        'the board-wide operator without any short name',
        boardWide([hq], alphaOps),
        { spurProject: 'hq', source: 'board-wide' },
      ],
      [
        'the board-wide operator with a short name set',
        boardWide([hq], {
          spurProjects: [{ name: 'alpha-ops', role: 'operator', shortName: 'a' }],
        }),
        { spurProject: 'hq', source: 'board-wide' },
      ],
      [
        "the first board project's operator once a short name is set",
        boardWide([], { spurProjects: [{ name: 'alpha-ops', role: 'operator', shortName: 'a' }] }),
        { spurProject: 'alpha-ops', source: 'project' },
      ],
      [
        'the operator of the first board project that has one',
        boardWide([], named, { spurProjects: [{ name: 'p2-ops', role: 'operator' }] }),
        { spurProject: 'p2-ops', source: 'project' },
      ],
      ['nothing without a short name or a board-wide operator', boardWide([], alphaOps), null],
      ['nothing without any operator', boardWide([], named), null],
    ])('is %s', (_name, input, expected) => {
      expect(defaultAddressee(configSchema.parse(input))).toEqual(expected);
    });
  });
});

describe('invalid configs', () => {
  it.each<[string, unknown, string, string]>([
    [
      'approvalWatch empty list',
      validConfig({ approvalWatch: [] }),
      'approvalWatch must list at least one entry',
      'projects[0].approvalWatch',
    ],
    [
      'approvalWatch not a list',
      validConfig({ approvalWatch: 'back/' }),
      'approvalWatch must be a list',
      'projects[0].approvalWatch',
    ],
    ...['a/b', '', 'back /', 'back//'].map((entry): [string, unknown, string, string] => [
      `approvalWatch entry ${JSON.stringify(entry)}`,
      validConfig({ approvalWatch: [entry] }),
      `approvalWatch entry ${JSON.stringify(entry)} is not allowed`,
      'projects[0].approvalWatch[0]',
    ]),
    ...['.', '..', './', '../'].map((entry): [string, unknown, string, string] => [
      `approvalWatch entry ${JSON.stringify(entry)}`,
      validConfig({ approvalWatch: [entry] }),
      `approvalWatch entry ${JSON.stringify(entry)} is not allowed`,
      'projects[0].approvalWatch[0]',
    ]),
    [
      'approvalWatch non-string entry',
      validConfig({ approvalWatch: [3] }),
      'approvalWatch entries must be strings',
      'projects[0].approvalWatch[0]',
    ],
    [
      'approvalWatch duplicate after the trailing slash',
      validConfig({ approvalWatch: ['back/', 'back'] }),
      'Duplicate approvalWatch entry "back": "back/" already names it',
      'projects[0].approvalWatch[1]',
    ],
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
      'plain-http Jira URL on a remote host',
      validConfig({ tracker: { ...jiraTracker, baseUrl: 'http://jira.example.com' } }),
      'http: is allowed only on a loopback host',
      'projects[0].tracker.baseUrl',
    ],
    [
      'nonpositive block threshold',
      validConfig({}, { thresholds: { blockOpenMs: 0 } }),
      'Too small',
      'thresholds.blockOpenMs',
    ],
    [
      'zero days before an unused operator access warning',
      validConfig({}, { operatorAccess: { unusedAfterDays: 0 } }),
      'Too small: expected number to be >=1',
      'operatorAccess.unusedAfterDays',
    ],
    [
      'over ten years before an unused operator access warning',
      validConfig({}, { operatorAccess: { unusedAfterDays: 3651 } }),
      'Too big: expected number to be <=3650',
      'operatorAccess.unusedAfterDays',
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
      validConfig({ columns: columns('todo', 'backlog', 'dev', 'done') }),
      'Unknown column "backlog": custom columns arrive with custom matchers and are not supported yet. Built-in columns: todo, triage, ready-for-dev, dev, review, product-review, external-review, qa, ready-to-merge, done',
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
      'resolved threads required on done',
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'done', requireResolvedThreads: true }],
      }),
      'Column "done" cannot require resolved threads: set it on a column from dev to ready-to-merge',
      'projects[0].columns[2].requireResolvedThreads',
    ],
    [
      'resolved threads required on triage',
      validConfig({
        columns: [
          ...columns('todo'),
          { id: 'triage', requireResolvedThreads: true },
          ...columns('dev', 'done'),
        ],
      }),
      'Column "triage" cannot require resolved threads: set it on a column from dev to ready-to-merge',
      'projects[0].columns[1].requireResolvedThreads',
    ],
    [
      'approvalRule on review',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', approvalRule: 'github-rules' },
          ...columns('done'),
        ],
      }),
      'Column "review" cannot set approvalRule: approvalRule is allowed only on the external-review column',
      'projects[0].columns[2].approvalRule',
    ],
    [
      'approvalRule on qa',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'qa', approvalRule: 'any-approval' },
          ...columns('done'),
        ],
      }),
      'Column "qa" cannot set approvalRule: approvalRule is allowed only on the external-review column',
      'projects[0].columns[2].approvalRule',
    ],
    [
      'unknown approvalRule on external-review',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'external-review', approvalRule: 'two-approvals' },
          ...columns('done'),
        ],
      }),
      'Invalid option',
      'projects[0].columns[2].approvalRule',
    ],
    [
      'source on review',
      validConfig({
        tracker: githubTracker,
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', source: 'manual' },
          ...columns('done'),
        ],
      }),
      'Column "review" cannot set source: source is allowed only on the ready-for-dev column',
      'projects[0].columns[2].source',
    ],
    [
      'source on triage',
      validConfig({
        tracker: githubTracker,
        columns: [
          ...columns('todo'),
          {
            id: 'triage',
            source: { type: 'tracker', project: 'example-org/3', field: 'Status', value: 'Ready' },
          },
          ...columns('dev', 'done'),
        ],
      }),
      'Column "triage" cannot set source: source is allowed only on the ready-for-dev column',
      'projects[0].columns[1].source',
    ],
    [
      'tracker source on a jira project',
      validConfig({
        columns: [
          ...columns('todo'),
          {
            id: 'ready-for-dev',
            source: { type: 'tracker', project: 'example-org/3', field: 'Status', value: 'Ready' },
          },
          ...columns('dev', 'done'),
        ],
      }),
      'source type tracker needs a github-issues project: tracker "jira" has no GitHub Project to mirror',
      'projects[0].columns[1].source',
    ],
    [
      'tracker source on a disabled ready-for-dev',
      validConfig({
        tracker: githubTracker,
        columns: [
          ...columns('todo'),
          {
            id: 'ready-for-dev',
            enabled: false,
            source: { type: 'tracker', project: 'example-org/3', field: 'Status', value: 'Ready' },
          },
          ...columns('dev', 'done'),
        ],
      }),
      'Column "ready-for-dev" cannot mirror a GitHub Project while disabled: set enabled: true or remove source',
      'projects[0].columns[1].source',
    ],
    [
      'tracker source with a repository instead of a Project',
      validConfig({
        tracker: githubTracker,
        columns: [
          ...columns('todo'),
          {
            id: 'ready-for-dev',
            source: {
              type: 'tracker',
              project: 'example-org/web',
              field: 'Status',
              value: 'Ready',
            },
          },
          ...columns('dev', 'done'),
        ],
      }),
      'Expected owner/number, such as example-org/3',
      'projects[0].columns[1].source.project',
    ],
    [
      'built-in columns out of order',
      validConfig({ columns: columns('todo', 'dev', 'qa', 'review', 'done') }),
      'Column "review" is out of order: built-in columns go in the order todo, triage, ready-for-dev, dev, review, product-review, external-review, qa, ready-to-merge, done',
      'projects[0].columns[3].id',
    ],
    [
      'triage before todo',
      validConfig({ columns: columns('triage', 'todo', 'dev', 'done') }),
      'Column "todo" is out of order',
      'projects[0].columns[1].id',
    ],
    [
      'external review before product review',
      validConfig({ columns: columns('todo', 'dev', 'external-review', 'product-review', 'done') }),
      'Column "product-review" is out of order',
      'projects[0].columns[3].id',
    ],
    [
      'product review after QA',
      validConfig({ columns: columns('todo', 'dev', 'qa', 'product-review', 'done') }),
      'Column "product-review" is out of order',
      'projects[0].columns[3].id',
    ],
    [
      'external review after QA',
      validConfig({ columns: columns('todo', 'dev', 'qa', 'external-review', 'done') }),
      'Column "external-review" is out of order',
      'projects[0].columns[3].id',
    ],
    [
      'product review before dev',
      validConfig({ columns: columns('todo', 'product-review', 'dev', 'done') }),
      'Column "dev" is out of order',
      'projects[0].columns[2].id',
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
      'unknown courseCheckTo',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', courseCheckTo: 'ghost' },
          ...columns('done'),
        ],
      }),
      'Unknown courseCheckTo "ghost": use operator or a spurProjects name',
      'projects[0].columns[2].courseCheckTo',
    ],
    [
      'courseCheckTo that orchestrates nothing',
      validConfig({
        spurProjects: [{ name: 'qa-bot', role: 'worker' }],
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', courseCheckTo: 'qa-bot' },
          ...columns('done'),
        ],
      }),
      'courseCheckTo "qa-bot" is not the curator and orchestrates no column: use operator, the curator or a column orchestrator',
      'projects[0].columns[2].courseCheckTo',
    ],
    [
      'courseCheckTo naming a project called none',
      validConfig({
        spurProjects: [{ name: 'none', role: 'worker' }],
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', courseCheckTo: 'none' },
          ...columns('done'),
        ],
      }),
      'courseCheckTo "none" is not the curator and orchestrates no column: use operator, the curator or a column orchestrator',
      'projects[0].columns[2].courseCheckTo',
    ],
    [
      'zero column cycle limit',
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'review', cycleLimit: 0 }, ...columns('done')],
      }),
      'Too small: expected number to be >=1',
      'projects[0].columns[2].cycleLimit',
    ],
    [
      'fractional column cycle limit',
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'review', cycleLimit: 1.5 }, ...columns('done')],
      }),
      'Invalid input: expected int, received number',
      'projects[0].columns[2].cycleLimit',
    ],
    [
      'negative column course check',
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'review', courseCheck: -1 }, ...columns('done')],
      }),
      'Too small: expected number to be >=0',
      'projects[0].columns[2].courseCheck',
    ],
    [
      'fractional column course check',
      validConfig({
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', courseCheck: 1.5 },
          ...columns('done'),
        ],
      }),
      'Invalid input: expected int, received number',
      'projects[0].columns[2].courseCheck',
    ],
    [
      'an unknown dispatcher mode',
      validConfig({ dispatcher: { mode: 'off' } }),
      'Invalid option: expected one of "shadow"|"on"',
      'projects[0].dispatcher.mode',
    ],
    [
      'a zero submit confirmation bound',
      validConfig({ dispatcher: { submitConfirmMs: 0 } }),
      'Too small: expected number to be >=1',
      'projects[0].dispatcher.submitConfirmMs',
    ],
    [
      'a repo without CI not in repos',
      validConfig({ reposWithoutCi: ['o/x'] }),
      'Repository "o/x" is not in repos',
      'projects[0].reposWithoutCi[0]',
    ],
    [
      'an invalid repo without CI',
      validConfig({ reposWithoutCi: ['web'] }),
      'Expected owner/name',
      'projects[0].reposWithoutCi[0]',
    ],
    [
      'github-issues with label and milestone',
      validConfig({ tracker: { ...githubTracker, label: 'board', milestone: 'v1' } }),
      'Set at most one of label or milestone',
      'projects[0].tracker.label',
    ],
    ...[
      ['branchPattern', '('],
      ['branchPattern', 'claude-([0-9]+)'],
      ['branchPattern', '^claude-'],
      ['branchPattern', '^(a)-(\\d+)'],
      ['branchPattern', '^([0-9]*)|\\'],
      ['titlePattern', '^[a-z]+(\\([^)]*\\))?!?: #([1-9][0-9]*)'],
      ['titlePattern', 'fix: #([0-9]+)'],
    ].map(([key, pattern]: string[]): [string, unknown, string, string] => [
      `link ${String(key)} ${String(pattern)}`,
      validConfig({
        tracker: { ...githubTracker, label: 'board' },
        link: { [String(key)]: pattern },
      }),
      'Expected a regular expression that starts with ^ and has exactly one capture group',
      `projects[0].link.${String(key)}`,
    ]),
    [
      'empty link sources',
      validConfig({ link: { sources: [] } }),
      'Too small: expected array to have >=1 items',
      'projects[0].link.sources',
    ],
    [
      'a duplicate link source',
      validConfig({ link: { sources: ['branch', 'branch'] } }),
      'Duplicate link source: "branch"',
      'projects[0].link.sources[1]',
    ],
    [
      'an unknown link source',
      validConfig({ link: { sources: ['body'] } }),
      'Invalid option: expected one of "closing"|"branch"|"title"',
      'projects[0].link.sources[0]',
    ],
    [
      'tracker.branchPattern',
      validConfig({
        tracker: { ...githubTracker, label: 'board', branchPattern: '^[A-Za-z]+-([1-9][0-9]*)' },
      }),
      'Unrecognized key: "branchPattern"',
      'projects[0].tracker',
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
      'second curator in one board project',
      validConfig({
        spurProjects: [
          { name: 'curator-a', role: 'curator' },
          { name: 'curator-b', role: 'curator' },
        ],
      }),
      'Second curator "curator-b": "curator-a" is already the curator of this board project',
      'projects[0].spurProjects[1].role',
    ],
    [
      'icon that is not an emoji shortcode',
      validConfig({ spurProjects: [{ name: 'cur', role: 'curator', icon: 'owl' }] }),
      'Expected an emoji shortcode such as :owl:',
      'projects[0].spurProjects[0].icon',
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
      'zero GitHub Issues interval',
      validConfig({}, { adapters: { githubIssues: { intervalMs: 0 } } }),
      'Too small: expected number to be >=1',
      'adapters.githubIssues.intervalMs',
    ],
    [
      'poll interval above one day (spur)',
      validConfig({}, { adapters: { spur: { intervalMs: 86_400_001 } } }),
      'Poll interval must be at most 86400000 ms (one day)',
      'adapters.spur.intervalMs',
    ],
    [
      'poll interval above one day (github)',
      validConfig({}, { adapters: { github: { intervalMs: 86_400_001 } } }),
      'Poll interval must be at most 86400000 ms (one day)',
      'adapters.github.intervalMs',
    ],
    [
      'poll interval above one day (githubIssues)',
      validConfig({}, { adapters: { githubIssues: { intervalMs: 86_400_001 } } }),
      'Poll interval must be at most 86400000 ms (one day)',
      'adapters.githubIssues.intervalMs',
    ],
    [
      'poll interval above one day (jira)',
      validConfig({}, { adapters: { jira: { intervalMs: 86_400_001 } } }),
      'Poll interval must be at most 86400000 ms (one day)',
      'adapters.jira.intervalMs',
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
      'zero turn-stall duration',
      validConfig({}, { health: { turnStallAfterMs: 0 } }),
      'Too small: expected number to be >=1',
      'health.turnStallAfterMs',
    ],
    [
      'negative turn-stall duration',
      validConfig({}, { health: { turnStallAfterMs: -1 } }),
      'Too small: expected number to be >=1',
      'health.turnStallAfterMs',
    ],
    [
      'zero error-after duration',
      validConfig({}, { health: { errorAfterMs: 0 } }),
      'Too small: expected number to be >=1',
      'health.errorAfterMs',
    ],
    [
      'zero turn waits',
      validConfig({}, { health: { turnWait: { maxWaits: 0 } } }),
      'Too small: expected number to be >=1',
      'health.turnWait.maxWaits',
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
    [
      'a short name repeated across two board projects',
      validConfig(
        {},
        {
          projects: [
            {
              ...jiraProject(),
              spurProjects: [{ name: 'cur-a', role: 'curator', shortName: 'cur' }],
            },
            {
              ...jiraProject(),
              id: 'api',
              spurProjects: [{ name: 'cur-b', role: 'curator', shortName: 'cur' }],
            },
          ],
        },
      ),
      'Duplicate short name: "cur"',
      'projects[1].spurProjects[0].shortName',
    ],
    [
      'a malformed short name',
      validConfig({ spurProjects: [{ name: 'cur', role: 'curator', shortName: '@Cur' }] }),
      'Expected a short name of lowercase letters',
      'projects[0].spurProjects[0].shortName',
    ],
    [
      'a default addressee that names no short name',
      validConfig(
        { spurProjects: [{ name: 'cur', role: 'curator', shortName: 'cur' }] },
        { slack: { defaultAddressee: 'qa' } },
      ),
      'Unknown short name "qa": set it as spurProjects[].shortName or projects[].spurProjects[].shortName first',
      'slack.defaultAddressee',
    ],
    [
      'a Spur project under two board projects',
      validConfig(
        {},
        {
          projects: [
            { ...jiraProject(), spurProjects: [{ name: 'shared', role: 'worker' }] },
            { ...jiraProject(), id: 'api', spurProjects: [{ name: 'shared', role: 'operator' }] },
          ],
        },
      ),
      'Spur project "shared" is listed under board projects "web" and "api": list it under only one',
      'projects[1].spurProjects[0].name',
    ],
    [
      'a duplicate board-wide Spur project name',
      boardWide([br, { ...br, columns: ['qa'] }]),
      'Duplicate spur project name: "br"',
      'spurProjects[1].name',
    ],
    [
      'a board-wide Spur project named none',
      boardWide([{ ...br, name: 'none' }]),
      'Spur project name "none" is reserved for columns[].orchestrator',
      'spurProjects[0].name',
    ],
    [
      'a board-wide Spur project named operator',
      boardWide([{ name: 'operator', role: 'operator' }]),
      'Spur project name "operator" is reserved for columns[].orchestrator',
      'spurProjects[0].name',
    ],
    [
      'a column bound by two board-wide orchestrators',
      boardWide([
        { name: 'a', role: 'orchestrator', columns: ['review'] },
        { name: 'b', role: 'orchestrator', columns: ['qa', 'review'] },
      ]),
      'Column "review" is bound board-wide by "a" and "b": bind it once',
      'spurProjects[1].columns[1]',
    ],
    [
      'a board-wide Spur project also listed under a board project',
      boardWide([br], { spurProjects: [{ name: 'br', role: 'worker' }] }),
      'Spur project "br" is bound board-wide in spurProjects and listed under projects[web].spurProjects as worker: remove one; a board-wide Spur project serves every board project it binds',
      'projects[0].spurProjects[0].name',
    ],
    [
      'a board-wide orchestrator that executes no column',
      boardWide(
        [br],
        {
          spurProjects: [{ name: 'rev', role: 'orchestrator' }],
          columns: [
            ...columns('todo', 'dev'),
            { id: 'review', orchestrator: 'rev' },
            ...columns('done'),
          ],
        },
        {
          columns: [
            ...columns('todo', 'dev'),
            { id: 'review', enabled: false },
            ...columns('done'),
          ],
        },
      ),
      'Board-wide orchestrator "br" executes no column: in every board project each listed column is missing, disabled or bound to another orchestrator',
      'spurProjects[0].columns',
    ],
    [
      'a second board-wide operator',
      boardWide([
        { name: 'hq', role: 'operator' },
        { name: 'hq-2', role: 'operator' },
      ]),
      'Second board-wide operator "hq-2": "hq" is already the board-wide operator',
      'spurProjects[1].role',
    ],
    [
      'a board-wide operator while every board project has its own',
      boardWide(
        [{ name: 'hq', role: 'operator' }],
        { spurProjects: [{ name: 'web-ops', role: 'operator' }] },
        { spurProjects: [{ name: 'api-ops', role: 'operator' }] },
      ),
      'Board-wide operator "hq" serves no board project: every board project lists its own operator',
      'spurProjects[0].name',
    ],
    [
      'a board-wide orchestrator without columns',
      boardWide([{ name: 'br', role: 'orchestrator' }]),
      'Board-wide orchestrator "br" needs columns: list the columns it executes',
      'spurProjects[0].columns',
    ],
    [
      'a board-wide orchestrator with an empty column list',
      boardWide([{ ...br, columns: [] }]),
      'Board-wide orchestrator "br" needs columns: list the columns it executes',
      'spurProjects[0].columns',
    ],
    [
      'a board-wide operator with columns',
      boardWide([{ name: 'hq', role: 'operator', columns: ['review'] }]),
      'Board-wide operator "hq" takes no columns',
      'spurProjects[0].columns',
    ],
    [
      'a column listed twice by one board-wide orchestrator',
      boardWide([{ ...br, columns: ['review', 'review'] }]),
      'Duplicate column: "review"',
      'spurProjects[0].columns',
    ],
    [
      'an unknown board-wide column',
      boardWide([{ ...br, columns: ['bogus'] }]),
      'Unknown column "bogus"',
      'spurProjects[0].columns[0]',
    ],
    [
      'a board-wide short name taken by a board project',
      boardWide([{ ...br, shortName: 'cur' }], {
        spurProjects: [{ name: 'cur', role: 'curator', shortName: 'cur' }],
      }),
      'Duplicate short name: "cur"',
      'spurProjects[0].shortName',
    ],
    [
      'a short name repeated across board-wide Spur projects',
      boardWide([
        { ...br, shortName: 'x' },
        { name: 'hq', role: 'operator', shortName: 'x' },
      ]),
      'Duplicate short name: "x"',
      'spurProjects[1].shortName',
    ],
    [
      'a board-wide worker',
      boardWide([{ name: 'w', role: 'worker' }]),
      'Invalid option: expected one of "orchestrator"|"operator"',
      'spurProjects[0].role',
    ],
    [
      'a board-wide curator',
      boardWide([{ name: 'c', role: 'curator' }]),
      'Invalid option: expected one of "orchestrator"|"operator"',
      'spurProjects[0].role',
    ],
    [
      'courseCheckTo naming a board-wide orchestrator',
      boardWide([br], {
        columns: [
          ...columns('todo', 'dev'),
          { id: 'review', courseCheckTo: 'br' },
          ...columns('done'),
        ],
      }),
      'Unknown courseCheckTo "br": use operator or a spurProjects name',
      'projects[0].columns[2].courseCheckTo',
    ],
  ])('rejects %s', (_name, input, message, path) => {
    const error = errorFor(input);
    expect(error).toContain(message);
    expect(pathLines(error)).toContain(`→ at ${path}`);
  });

  it.each<[string, Record<string, unknown>]>([
    ['qa', { checksGate: 'qa' }],
    [
      'a disabled review',
      {
        columns: [...columns('todo', 'dev'), { id: 'review', enabled: false }, ...columns('done')],
        checksGate: 'review',
      },
    ],
    ['an absent review', { columns: columns('todo', 'dev', 'done'), checksGate: 'review' }],
  ])('rejects checksGate on %s at projects[0].checksGate', (_name, project) => {
    const result = configSchema.safeParse(validConfig(project));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(['projects', 0, 'checksGate']);
    expect(result.error?.issues[0]?.message).toContain('checksGate');
    expect(result.error?.issues[0]?.message).toContain(
      'dev, review, product-review, external-review',
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unfilled none column', { id: 'review' }, 'in project web use one of qa'],
    ['an operator column', { id: 'review', orchestrator: 'operator' }, 'use one of qa'],
    [
      'a disabled named column',
      { id: 'review', orchestrator: 'qa-bot', enabled: false },
      'use one of qa',
    ],
  ])('rejects turn timings on %s at the column key', (_name, review, allowed) => {
    for (const key of ['quietTurnAfterMs', 'noRecipientAfterMs']) {
      const result = configSchema.safeParse(
        validConfig({
          spurProjects: [{ name: 'qa-bot', role: 'orchestrator' }],
          columns: [
            ...columns('todo', 'dev'),
            { ...review, [key]: 60_000 },
            { id: 'qa', orchestrator: 'qa-bot' },
            ...columns('done'),
          ],
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(result.error?.issues[0]?.path).toEqual(['projects', 0, 'columns', 2, key]);
      expect(result.error?.issues[0]?.message).toContain(
        `${key} is allowed only on an enabled column with a named orchestrator`,
      );
      expect(result.error?.issues[0]?.message).toContain(allowed);
    }
  });

  it('names a project without named orchestrator columns in the turn timings error', () => {
    const result = configSchema.safeParse(
      validConfig({
        columns: [...columns('todo', 'dev'), { id: 'qa', quietTurnAfterMs: 1 }, ...columns('done')],
      }),
    );
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual([
      'projects',
      0,
      'columns',
      2,
      'quietTurnAfterMs',
    ]);
    expect(result.error?.issues[0]?.message).toContain('project web has none');
  });

  it('rejects the reserved project id with one issue', () => {
    const result = configSchema.safeParse(validConfig({ id: RESERVED_PROJECT }));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(['projects', 0, 'id']);
    expect(result.error?.issues[0]?.message).toContain('"_board" is reserved');
  });

  it('rejects a non-http Jira URL with one issue', () => {
    const result = configSchema.safeParse(
      validConfig({ tracker: { ...jiraTracker, baseUrl: 'file:///x' } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(['projects', 0, 'tracker', 'baseUrl']);
    expect(result.error?.issues[0]?.message).toContain('Invalid URL');
    expect(result.error?.issues[0]?.message).not.toContain('loopback');
  });

  it('rejects an unknown root key without a path', () => {
    const error = errorFor(validConfig({}, { bogus: 1 }));
    expect(error).toContain('Unrecognized key: "bogus"');
    expect(error).not.toContain('→ at');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['a project with id board', { id: 'board' }, {}],
    ['time zone UTC', {}, { digest: { tz: 'UTC' } }],
    ['Jira project keys', { tracker: { ...jiraTracker, projectKeys: ['PROJ'] } }, {}],
    [
      'plain-http Jira on localhost',
      { tracker: { ...jiraTracker, baseUrl: 'http://localhost:8080' } },
      {},
    ],
    [
      'plain-http Jira on 127.0.0.1',
      { tracker: { ...jiraTracker, baseUrl: 'http://127.0.0.1:8080' } },
      {},
    ],
    ['plain-http Jira on [::1]', { tracker: { ...jiraTracker, baseUrl: 'http://[::1]:8080' } }, {}],
    ['github-issues with only a label', { tracker: { ...githubTracker, label: 'board' } }, {}],
    ['github-issues with only a milestone', { tracker: { ...githubTracker, milestone: 'v1' } }, {}],
    ['github-issues with neither label nor milestone', { tracker: githubTracker }, {}],
    [
      'a custom github-issues link',
      {
        tracker: { ...githubTracker, label: 'board' },
        link: {
          sources: ['title', 'branch'],
          branchPattern: '^task/([1-9][0-9]*)$',
          titlePattern: '^#([0-9]+) ',
        },
      },
      {},
    ],
    [
      'the default link set explicitly',
      {
        tracker: { ...githubTracker, label: 'board' },
        link: {
          sources: ['closing', 'branch', 'title'],
          branchPattern: '^[A-Za-z]+-([1-9][0-9]*)',
          titlePattern: '^[a-z]+(?:\\([^)]*\\))?!?: #([1-9][0-9]*)',
        },
      },
      {},
    ],
    [
      'a link pattern with a named group',
      { tracker: { ...githubTracker, label: 'board' }, link: { branchPattern: '^(?<n>[0-9]+)-' } },
      {},
    ],
    [
      'a link pattern with a nested repeat',
      {
        tracker: { ...githubTracker, label: 'board' },
        link: { branchPattern: '^(?:a+)+-([0-9]+)' },
      },
      {},
    ],
    ['a link section on a Jira project', { link: { sources: ['closing', 'title'] } }, {}],
    ['a board without the optional columns', { columns: columns('todo', 'dev', 'done') }, {}],
    [
      'disabled optional columns',
      { columns: [...columns('todo', 'dev'), { id: 'qa', enabled: false }, ...columns('done')] },
      {},
    ],
    [
      'a column cycle limit',
      { columns: [...columns('todo', 'dev'), { id: 'review', cycleLimit: 3 }, ...columns('done')] },
      {},
    ],
    ['only product review', { columns: columns('todo', 'dev', 'product-review', 'done') }, {}],
    ['only external review', { columns: columns('todo', 'dev', 'external-review', 'done') }, {}],
    [
      'both review columns between review and QA',
      {
        columns: columns(
          'todo',
          'dev',
          'review',
          'product-review',
          'external-review',
          'qa',
          'done',
        ),
      },
      {},
    ],
    ['poll interval of one day (spur)', {}, { adapters: { spur: { intervalMs: 86_400_000 } } }],
    ['poll interval of one day (github)', {}, { adapters: { github: { intervalMs: 86_400_000 } } }],
    [
      'poll interval of one day (githubIssues)',
      {},
      { adapters: { githubIssues: { intervalMs: 86_400_000 } } },
    ],
    ['poll interval of one day (jira)', {}, { adapters: { jira: { intervalMs: 86_400_000 } } }],
    [
      'a board-wide orchestrator and operator',
      {},
      { spurProjects: [br, { name: 'hq', role: 'operator', displayName: 'HQ', icon: ':office:' }] },
    ],
    [
      'a default addressee naming a board-wide short name',
      {},
      { spurProjects: [{ ...br, shortName: 'br' }], slack: { defaultAddressee: 'br' } },
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
      '.adapters.githubIssues.intervalMs',
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
      '.health.turnStallAfterMs',
      '.health.turnWait.maxTotalMs',
      '.projects[].columns[].noRecipientAfterMs',
      '.projects[].columns[].quietTurnAfterMs',
      '.projects[].dispatcher.submitConfirmMs',
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

describe('web and stand configuration', () => {
  it.each(['jira-project.yaml', 'github-issues-project.yaml'])(
    'keeps %s web off with an implicit range',
    (fixture) => {
      const config = configSchema.parse(readFixture(fixture));
      expect(config.web).toEqual({});
      expect(config.stand.portRange).toBeUndefined();
      expect(config.stand.portRange ?? DEFAULT_STAND_PORT_RANGE).toEqual({ min: 4780, max: 4799 });
    },
  );

  it.each([0, 4780, 4799])('preserves legacy stand HTTP port %s', (port) => {
    expect(configSchema.parse(validConfig({}, { http: { port } })).http.port).toBe(port);
  });

  it.each([
    [{}, undefined],
    [{ stand: {} }, undefined],
    [{ stand: { portRange: {} } }, { min: 4780, max: 4799 }],
    [{ stand: { portRange: { min: 4790 } } }, { min: 4790, max: 4799 }],
    [{ stand: { portRange: { max: 4785 } } }, { min: 4780, max: 4785 }],
    [
      { stand: { portRange: { min: 1024, max: 65535 } }, http: { port: 0 } },
      { min: 1024, max: 65535 },
    ],
    [{ stand: { portRange: { min: 4800, max: 4800 } } }, { min: 4800, max: 4800 }],
  ])('preserves explicit range provenance for %j', (root, expected) => {
    expect(configSchema.parse(validConfig({}, root)).stand.portRange).toEqual(expected);
  });

  const web = { port: 7777, publicOrigin: 'http://localhost:{port}' };
  it.each<[Record<string, unknown>, string]>([
    [{ web: { port: 7777 } }, 'web.publicOrigin'],
    [{ web: { publicOrigin: 'https://example.test' } }, 'web.port'],
    [{ web: { ...web, port: 4777 } }, 'web.port'],
    [{ http: { port: 0 }, web: { ...web, port: 0 } }, 'web.port'],
    ...[-1, 65536, 1.5].map<[Record<string, unknown>, string]>((port) => [
      { web: { ...web, port } },
      'web.port',
    ]),
    [{ web: { ...web, extra: true } }, 'web'],
    [{ stand: { extra: true } }, 'stand'],
    [{ stand: { portRange: { extra: true } } }, 'stand.portRange'],
    ...[{ min: 1023 }, { max: 65536 }, { min: 4780.5 }, { min: 4800, max: 4799 }].map<
      [Record<string, unknown>, string]
    >((portRange) => [{ stand: { portRange } }, 'stand.portRange']),
  ])('rejects invalid sections %j at %s', (root, path) => {
    expect(errorFor(validConfig({}, root))).toContain(`→ at ${path}`);
  });

  it.each([undefined, 'worker'])(
    'checks inclusive collisions with addressee %s',
    (defaultAddressee) => {
      for (const port of [4780, 4799]) {
        const root = {
          slack: defaultAddressee === undefined ? {} : { defaultAddressee },
          stand: { portRange: {} },
        };
        const project = { spurProjects: [{ name: 'worker', role: 'worker', shortName: 'worker' }] };
        for (const listeners of [
          { http: { port } },
          { web: { ...web, port } },
          { http: { port }, web: { ...web, port: port === 4780 ? 4799 : 4780 } },
        ]) {
          const error = errorFor(validConfig(project, { ...root, ...listeners }));
          expect(error).toContain('→ at stand.portRange');
          expect(error).toContain('Stand port range includes');
        }
      }
    },
  );

  it.each([
    'https://example.test/',
    'https://example.test/path',
    'https://example.test?query',
    'https://example.test#fragment',
    'https://user:pass@example.test',
    'https://@example.test',
    'https://example.test:{unknown}',
    'https://{port.example.test',
    'https://example.test}',
    'https://example.test/{port}',
    ' https://example.test',
    'https://example.test\n',
    'https:////example.test',
    'https://example.test:bad',
    'https://example.test\\path',
  ])('rejects raw invalid origin %j for API and UI', (value) => {
    expect(errorFor(validConfig({}, { web: { ...web, publicOrigin: value } }))).toContain(
      '→ at web.publicOrigin',
    );
    expect(errorFor(validConfig({}, { web: { spurUiOrigin: value } }))).toContain(
      '→ at web.spurUiOrigin',
    );
  });

  it.each([
    'http://localhost',
    'http://127.1.2.3:7777',
    'http://[::1]:7777',
    'https://example.test',
  ])('allows bare origin %s independently for UI', (value) => {
    expect(configSchema.parse(validConfig({}, { web: { spurUiOrigin: value } })).web).toEqual({
      spurUiOrigin: value,
    });
    expect(
      configSchema.parse(validConfig({}, { web: { ...web, publicOrigin: value } })).web
        .publicOrigin,
    ).toBe(value);
  });

  it.each(['http://example.test', 'http://192.0.2.1:8080'])(
    'allows HTTP UI on any host while rejecting the public API origin %s',
    (value) => {
      expect(
        configSchema.parse(validConfig({}, { web: { spurUiOrigin: value } })).web.spurUiOrigin,
      ).toBe(value);
      expect(errorFor(validConfig({}, { web: { ...web, publicOrigin: value } }))).toContain(
        '→ at web.publicOrigin',
      );
    },
  );

  it('validates substitutions using the configured port', () => {
    const config = configSchema.parse(
      validConfig({}, { web: { port: 1, publicOrigin: 'http://127.0.0.{port}' } }),
    );
    expect(resolveWebOrigin(config.web)).toBe('http://127.0.0.1');
    expect(
      errorFor(
        validConfig({}, { web: { port: 65535, publicOrigin: 'https://example.test:{port}0' } }),
      ),
    ).toContain('→ at web.publicOrigin');
  });

  it.each([
    ['HTTP loopback becomes public', 127, 'http://{port}.0.0.1', 128],
    ['effective IPv4 host is malformed', 1, 'https://127.0.0.{port}', 256],
    ['effective port exceeds bounds', 1, 'https://example.test:{port}0', 65535],
    ...[-1, 65536, 1.5, NaN, Infinity, -Infinity].map<[string, number, string, number]>(
      (actualPort) => [
        `invalid numeric override ${String(actualPort)}`,
        7777,
        'https://example.test',
        actualPort,
      ],
    ),
  ] as const)('refuses invalid actual origin: %s', (_label, port, publicOrigin, actualPort) => {
    const config = configSchema.parse(validConfig({}, { web: { port, publicOrigin } }));
    const before = structuredClone(config.web);
    expect(resolveWebOrigin(config.web, actualPort)).toBeUndefined();
    expect(config.web).toEqual(before);
  });

  it.each([
    [127, 'http://{port}.0.0.1', 127, 'http://127.0.0.1'],
    [127, 'https://{port}.0.0.1', 128, 'https://128.0.0.1'],
    [0, 'http://localhost:{port}', 65535, 'http://localhost:65535'],
    [7777, 'https://example.test', 0, 'https://example.test'],
    [7777, 'https://{port}.local.example:{port}', 443, 'https://443.local.example'],
  ] as const)(
    'keeps valid actual origin %s %s at %s',
    (port, publicOrigin, actualPort, expected) => {
      const config = configSchema.parse(validConfig({}, { web: { port, publicOrigin } }));
      expect(resolveWebOrigin(config.web, actualPort)).toBe(expected);
    },
  );

  it('rejects placeholders for the UI', () => {
    expect(
      errorFor(validConfig({}, { web: { spurUiOrigin: 'https://{port}.example.test' } })),
    ).toContain('→ at web.spurUiOrigin');
  });

  it.each([
    ['http://localhost:{port}', undefined, 'http://localhost:7777'],
    ['https://{port}.local.example', undefined, 'https://7777.local.example'],
    ['https://{port}.local.example:{port}', 8888, 'https://8888.local.example:8888'],
    ['https://EXAMPLE.test:443', undefined, 'https://example.test'],
    ['http://localhost:{port}', 0, 'http://localhost:0'],
  ])('resolves %s with override %s', (publicOrigin, actualPort, expected) => {
    const config = configSchema.parse(validConfig({}, { web: { ...web, publicOrigin } }));
    const before = structuredClone(config.web);
    expect(resolveWebOrigin(config.web, actualPort)).toBe(expected);
    expect(config.web).toEqual(before);
    expect(resolveWebOrigin({})).toBeUndefined();
  });
});
