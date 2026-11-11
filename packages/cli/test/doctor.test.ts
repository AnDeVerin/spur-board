import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import type { DoctorCheck, DoctorPorts } from '../src/doctor.ts';
import { bindLoopback } from '../src/port.ts';
import { holder, trickler } from './http-holder.ts';

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
  'link.rules',
  'spur.api',
  'spur.send',
  'slack.auth',
  'slack.orchestrators_member',
  'slack.feed_member',
  'slack.command',
  'operator.path',
  'curator.sessions',
];
const stamp = JSON.stringify({ version: '1.2.3', installedAt: '2026-11-04T09:00:00.000Z' });
const spurYaml =
  'projects:\n  worker:\n    path: /main\n    symlinks: [.agents/skills/spur-board]\n';
const mainLink = '/main/.agents/skills/spur-board';
const codexFix =
  "Add .agents/skills/spur-board to the Spur project's symlinks in its config and start a new session.";
const spurFix =
  'Start Spur or correct adapters.spur.baseUrl in config.yaml, then rerun board doctor to check the Codex skill install.';
const daemonResponse = () =>
  Response.json({
    version: '1.2.3',
    checks: remoteIds.map((id): DoctorCheck => ({
      id,
      status: 'pass',
      blocking: false,
      fix: null,
    })),
  });

function isSpurProjects(input: Parameters<typeof fetch>[0]): boolean {
  return input instanceof URL && input.pathname.endsWith('/projects');
}

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
      if (path === '/main/spur.yaml') return spurYaml;
      throw new Error('missing');
    },
    secretFile: (path) => ({ path, isFile: true, mode: 0o600 }),
    listDir: () => [],
    exists: () => true,
    realPath: (path) => (path === mainLink ? '/home/.codex/skills/spur-board' : path),
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
    fetcher: (input) =>
      Promise.resolve(
        isSpurProjects(input) ? Response.json([{ id: 'worker', path: '/main' }]) : daemonResponse(),
      ),
    productVersion: () => '1.2.3',
    bind: () => Promise.resolve(null),
    ...overrides,
  };
}

async function run(
  args: string[],
  fake: DoctorPorts,
  env: NodeJS.ProcessEnv = { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
) {
  const output = capture();
  const exitCode = await runCli(args, {
    io: output.io,
    env,
    home: '/home',
    doctor: fake,
  });
  return { exitCode, checks: JSON.parse(output.output()) as DoctorCheck[], text: output.output() };
}

describe('board doctor', () => {
  it('exits with a blocking GitHub permission hint from the daemon', async () => {
    const fix =
      'Use a classic GitHub personal access token with the repo scope and SSO authorization.';
    const value = await run(
      ['doctor', '--json'],
      ports({
        fetcher: () =>
          Promise.resolve(
            Response.json({
              version: '1.2.3',
              checks: remoteIds.map((id): DoctorCheck =>
                id === 'github.credentials'
                  ? { id, status: 'fail', blocking: true, fix }
                  : { id, status: 'pass', blocking: false, fix: null },
              ),
            }),
          ),
      }),
    );
    expect(value.exitCode).toBe(1);
    expect(value.checks.find((check) => check.id === 'github.credentials')).toEqual({
      id: 'github.credentials',
      status: 'fail',
      blocking: true,
      fix,
    });
  });

  it('documents each check ID emitted with and without Slack exactly once', async () => {
    const configured = await run(['doctor', '--json'], ports());
    const withoutSlack = yaml.replace('slack:\n  channels:\n    feed: C000000002\n', '');
    const unconfigured = await run(
      ['doctor', '--json'],
      ports({
        readText(path) {
          if (path.endsWith('config.yaml')) return withoutSlack;
          if (path.endsWith('secrets.env')) return 'GITHUB_TOKEN=github-test-value\n';
          return ports().readText(path);
        },
        fetcher: () =>
          Promise.resolve(
            Response.json({
              version: '1.2.3',
              checks: [
                ...remoteIds.filter((id) => !id.startsWith('slack.')),
                'slack.configured',
              ].map((id): DoctorCheck => ({
                id,
                status: id === 'slack.configured' ? 'warning' : 'pass',
                blocking: false,
                fix: id === 'slack.configured' ? 'Configure Slack channels.' : null,
              })),
            }),
          ),
      }),
    );
    expect(configured.exitCode).toBe(0);
    expect(unconfigured.exitCode).toBe(0);
    const emitted = [
      ...new Set([...configured.checks, ...unconfigured.checks].map(({ id }) => id)),
    ].sort();
    const guide = readFileSync(new URL('../../../TROUBLESHOOTING.md', import.meta.url), 'utf8');
    const section = guide.split('## Doctor checks\n')[1]?.split('\n## ')[0] ?? '';
    const documented = [...section.matchAll(/^### ([a-z][a-z0-9_.]+)$/gm)].map((match) => match[1]);
    expect(documented.length).toBe(new Set(documented).size);
    expect(documented.sort()).toEqual(emitted);
  });

  it.each([
    ['configured port', undefined, 'http://127.0.0.1:4567/v1/doctor'],
    ['explicit URL', 'http://127.0.0.1:9876', 'http://127.0.0.1:9876/v1/doctor'],
  ] as const)('probes the %s address', async (_name, explicit, expected) => {
    const urls: string[] = [];
    const output = capture();
    const exitCode = await runCli(['doctor', '--json'], {
      io: output.io,
      env: { BOARD_HOME: '/board', ...(explicit ? { BOARD_DAEMON_URL: explicit } : {}) },
      home: '/home',
      doctor: ports({
        readText(path) {
          if (path.endsWith('config.yaml')) return `${yaml}\nhttp: { port: 4567 }\n`;
          return ports().readText(path);
        },
        fetcher(input, init) {
          if (!(input instanceof URL)) throw new Error('Expected a URL.');
          if (isSpurProjects(input)) return ports().fetcher(input, init);
          urls.push(input.href);
          return Promise.resolve(daemonResponse());
        },
      }),
    });
    expect(exitCode).toBe(0);
    expect(urls).toEqual([expected]);
  });
  it('shows the curator sessions text from the daemon in JSON and human output', async () => {
    const fix =
      'beta: curator cur-b, no live session. alpha: curator cur-a, session cur-a-7. Start a Spur session of each curator with no live session.';
    const curator: DoctorCheck = {
      id: 'curator.sessions',
      status: 'warning',
      blocking: false,
      fix,
    };
    const fake = ports({
      fetcher: (input) =>
        Promise.resolve(
          isSpurProjects(input)
            ? Response.json([{ id: 'worker', path: '/main' }])
            : Response.json({
                version: '1.2.3',
                checks: remoteIds.map((id): DoctorCheck =>
                  id === curator.id ? curator : { id, status: 'pass', blocking: false, fix: null },
                ),
              }),
        ),
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.exitCode).toBe(0);
    expect(value.checks.find((check) => check.id === 'curator.sessions')).toEqual(curator);
    const human = capture();
    const humanExit = await runCli(['doctor'], {
      io: human.io,
      env: { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
      home: '/home',
      doctor: fake,
    });
    expect(humanExit).toBe(0);
    expect(human.output()).toContain(`WARNING curator.sessions: ${fix}`);
  });

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
      'sessions.codex_skill',
      'sessions.stale',
      'http.port',
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
    expect(value.checks.find((check) => check.id === 'spur.send')).toMatchObject({
      status: 'warning',
      blocking: false,
      fix: 'Start the daemon, then rerun board doctor to complete this check.',
    });
    expect(value.checks.find((check) => check.id === 'link.rules')).toEqual({
      id: 'link.rules',
      status: 'warning',
      blocking: false,
      fix: 'Start the daemon, then rerun board doctor to complete this check.',
    });
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

  it.each([
    ['a label filter', yaml],
    ['no filter', yaml.replace('\n      label: board', '')],
  ])(
    'uses only config validation offline and does not call any other port (%s)',
    async (filter, config) => {
      expect(config.includes('label:')).toBe(filter === 'a label filter');
      const fake = ports({
        readText(path) {
          if (path.endsWith('config.yaml')) return config;
          throw new Error('offline touched another file');
        },
        exists: () => {
          throw new Error('offline filesystem check');
        },
        realPath: () => {
          throw new Error('offline link check');
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
        bind: () => {
          throw new Error('offline port check');
        },
      });
      const value = await run(['doctor', '--offline', '--json'], fake);
      expect(value.exitCode).toBe(0);
      expect(value.checks).toEqual([{ id: 'config', status: 'pass', blocking: false, fix: null }]);
    },
  );

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
      codexFix,
      {
        realPath: (path: string) => {
          if (path === mainLink) throw new Error('missing link');
          return path;
        },
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
    expect(value.checks.find((check) => check.id === 'sessions.codex_skill')).toMatchObject({
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
    expect(value.checks.find((check) => check.id === 'skills.codex_visibility')).toEqual({
      id: 'skills.codex_visibility',
      status: 'warning',
      blocking: false,
      fix: spurFix,
    });
    expect(value.checks.find((check) => check.id === 'sessions.codex_skill')?.status).toBe('pass');
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
      'Restart 1 session started before the last skill install: old; verify sessions whose start time is unavailable.',
    );
  });

  it('lists each stale session once and counts distinct sessions', async () => {
    const entry = (id: string) => ({
      id,
      project: 'worker',
      path: '/usr/bin',
      codexHome: '/codex',
      startAt: Date.parse('2026-11-03T10:00:00.000Z'),
    });
    const fake = ports({
      sessions: () => [...Array.from({ length: 12 }, () => entry('busy')), entry('quiet')],
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.checks.find((check) => check.id === 'sessions.stale')?.fix).toBe(
      'Restart 2 sessions started before the last skill install: busy, quiet; verify sessions whose start time is unavailable.',
    );
  });
});

describe('board doctor Codex skill install', () => {
  const find = (checks: DoctorCheck[], id: string) => checks.find((check) => check.id === id);
  const spurConfig = (text: string): Partial<DoctorPorts> => ({
    readText: (path) => (path === '/main/spur.yaml' ? text : ports().readText(path)),
  });
  const linkTo =
    (target: string | null) =>
    (path: string): string => {
      if (path !== mainLink) return path;
      if (target === null) throw new Error('missing link');
      return target;
    };

  it('passes the install check without sessions', async () => {
    const value = await run(['doctor', '--json'], ports({ sessions: () => [] }));
    expect(find(value.checks, 'skills.codex_visibility')).toEqual({
      id: 'skills.codex_visibility',
      status: 'pass',
      blocking: false,
      fix: null,
    });
    expect(value.checks.map((check) => check.fix)).not.toContain(
      'Start a Codex session in a configured Spur project to verify skill visibility.',
    );
  });

  it.each([
    ['the link resolves outside the installed skill', linkTo('/elsewhere')],
    ['only the symlinks entry marks the project as Codex', linkTo(null)],
  ] as const)('fails the install check without sessions when %s', async (_case, realPath) => {
    const value = await run(['doctor', '--json'], ports({ sessions: () => [], realPath }));
    expect(find(value.checks, 'skills.codex_visibility')).toEqual({
      id: 'skills.codex_visibility',
      status: 'fail',
      blocking: true,
      fix: codexFix,
    });
    expect(value.exitCode).toBe(1);
  });

  it('fails the install check without sessions when the symlinks entry is missing', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({ sessions: () => [], ...spurConfig('projects:\n  worker:\n    symlinks: []\n') }),
    );
    expect(find(value.checks, 'skills.codex_visibility')).toEqual({
      id: 'skills.codex_visibility',
      status: 'fail',
      blocking: true,
      fix: codexFix,
    });
    expect(value.exitCode).toBe(1);
  });

  it('accepts a symlinks entry written with ./ and a trailing slash', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [],
        ...spurConfig('projects:\n  worker:\n    symlinks: [./.agents/skills/spur-board/]\n'),
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')?.status).toBe('pass');
  });

  it('skips a project with no Codex signal', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [],
        realPath: linkTo(null),
        ...spurConfig('projects:\n  worker:\n    symlinks: []\n'),
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')?.status).toBe('pass');
  });

  it('counts defaultAgent codex as a Codex signal', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [],
        realPath: linkTo(null),
        ...spurConfig('projects:\n  worker:\n    defaultAgent: codex\n    symlinks: []\n'),
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')?.status).toBe('fail');
  });

  it.each([
    ['when set', { CODEX_HOME: '/custom-codex' }, 'pass', false],
    ['only when set', {}, 'fail', true],
  ] as const)(
    'checks the Codex copy under CODEX_HOME %s',
    async (_case, extra, status, blocking) => {
      const value = await run(
        ['doctor', '--json'],
        ports({ sessions: () => [], realPath: linkTo('/custom-codex/skills/spur-board') }),
        { BOARD_HOME: '/board', BOARD_DAEMON_URL: 'http://127.0.0.1:4311', ...extra },
      );
      expect(find(value.checks, 'skills.codex_visibility')).toMatchObject({ status, blocking });
    },
  );

  it('passes the install and warns about Codex sessions created before the link', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [
          { id: 'worker-1', project: 'worker', path: '/usr/bin', codexHome: '/codex', cwd: '/old' },
          { id: 'worker-1', project: 'worker', path: '/usr/bin', codexHome: '/codex', cwd: '/old' },
        ],
        exists: (path) => !path.endsWith('/skills/spur-board/SKILL.md'),
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')?.status).toBe('pass');
    expect(find(value.checks, 'sessions.codex_skill')).toEqual({
      id: 'sessions.codex_skill',
      status: 'warning',
      blocking: false,
      fix: 'Start new Spur sessions to replace Codex sessions created before the skill link: worker-1; Spur links .agents/skills/spur-board only into new worktrees.',
    });
    expect(value.exitCode).toBe(0);
  });

  it('warns about an unreachable Spur with a live Codex session', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        exists: (path) => !path.endsWith('/skills/spur-board/SKILL.md'),
        fetcher: () => Promise.reject(new Error('spur down')),
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')).toEqual({
      id: 'skills.codex_visibility',
      status: 'warning',
      blocking: false,
      fix: spurFix,
    });
    expect(find(value.checks, 'sessions.codex_skill')?.status).toBe('pass');
  });

  it('warns about a configured Spur project that Spur does not know', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        fetcher: (input) =>
          Promise.resolve(
            isSpurProjects(input)
              ? Response.json([{ id: 'other', path: '/other' }])
              : daemonResponse(),
          ),
      }),
    );
    const check = find(value.checks, 'skills.codex_visibility');
    expect(check).toMatchObject({ status: 'warning', blocking: false });
    expect(check?.fix).toBe(
      'Correct spurProjects in config.yaml or register these projects in Spur: worker.',
    );
    expect(value.exitCode).toBe(0);
  });

  it.each([
    ['with a live Codex session', undefined],
    ['without sessions', () => []],
  ] as const)(
    'warns without a link when the project spur.yaml cannot be read, %s',
    async (_name, sessions) => {
      const value = await run(
        ['doctor', '--json'],
        ports({
          ...(sessions ? { sessions } : {}),
          realPath: linkTo(null),
          readText: (path) => {
            if (path.startsWith('/main/spur.')) throw new Error('unreadable');
            return ports().readText(path);
          },
        }),
      );
      expect(find(value.checks, 'skills.codex_visibility')).toMatchObject({
        status: 'warning',
        blocking: false,
      });
      expect(value.exitCode).toBe(0);
    },
  );

  it('fails when the project spur.yaml cannot be read and the link points elsewhere', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        sessions: () => [],
        realPath: linkTo('/elsewhere'),
        readText: (path) => {
          if (path.startsWith('/main/spur.')) throw new Error('unreadable');
          return ports().readText(path);
        },
      }),
    );
    expect(find(value.checks, 'skills.codex_visibility')).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(value.exitCode).toBe(1);
  });

  it('warns when the project spur.yaml cannot be read', async () => {
    const value = await run(
      ['doctor', '--json'],
      ports({
        exists: (path) => !path.endsWith('/skills/spur-board/SKILL.md'),
        readText: (path) => {
          if (path.startsWith('/main/spur.')) throw new Error('unreadable');
          return ports().readText(path);
        },
      }),
    );
    const check = find(value.checks, 'skills.codex_visibility');
    expect(check).toMatchObject({ status: 'warning', blocking: false });
    expect(check?.fix).toContain(
      "Check that projects.<id>.symlinks in each project's spur.yaml lists .agents/skills/spur-board: worker.",
    );
    expect(find(value.checks, 'sessions.codex_skill')?.status).toBe('pass');
    expect(value.exitCode).toBe(0);
  });
});

describe('http.port check', () => {
  const ssLine = (port: number, users: boolean) =>
    `State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 127.0.0.1:${String(port)} 0.0.0.0:*${users ? ' users:(("spur-web",pid=4242,fd=21))' : ''}\n`;

  function probePorts(port: number, ss: string, overrides: Partial<DoctorPorts> = {}) {
    return ports({
      readText(path) {
        if (path.endsWith('config.yaml')) return `${yaml}\nhttp: { port: ${String(port)} }\n`;
        return ports().readText(path);
      },
      run: (command, args, env) =>
        command === 'ss' ? { exitCode: 0, stdout: ss } : ports().run(command, args, env),
      bind: bindLoopback,
      ...overrides,
    });
  }

  it.each([
    ['names the holder', {}, true, 'spur-web (pid 4242)'],
    ['falls back when the holder is hidden', {}, false, 'a process not visible to this user'],
    [
      'rejects a malformed instance header',
      { 'x-board-instance': 'not-a-uuid' },
      true,
      'spur-web (pid 4242)',
    ],
  ] as const)('%s', async (_name, headers, users, named) => {
    const server = await holder(headers);
    try {
      const value = await run(
        ['doctor', '--json'],
        probePorts(server.port, ssLine(server.port, users)),
      );
      expect(value.exitCode).toBe(1);
      const check = value.checks.find((entry) => entry.id === 'http.port');
      expect(check).toMatchObject({ status: 'fail', blocking: true });
      expect(check?.fix).toContain(String(server.port));
      expect(check?.fix).toContain(named);
      expect(server.paths).toEqual(['/v1/schema']);
    } finally {
      await server.close();
    }
  });

  it('does not follow a redirect to a board daemon on another port', async () => {
    const daemon = await holder({ 'x-board-instance': randomUUID() });
    const server = await holder(
      { location: `http://127.0.0.1:${String(daemon.port)}/v1/schema` },
      307,
    );
    try {
      const value = await run(
        ['doctor', '--json'],
        probePorts(server.port, ssLine(server.port, true)),
      );
      expect(value.exitCode).toBe(1);
      expect(value.checks.find((entry) => entry.id === 'http.port')).toMatchObject({
        status: 'fail',
        blocking: true,
      });
      expect(server.paths).toEqual(['/v1/schema']);
      expect(daemon.paths).toEqual([]);
    } finally {
      await server.close();
      await daemon.close();
    }
  });

  it('stops waiting for a holder that trickles headers', async () => {
    const server = await trickler();
    try {
      const value = await run(
        ['doctor', '--json'],
        probePorts(server.port, ssLine(server.port, true)),
      );
      expect(value.exitCode).toBe(1);
      expect(value.checks.find((entry) => entry.id === 'http.port')).toMatchObject({
        status: 'fail',
        blocking: true,
      });
    } finally {
      await server.close();
    }
  }, 10_000);

  it('passes when free', async () => {
    const server = await holder({});
    const port = server.port;
    await server.close();
    const value = await run(['doctor', '--json'], probePorts(port, ''));
    expect(value.exitCode).toBe(0);
    expect(value.checks.find((entry) => entry.id === 'http.port')).toEqual({
      id: 'http.port',
      status: 'pass',
      blocking: false,
      fix: null,
    });
  });

  it('passes when a board daemon holds it', async () => {
    const server = await holder({ 'x-board-instance': randomUUID() });
    try {
      const fake = probePorts(server.port, '', {
        run: (command, args, env) => {
          if (command === 'ss') throw new Error('ss is not needed for a board daemon');
          return ports().run(command, args, env);
        },
      });
      const value = await run(['doctor', '--json'], fake);
      expect(value.exitCode).toBe(0);
      expect(value.checks.find((entry) => entry.id === 'http.port')?.status).toBe('pass');
      expect(server.paths).toEqual(['/v1/schema']);
    } finally {
      await server.close();
    }
  });

  it('passes on port 0', async () => {
    const fake = probePorts(0, '', {
      bind: () => {
        throw new Error('port 0 is never probed');
      },
    });
    const value = await run(['doctor', '--json'], fake);
    expect(value.exitCode).toBe(0);
    expect(value.checks.find((entry) => entry.id === 'http.port')?.status).toBe('pass');
  });
});
