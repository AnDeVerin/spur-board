import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import type { DoctorCheck, DoctorPorts } from '../src/doctor.ts';

const yaml = `projects:
  - id: board
    tracker:
      type: github-issues
      repo: example/board
      label: board
    repos: [example/board]
    operatorGithubLogin: operator
    spurProjects:
      - name: worker
        role: worker
operator:
  slack: U0000000000
slack:
  channels:
    feed: C000000002
digest:
  tz: UTC
`;
const remoteIds = [
  'secrets',
  'jira.credentials',
  'github.credentials',
  'spur.api',
  'slack.auth',
  'slack.orchestrators_member',
  'slack.feed_member',
  'slack.command',
  'operator.path',
];
const stamp = JSON.stringify({ version: '1.2.3', installedAt: '2026-11-04T09:00:00.000Z' });

function capture() {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout(text) {
      stdout += text;
    },
    stderr(text) {
      stderr += text;
    },
  };
  return { io, output: () => stdout, errors: () => stderr };
}

function ports(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  return {
    readText(path) {
      if (path.endsWith('config.yaml')) return yaml;
      if (path.endsWith('secrets.env'))
        return 'SLACK_BOT_TOKEN=bot-test-value\nSLACK_APP_TOKEN=app-test-value\nGITHUB_TOKEN=github-test-value\n';
      if (path.endsWith('spur-board.service'))
        return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
      if (path.endsWith('.spur-board-install.json')) return stamp;
      throw new Error('missing');
    },
    secretFile: (path) => ({ path, isFile: true, mode: 0o600 }),
    listDir: () => [],
    exists: () => true,
    run: () => ({ exitCode: 0, stdout: '1.2.3\n' }),
    sessions: () => [
      {
        id: 'worker-1',
        project: 'worker',
        path: '/usr/bin',
        codexHome: '/codex',
        startAt: Date.parse('2026-11-04T10:00:00.000Z'),
      },
    ],
    fetcher: () =>
      Promise.resolve(
        Response.json({
          version: '1.2.3',
          checks: remoteIds.map((id): DoctorCheck => ({
            id,
            status: 'pass',
            blocking: false,
            fix: null,
          })),
        }),
      ),
    productVersion: () => '1.2.3',
    ...overrides,
  };
}

async function run(args: string[], fake: DoctorPorts) {
  const output = capture();
  const exitCode = await runCli(args, {
    io: output.io,
    env: { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
    home: '/home',
    doctor: fake,
  });
  return { exitCode, checks: JSON.parse(output.output()) as DoctorCheck[], text: output.output() };
}

describe('board doctor', () => {
  it('returns every local and daemon check in JSON', async () => {
    const value = await run(['doctor', '--json'], ports());
    expect(value.exitCode).toBe(0);
    expect(value.checks.map((check) => check.id)).toEqual([
      'config',
      'service.installed',
      'service.node',
      'service.running',
      'flock',
      'path.current',
      'path.spur',
      'skills.codex_visibility',
      'sessions.stale',
      'daemon.available',
      ...remoteIds,
      'versions',
    ]);
    expect(value.checks.every((check) => check.status === 'pass' && check.fix === null)).toBe(true);
    expect(value.checks.find((check) => check.id === 'secrets')?.present).toEqual([
      'GITHUB_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
    ]);
  });

  it('lists present secret names in text while hiding their values', async () => {
    const output = capture();
    const exitCode = await runCli(['doctor'], {
      io: output.io,
      env: { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
      home: '/home',
      doctor: ports(),
    });
    expect(exitCode).toBe(0);
    expect(output.output()).toContain(
      'PASS secrets (present: GITHUB_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN)',
    );
    expect(output.output()).not.toContain('bot-test-value');
    expect(output.output()).not.toContain('app-test-value');
    expect(output.output()).not.toContain('github-test-value');
  });

  it.each([
    ['Slack-free config', '', 'pass', null, 0],
    ['pre-channel Slack setup', 'slack:\n  appId: A123ABC\n', 'pass', null, 0],
  ] as const)('checks secret names for %s', async (_case, slackSection, status, fix, exitCode) => {
    const config = yaml.replace('slack:\n  channels:\n    feed: C000000002\n', slackSection);
    const value = await run(
      ['doctor', '--json'],
      ports({
        fetcher: () =>
          Promise.resolve(
            Response.json({
              version: '1.2.3',
              checks: [
                ...remoteIds.filter((id) => !id.startsWith('slack.')),
                'slack.configured',
              ].map((id): DoctorCheck =>
                id === 'slack.configured'
                  ? {
                      id,
                      status: 'warning',
                      blocking: false,
                      fix: 'Slack is not configured: questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to configure slack.channels.',
                    }
                  : { id, status: 'pass', blocking: false, fix: null },
              ),
            }),
          ),
        readText(path) {
          if (path.endsWith('config.yaml')) return config;
          if (path.endsWith('secrets.env')) return 'GITHUB_TOKEN=github-test-value\n';
          if (path.endsWith('spur-board.service'))
            return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
          if (path.endsWith('.spur-board-install.json')) return stamp;
          throw new Error('missing');
        },
      }),
    );
    expect(value.exitCode).toBe(exitCode);
    expect(value.checks.find((check) => check.id === 'secrets')).toMatchObject({
      status,
      present: ['GITHUB_TOKEN'],
      fix,
    });
    expect(value.checks.filter((check) => check.id.startsWith('slack.'))).toEqual([
      expect.objectContaining({ id: 'slack.configured', status: 'warning', blocking: false }),
    ]);
  });

  it('reports one Slack setup warning when a Slack-free daemon is unavailable', async () => {
    const config = yaml.replace('slack:\n  channels:\n    feed: C000000002\n', '');
    const value = await run(
      ['doctor', '--json'],
      ports({
        fetcher: () => Promise.reject(new Error('daemon unavailable')),
        readText(path) {
          if (path.endsWith('config.yaml')) return config;
          if (path.endsWith('secrets.env')) return 'GITHUB_TOKEN=github-test-value\n';
          if (path.endsWith('spur-board.service'))
            return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
          if (path.endsWith('.spur-board-install.json')) return stamp;
          throw new Error('missing');
        },
      }),
    );
    expect(value.exitCode).toBe(1);
    expect(value.checks.find((check) => check.id === 'daemon.available')).toMatchObject({
      status: 'fail',
    });
    const slackChecks = value.checks.filter((check) => check.id.startsWith('slack.'));
    expect(slackChecks).toMatchObject([
      { id: 'slack.configured', status: 'warning', blocking: false },
    ]);
    expect(slackChecks).toHaveLength(1);
    expect(slackChecks[0]?.fix).toContain('spur-board-setup');
  });

  it('checks the resolved secrets filename even when the daemon reports healthy', async () => {
    const secretFile = vi.fn((path: string): ReturnType<DoctorPorts['secretFile']> => {
      if (path.endsWith('secrets.env')) throw new Error('missing');
      return { path, isFile: true, mode: 0o600 };
    });
    const value = await run(
      ['doctor', '--json'],
      ports({
        secretFile,
        listDir: () => ['config.yaml', 'slack.env'],
      }),
    );
    expect(secretFile).toHaveBeenCalledWith('/board/secrets.env');
    expect(value.exitCode).toBe(1);
    expect(value.checks.find((check) => check.id === 'secrets')).toMatchObject({
      status: 'fail',
      blocking: true,
      present: [],
      fix: 'Create secrets.env with mode 0600; rename slack.env to secrets.env if it contains the intended tokens.',
    });
  });

  it('lists Jira key names when a Jira tracker is configured', async () => {
    const jiraYaml = yaml.replace(
      'type: github-issues\n      repo: example/board\n      label: board',
      'type: jira\n      baseUrl: https://jira.example.invalid\n      jql: project = BOARD\n      doneStatuses: [Done]\n      readyStatuses: [Ready]',
    );
    const value = await run(
      ['doctor', '--json'],
      ports({
        readText(path) {
          if (path.endsWith('config.yaml')) return jiraYaml;
          if (path.endsWith('secrets.env'))
            return 'GITHUB_TOKEN=github-test-value\nSLACK_BOT_TOKEN=bot-test-value\nSLACK_APP_TOKEN=app-test-value\nJIRA_EMAIL=jira-test-value\n';
          if (path.endsWith('spur-board.service'))
            return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
          if (path.endsWith('.spur-board-install.json')) return stamp;
          throw new Error('missing');
        },
      }),
    );
    expect(value.exitCode).toBe(1);
    expect(value.checks.find((check) => check.id === 'secrets')).toMatchObject({
      status: 'fail',
      present: ['GITHUB_TOKEN', 'JIRA_EMAIL', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
      fix: 'Add JIRA_API_TOKEN to the private secrets.env file.',
    });
    expect(value.text).not.toContain('jira-test-value');
  });

  it('uses only config validation offline and does not call any other port', async () => {
    const fake = ports({
      readText(path) {
        if (path.endsWith('config.yaml')) return yaml;
        throw new Error('offline touched another file');
      },
      exists: () => {
        throw new Error('offline filesystem check');
      },
      run: () => {
        throw new Error('offline process check');
      },
      sessions: () => {
        throw new Error('offline session check');
      },
      fetcher: () => {
        throw new Error('offline network check');
      },
      productVersion: () => {
        throw new Error('offline version check');
      },
    });
    const value = await run(['doctor', '--offline', '--json'], fake);
    expect(value.exitCode).toBe(0);
    expect(value.checks).toEqual([{ id: 'config', status: 'pass', blocking: false, fix: null }]);
  });

  it('returns a config fix and nonzero exit for invalid offline config', async () => {
    const fake = ports({ readText: () => 'projects: []\n' });
    const value = await run(['doctor', '--offline', '--json'], fake);
    expect(value.exitCode).toBe(1);
    expect(value.checks).toEqual([
      {
        id: 'config',
        status: 'fail',
        blocking: true,
        fix: 'Correct projects in config.yaml using the configuration schema.',
      },
    ]);
  });

  it.each([
    [
      'service.installed',
      'Run board service install.',
      {
        readText: (path: string) =>
          path.endsWith('spur-board.service')
            ? (() => {
                throw new Error('missing');
              })()
            : path.endsWith('config.yaml')
              ? yaml
              : stamp,
      },
    ],
    [
      'service.node',
      'Reinstall the service with a valid Node executable path.',
      { exists: (path: string) => path !== '/usr/bin/node' },
    ],
    [
      'service.running',
      'Start or restart the user service and inspect its journal.',
      { run: (command: string) => ({ exitCode: command === 'systemctl' ? 1 : 0, stdout: '' }) },
    ],
    [
      'flock',
      'Install flock from util-linux.',
      { run: (command: string) => ({ exitCode: command === 'flock' ? 1 : 0, stdout: '' }) },
    ],
    [
      'path.current',
      'Install board into the current PATH.',
      {
        run: (command: string, _args: readonly string[], env?: NodeJS.ProcessEnv) => ({
          exitCode: command === 'board' && env === undefined ? 1 : 0,
          stdout: '',
        }),
      },
    ],
    [
      'path.spur',
      'Install board into the live Spur session PATH.',
      {
        run: (command: string, _args: readonly string[], env?: NodeJS.ProcessEnv) => ({
          exitCode: command === 'board' && env !== undefined ? 1 : 0,
          stdout: '',
        }),
      },
    ],
    [
      'skills.codex_visibility',
      "Add .agents/skills/spur-board to the Spur project's symlinks in its config and start a new session.",
      {
        sessions: () => [
          {
            id: 'worker-1',
            project: 'worker',
            path: '/usr/bin',
            codexHome: '/codex',
            cwd: '/repo',
          },
        ],
        exists: (path: string) => !path.endsWith('/skills/spur-board/SKILL.md'),
      },
    ],
    [
      'versions',
      'Install matching CLI and skills versions, then restart the daemon.',
      { productVersion: () => '9.9.9' },
    ],
  ] as const)('gives a blocking fix for %s', async (id, fix, override) => {
    const value = await run(['doctor', '--json'], ports(override));
    const check = value.checks.find((entry) => entry.id === id);
    expect(check?.status).toBe('fail');
    expect(check?.fix).toBe(fix);
    expect(value.exitCode).toBe(1);
  });

  it.each([
    ['repo skill', '/repo/.agents/skills/spur-board/SKILL.md'],
    ['session CODEX_HOME skill', '/codex/skills/spur-board/SKILL.md'],
  ])('accepts a configured Codex session with the %s', async (_label, visibleSkill) => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [
          {
            id: 'worker-1',
            project: 'worker',
            path: '/usr/bin',
            codexHome: '/codex',
            cwd: '/repo',
          },
        ],
        exists: (path) => !path.endsWith('/skills/spur-board/SKILL.md') || path === visibleSkill,
      }),
    );
    expect(value.checks.find((check) => check.id === 'skills.codex_visibility')).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: null,
    });
  });

  it('warns about an absent Spur session without inventing a version mismatch', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [],
        fetcher: () => Promise.reject(new Error('daemon down')),
      }),
    );
    expect(value.checks.find((check) => check.id === 'path.spur')).toMatchObject({
      status: 'warning',
      blocking: false,
      fix: 'Start a Spur session, then rerun board doctor.',
    });
    expect(value.checks.find((check) => check.id === 'daemon.available')?.status).toBe('fail');
    expect(value.checks.find((check) => check.id === 'versions')).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: null,
    });
  });

  it('keeps local fixes and hides response errors when the daemon is unavailable', async () => {
    const secret = 'never-print-this-secret';
    const fake = ports({
      fetcher: vi.fn(() => Promise.reject(new Error(secret))),
      readText(path) {
        if (path.endsWith('config.yaml')) return yaml;
        if (path.endsWith('spur-board.service'))
          return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
        return stamp;
      },
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.exitCode).toBe(1);
    expect(value.checks.find((entry) => entry.id === 'daemon.available')?.fix).toBe(
      'Start or restart the user service.',
    );
    expect(value.checks.find((entry) => entry.id === 'service.installed')?.status).toBe('pass');
    expect(value.text).not.toContain(secret);

    const human = capture();
    const humanExit = await runCli(['doctor'], {
      io: human.io,
      env: { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
      home: '/home',
      doctor: fake,
    });
    expect(humanExit).toBe(1);
    expect(human.output()).toContain('FAIL daemon.available: Start or restart the user service.');
    expect(human.output()).not.toContain(secret);
    expect(human.errors()).not.toContain(secret);
  });

  it.each([
    [{ isFile: false, mode: 0o600 }, 'Make secrets.env a regular file with mode 0600.'],
    [{ isFile: true, mode: 0o644 }, 'Set secrets.env mode to 0600 with chmod 600.'],
  ])('refuses an unsafe resolved secrets file before reading it', async (info, fix) => {
    const fake = ports({
      fetcher: () => Promise.reject(new Error('daemon down')),
      secretFile: (path) => ({ path, ...info }),
      readText(path) {
        if (path.endsWith('config.yaml')) return yaml;
        if (path.endsWith('spur-board.service'))
          return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
        if (path.endsWith('secrets.env')) throw new Error('unsafe file was read');
        return stamp;
      },
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.checks.find((entry) => entry.id === 'secrets')).toMatchObject({
      status: 'fail',
      blocking: true,
      fix,
    });
  });

  it('names the missing Slack app token in local fallback', async () => {
    const fake = ports({
      fetcher: () => Promise.reject(new Error('daemon down')),
      readText(path) {
        if (path.endsWith('config.yaml')) return yaml;
        if (path.endsWith('spur-board.service'))
          return 'ExecStart="/usr/bin/node" "/app/daemon.mjs"\n';
        if (path.endsWith('secrets.env')) return 'GITHUB_TOKEN=present\nSLACK_BOT_TOKEN=present\n';
        return stamp;
      },
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.checks.find((entry) => entry.id === 'secrets')?.fix).toContain('SLACK_APP_TOKEN');
  });

  it('decodes the quoted unit executable once', async () => {
    const seen: string[] = [];
    const fake = ports({
      readText(path) {
        if (path.endsWith('config.yaml')) return yaml;
        if (path.endsWith('spur-board.service'))
          return 'ExecStart="/usr/bin/no\\\\\\"de" "/app/daemon.mjs"\n';
        return stamp;
      },
      exists(path) {
        seen.push(path);
        return path === '/usr/bin/no\\"de';
      },
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.checks.find((entry) => entry.id === 'service.node')?.status).toBe('pass');
    expect(seen).toContain('/usr/bin/no\\"de');
  });

  it('warns for confirmed stale sessions without failing doctor', async () => {
    const fake = ports({
      sessions: () => [
        {
          id: 'old',
          project: 'worker',
          path: '/usr/bin',
          codexHome: '/codex',
          startAt: Date.parse('2026-11-03T10:00:00.000Z'),
        },
      ],
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.exitCode).toBe(0);
    expect(value.checks.find((entry) => entry.id === 'sessions.stale')).toMatchObject({
      status: 'warning',
      blocking: false,
    });
    expect(value.checks.find((entry) => entry.id === 'sessions.stale')?.fix).toBe(
      'Restart sessions started before the last skill install: old; verify sessions whose start time is unavailable.',
    );
  });
});
