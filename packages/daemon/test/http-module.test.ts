import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { createOperationRegistry, openStore, type Store } from '@spur-board/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolvePaths } from '../src/config.ts';
import { createHttpModule, lookupLiveSession } from '../src/http-module.ts';
import { runDaemonDoctor } from '../src/doctor.ts';
import type { DaemonState, ModuleContext } from '../src/lifecycle.ts';
import { createLogger, logCall } from '../src/logger.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

const wire = {
  id: 'worker-1',
  project: 'worker',
  branch: 'work-1',
  status: 'running',
  state: 'waiting',
  lastActivityAt: '2026-11-04T08:00:00.000Z',
};

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function doctorContext(
  options: {
    operator?: boolean;
    channels?: boolean;
    slack?: boolean;
    secrets?: Readonly<Record<string, string>>;
    // A github-issues project tracking example/board instead of the Jira project.
    issues?: boolean;
    repos?: readonly string[];
    // Board projects and their Spur projects in place of the single `board` project.
    projects?: readonly {
      id: string;
      spurProjects: readonly { name: string; role: 'worker' | 'operator' | 'curator' }[];
    }[];
  } = {},
) {
  const store = openStore(join(makeHome(), 'board.sqlite'));
  stores.push(store);
  const projects = options.projects ?? [
    {
      id: 'board',
      spurProjects: options.operator ? [{ name: 'operator', role: 'operator' as const }] : [],
    },
  ];
  const config = configSchema.parse({
    projects: projects.map(({ id, spurProjects }) => ({
      id,
      tracker: options.issues
        ? { type: 'github-issues', repo: 'example/board', label: 'board' }
        : {
            type: 'jira',
            baseUrl: 'https://jira.example.test',
            jql: 'project = BOARD',
            doneStatuses: ['Done'],
            readyStatuses: ['Ready'],
            projectKeys: ['BOARD'],
          },
      repos: options.repos ?? ['example/board'],
      operatorGithubLogin: 'operator',
      spurProjects,
    })),
    operator: { slack: 'U0000000000' },
    ...(options.slack === false
      ? {}
      : {
          slack: {
            command: '/board',
            appId: 'A123ABC',
            channels:
              options.channels === false ? {} : { orchestrators: 'C000000001', feed: 'C000000002' },
          },
        }),
    digest: { tz: 'UTC' },
  });
  const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
  const log = createLogger({ write: () => undefined }, {}).child({ module: 'doctor' });
  const ctx: ModuleContext<Store> = {
    config,
    store,
    clock,
    log,
    state: () => 'ready',
    secrets: options.secrets ?? {
      GITHUB_TOKEN: 'github-secret-canary',
      JIRA_EMAIL: 'email@example.test',
      JIRA_API_TOKEN: 'jira-secret-canary',
      SLACK_BOT_TOKEN: 'slack-secret-canary',
      SLACK_APP_TOKEN: 'app-secret-canary',
      SLACK_APP_CONFIG_TOKEN: 'config-secret-canary',
    },
    logCall: (_call, fn) => fn(),
  };
  return ctx;
}

// A LinkSample response listing the given PRs of example/board, newest updated first.
function linkSampleResponse(prs: readonly unknown[]): Response {
  return Response.json({
    data: {
      rateLimit: { remaining: 4000, resetAt: '2026-11-04T09:00:00.000Z' },
      repository: { pullRequests: { nodes: prs } },
    },
  });
}

function samplePr(number: number, branch: string, login = 'operator') {
  return {
    number,
    title: 'Secret title words',
    headRefName: branch,
    author: { login },
    closingIssuesReferences: { nodes: [] },
  };
}

function isLinkSample(init?: RequestInit): boolean {
  return typeof init?.body === 'string' && init.body.includes('query LinkSample');
}

// `prs` answers the link sample of a github-issues project; probe requests behave as before.
function doctorFetch(fail?: string, prs: readonly unknown[] = []): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof URL ? input.href : input instanceof Request ? input.url : input,
    );
    const path = url.pathname;
    if (path.endsWith('/myself'))
      return Promise.resolve(
        new Response(null, { status: fail === 'jira.credentials' ? 401 : 200 }),
      );
    if (path === '/graphql' && isLinkSample(init)) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (fail === 'link.stalled-body')
        return Promise.resolve(new Response(new ReadableStream({ start() {} })));
      if (fail === 'link.failed')
        return Promise.resolve(new Response('secret-canary upstream body', { status: 502 }));
      return Promise.resolve(linkSampleResponse(prs));
    }
    if (path === '/graphql') {
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (typeof init?.body !== 'string') throw new Error('Expected GitHub GraphQL body');
      const sent = JSON.parse(init.body) as { query: string; variables: unknown };
      expect(sent.query).toContain('pullRequests(first: 10');
      expect(sent.query).toContain('statusCheckRollup');
      expect(sent.query).toContain('... on Team { slug }');
      expect(sent.variables).toEqual({ owner: 'example', repo: 'board' });
      if (fail === 'github.stalled-body')
        return Promise.resolve(new Response(new ReadableStream({ start() {} })));
      const requestedTeam =
        fail === 'github.team-readable'
          ? [{ requestedReviewer: { __typename: 'Team', slug: 'reviewers' } }]
          : [];
      const prs =
        fail === 'github.checked-older'
          ? [
              { statusCheckRollup: null, reviewRequests: { nodes: [] } },
              {
                statusCheckRollup: { contexts: { nodes: [{ name: null }] } },
                reviewRequests: { nodes: [] },
              },
            ]
          : [{ statusCheckRollup: null, reviewRequests: { nodes: requestedTeam } }];
      return Promise.resolve(
        Response.json({
          data: {
            repository: {
              pullRequests: { nodes: prs },
              defaultBranchRef: {
                target: {
                  statusCheckRollup:
                    fail === 'github.no-contexts' || fail === 'github.no-header'
                      ? null
                      : { contexts: { nodes: [{ name: 'build' }] } },
                },
              },
            },
          },
          errors:
            fail === 'github.checks' || fail === 'github.checked-older'
              ? [
                  {
                    type: 'FORBIDDEN',
                    path:
                      fail === 'github.checked-older'
                        ? [
                            'repository',
                            'pullRequests',
                            'nodes',
                            1,
                            'statusCheckRollup',
                            'contexts',
                            'nodes',
                            0,
                            'name',
                          ]
                        : [
                            'repository',
                            'defaultBranchRef',
                            'target',
                            'statusCheckRollup',
                            'contexts',
                            'nodes',
                            0,
                            'name',
                          ],
                  },
                ]
              : fail === 'github.team'
                ? [
                    {
                      type: 'INSUFFICIENT_SCOPES',
                      path: [
                        'repository',
                        'pullRequests',
                        'nodes',
                        0,
                        'reviewRequests',
                        'nodes',
                        0,
                        'requestedReviewer',
                        'slug',
                      ],
                    },
                  ]
                : fail === 'github.unrelated'
                  ? [{ type: 'FORBIDDEN', path: ['repository', 'name'] }]
                  : [],
        }),
      );
    }
    if (url.host === 'api.github.com')
      return Promise.resolve(
        new Response(null, {
          status: fail === 'github.credentials' ? 403 : 200,
          headers:
            fail === 'github.no-header' || fail === 'github.team-readable'
              ? {}
              : {
                  'x-oauth-scopes':
                    fail === 'github.no-read-org'
                      ? 'repo'
                      : fail === 'github.write-org'
                        ? 'repo, write:org'
                        : fail === 'github.admin-org'
                          ? 'repo, admin:org'
                          : 'repo, read:org',
                },
        }),
      );
    if (path === '/sessions/spur-board-doctor-probe/send') {
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (typeof init?.body !== 'string') throw new Error('Expected Spur send body');
      expect(JSON.parse(init.body)).toEqual({ message: 'spur-board doctor probe' });
      if (fail === 'spur.send') return Promise.reject(new TypeError('fetch failed'));
      if (fail === 'spur.send.route')
        return Promise.resolve(
          Response.json(
            { error: 'Route not found: POST /sessions/spur-board-doctor-probe/send' },
            { status: 404 },
          ),
        );
      if (fail === 'spur.send.other404')
        return Promise.resolve(Response.json({ error: 'Task not found' }, { status: 404 }));
      if (fail === 'spur.send.503')
        return Promise.resolve(Response.json({ error: 'Daemon is starting' }, { status: 503 }));
      if (fail === 'spur.send.ok')
        return Promise.resolve(Response.json({ id: 'spur-board-doctor-probe' }));
      return Promise.resolve(
        Response.json({ error: 'Session not found: spur-board-doctor-probe' }, { status: 404 }),
      );
    }
    if (path.endsWith('/sessions'))
      return Promise.resolve(new Response(null, { status: fail === 'spur.api' ? 503 : 200 }));
    if (path.endsWith('/auth.test'))
      return Promise.resolve(
        Response.json(
          { ok: fail !== 'slack.auth' },
          {
            headers: {
              'x-oauth-scopes':
                'chat:write,chat:write.customize,groups:history,groups:read,app_mentions:read,commands' +
                (fail === 'slack.scopes' ? '' : ',reactions:write'),
            },
          },
        ),
      );
    if (path.endsWith('/conversations.info')) {
      const id = url.searchParams.get('channel');
      const memberFail = id === 'C000000001' ? 'slack.orchestrators_member' : 'slack.feed_member';
      return Promise.resolve(
        Response.json({ ok: true, channel: { is_member: fail !== memberFail } }),
      );
    }
    if (path.endsWith('/apps.manifest.export')) {
      expect(url.search).toBe('');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer config-secret-canary',
        'Content-Type': 'application/json',
      });
      expect(typeof init?.body).toBe('string');
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
      expect(JSON.parse(init.body)).toEqual({ app_id: 'A123ABC' });
      return Promise.resolve(
        Response.json({
          ok: true,
          manifest: {
            features: {
              slash_commands: [{ command: fail === 'slack.command' ? '/wrong' : '/board' }],
            },
          },
        }),
      );
    }
    throw new Error('Unexpected diagnostic URL');
  });
}

describe('daemon doctor checks', () => {
  it('rejects a token denied access to CheckRun data after repository access succeeds', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch('github.checks'),
    );
    const github = report.checks.find((entry) => entry.id === 'github.credentials');
    expect(github).toMatchObject({ status: 'fail', blocking: true });
    expect(github?.fix).toContain('classic');
    expect(github?.fix).toContain('repo');
    expect(github?.fix).toContain('SSO');
  });

  it('finds a check denial on an older sampled PR after an unchecked newer PR', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch('github.checked-older'),
    );
    const github = report.checks.find((entry) => entry.id === 'github.credentials');
    expect(github).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(github?.fix).toContain('repo');
  });

  it('names read:org when a requested team name is denied with partial data', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch('github.team'),
    );
    const github = report.checks.find((entry) => entry.id === 'github.credentials');
    expect(github).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(github?.fix).toContain('read:org');
    expect(JSON.stringify(report)).not.toMatch(/secret-canary|reviewers/);
    expect(JSON.stringify(github)).not.toMatch(/example\/board/);
  });

  it.each([
    ['contexts present', undefined],
    ['no contexts', 'github.no-contexts'],
    ['no contexts or team requests with an absent scope header', 'github.no-header'],
    ['readable team field without a scope header', 'github.team-readable'],
    ['write:org without redundant read:org', 'github.write-org'],
    ['admin:org without redundant read:org', 'github.admin-org'],
  ])('passes with %s', async (_case, mode) => {
    const fetcher = doctorFetch(mode);
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      fetcher,
    );
    expect(report.checks.find((entry) => entry.id === 'github.credentials')).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['missing read:org', 'github.no-read-org', 'read:org'],
    ['unrelated GraphQL error', 'github.unrelated', 'repository access'],
  ])('fails safely for %s', async (_case, mode, hint) => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch(mode),
    );
    const github = report.checks.find((entry) => entry.id === 'github.credentials');
    expect(github).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(github?.fix).toContain(hint);
  });

  it('bounds GraphQL body consumption with the doctor deadline', async () => {
    const started = Date.now();
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch('github.stalled-body'),
      { deadlineMs: 250 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report.checks.find((entry) => entry.id === 'github.credentials')).toMatchObject({
      status: 'fail',
      blocking: true,
      fix: 'Check the GitHub token and repository access.',
    });
  });

  it('documents every check ID emitted by the daemon with and without Slack', async () => {
    const configured = await runDaemonDoctor(
      doctorContext({ operator: true }),
      '1.2.3',
      doctorFetch(),
    );
    const unconfigured = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch(),
    );
    const emitted = [
      ...new Set([...configured.checks, ...unconfigured.checks].map(({ id }) => id)),
    ];
    const guide = readFileSync(new URL('../../../TROUBLESHOOTING.md', import.meta.url), 'utf8');
    const section = guide.split('## Doctor checks\n')[1]?.split('\n## ')[0] ?? '';
    const documented = new Set(
      [...section.matchAll(/^### ([a-z][a-z0-9_.]+)$/gm)].map((match) => match[1]),
    );
    expect(emitted.filter((id) => !documented.has(id))).toEqual([]);
  });

  it('does not require Slack tokens when Slack setup is absent', async () => {
    const fetcher = doctorFetch();
    const report = await runDaemonDoctor(
      doctorContext({
        operator: true,
        slack: false,
        secrets: {
          GITHUB_TOKEN: 'github-secret-canary',
          JIRA_EMAIL: 'email@example.test',
          JIRA_API_TOKEN: 'jira-secret-canary',
        },
      }),
      '1.2.3',
      fetcher,
    );
    expect(report.checks.find((check) => check.id === 'secrets')).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: null,
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      'secrets',
      'jira.credentials',
      'github.credentials',
      'link.rules',
      'spur.api',
      'spur.send',
      'slack.configured',
      'operator.path',
      'curator.sessions',
    ]);
    expect(report.checks.find((check) => check.id === 'slack.configured')).toEqual({
      id: 'slack.configured',
      status: 'warning',
      blocking: false,
      fix: 'Slack is not configured: questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to configure slack.channels.',
    });
    expect(report.checks.every((check) => !check.blocking)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('fails with the missing bot scope when the token is valid', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true }),
      '1.2.3',
      doctorFetch('slack.scopes'),
    );
    expect(report.checks.find((entry) => entry.id === 'slack.auth')).toMatchObject({
      status: 'fail',
      blocking: true,
      fix: 'Add reactions:write to the Slack app and reinstall it.',
    });
  });

  it('does not require Slack tokens when app settings exist without channels', async () => {
    const ctx = doctorContext({
      operator: true,
      channels: false,
      secrets: {
        GITHUB_TOKEN: 'github-secret-canary',
        JIRA_EMAIL: 'email@example.test',
        JIRA_API_TOKEN: 'jira-secret-canary',
      },
    });
    const fetcher = doctorFetch();
    const report = await runDaemonDoctor(ctx, '1.2.3', fetcher);
    expect(report.checks.find((check) => check.id === 'secrets')).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: null,
    });
    expect(report.checks.filter((check) => check.id.startsWith('slack.'))).toEqual([
      expect.objectContaining({ id: 'slack.configured', status: 'warning', blocking: false }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('reports every daemon-owned check as passing without returning credential values', async () => {
    const ctx = doctorContext({ operator: true });
    const report = await runDaemonDoctor(
      ctx,
      '1.2.3',
      doctorFetch(undefined, [samplePr(1, 'BOARD-1-x')]),
    );
    expect(report.version).toBe('1.2.3');
    expect(report.checks.map((check) => check.id)).toEqual([
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
    ]);
    expect(report.checks.find((check) => check.id === 'link.rules')).toEqual({
      id: 'link.rules',
      status: 'pass',
      blocking: false,
      fix: 'board: link rules match 1 of the last 1 PRs in example/board.',
    });
    expect(
      report.checks
        .filter((check) => check.id !== 'link.rules')
        // curator.sessions passes with text naming each project's curator.
        .every(
          (check) =>
            check.status === 'pass' && (check.id === 'curator.sessions' || check.fix === null),
        ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/secret-canary/);
  });

  it.each([
    ['jira.credentials', 'Check the Jira account, API token, and project access.'],
    ['github.credentials', 'Check the GitHub token and repository access.'],
    ['spur.api', 'Start or correct the configured Spur API.'],
    [
      'spur.send',
      'Start Spur or correct adapters.spur.baseUrl in config.yaml, then restart the service; the daemon sends doorbells to that Spur API.',
    ],
    ['slack.auth', 'Check the Slack bot token.'],
    ['slack.orchestrators_member', 'Invite the bot to the configured channel ID.'],
    ['slack.feed_member', 'Invite the bot to the configured channel ID.'],
    [
      'slack.command',
      'Change the installed Slack slash command to match slack.command in config.yaml.',
    ],
  ])('returns a fixed failure and fix for %s', async (id, fix) => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true }),
      '1.2.3',
      doctorFetch(id),
    );
    const entry = report.checks.find((check) => check.id === id);
    expect(entry).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(entry?.fix).toBe(fix);
    expect(JSON.stringify(report)).not.toMatch(/secret-canary/);
  });

  it.each(['spur.send.route', 'spur.send.other404', 'spur.send.503', 'spur.send.ok'])(
    'fails spur.send when Spur does not answer the probe as a missing session (%s)',
    async (mode) => {
      const report = await runDaemonDoctor(
        doctorContext({ operator: true }),
        '1.2.3',
        doctorFetch(mode),
      );
      expect(report.checks.find((check) => check.id === 'spur.send')).toEqual({
        id: 'spur.send',
        status: 'fail',
        blocking: true,
        fix: 'The Spur API at adapters.spur.baseUrl did not accept a doorbell send; update Spur or point adapters.spur.baseUrl at the Spur daemon.',
      });
      expect(JSON.stringify(report)).not.toMatch(
        /Route not found|Task not found|Daemon is starting/,
      );
    },
  );

  it('names missing secret variables and fails operator access without a project or token', async () => {
    const report = await runDaemonDoctor(doctorContext({ secrets: {} }), '1.2.3', doctorFetch());
    expect(report.checks.find((check) => check.id === 'secrets')?.fix).toContain('GITHUB_TOKEN');
    expect(report.checks.find((check) => check.id === 'secrets')?.fix).toContain('SLACK_APP_TOKEN');
    const operator = report.checks.find((check) => check.id === 'operator.path');
    expect(operator).toMatchObject({
      status: 'fail',
      blocking: true,
    });
    expect(operator?.fix).toBe(
      'Configure a Spur project with the operator role or approve a named operator token.',
    );
  });

  it('warns when an installed slash command cannot be verified', async () => {
    const ctx = doctorContext({
      operator: true,
      secrets: {
        GITHUB_TOKEN: 'github-secret-canary',
        JIRA_EMAIL: 'email@example.test',
        JIRA_API_TOKEN: 'jira-secret-canary',
        SLACK_BOT_TOKEN: 'slack-secret-canary',
        SLACK_APP_TOKEN: 'app-secret-canary',
      },
    });
    const report = await runDaemonDoctor(ctx, '1.2.3', doctorFetch());
    const command = report.checks.find((check) => check.id === 'slack.command');
    expect(command).toMatchObject({
      status: 'warning',
      blocking: false,
    });
    expect(command?.fix).toContain('Verify the installed Slack slash command');
  });
});

// A Spur-observed session row; `detail` and `first_seen` can be overridden with bad values.
async function seedSession(
  ctx: ModuleContext<Store>,
  id: string,
  spurProject: string,
  overrides: { detail?: string; first_seen?: string } = {},
) {
  const at = '2026-11-04T08:00:00.000Z';
  await ctx.store.db
    .insertInto('session_snapshot')
    .values({
      id,
      spur_project: spurProject,
      branch: null,
      pr: null,
      raw_state: 'running',
      state: 'running',
      first_seen: overrides.first_seen ?? at,
      last_seen: at,
      ended_at: null,
      end_reason: null,
      detail: overrides.detail ?? JSON.stringify({ lastActivityAt: at }),
      source: 'spur',
      observed_at: at,
      absent_since: null,
    })
    .execute();
}

describe('daemon doctor curator sessions', () => {
  const curators = (...ids: string[]) =>
    ids.map((id) => ({
      id,
      spurProjects: id === 'gamma' ? [] : [{ name: `cur-${id}`, role: 'curator' as const }],
    }));
  const curatorCheck = async (ctx: ModuleContext<Store>) =>
    (await runDaemonDoctor(ctx, '1.2.3', doctorFetch())).checks.find(
      (check) => check.id === 'curator.sessions',
    );

  it('warns about a curator with no live session, problems first, without blocking', async () => {
    const ctx = doctorContext({ operator: true, projects: curators('alpha', 'beta', 'gamma') });
    await seedSession(ctx, 'cur-alpha-7', 'cur-alpha');
    expect(await curatorCheck(ctx)).toEqual({
      id: 'curator.sessions',
      status: 'warning',
      blocking: false,
      fix: 'beta: curator cur-beta, no live session. alpha: curator cur-alpha, session cur-alpha-7. gamma: no curator configured. Start a Spur session of each curator with no live session.',
    });
  });

  it('passes with the session of every configured curator', async () => {
    const ctx = doctorContext({ operator: true, projects: curators('alpha', 'gamma') });
    await seedSession(ctx, 'cur-alpha-7', 'cur-alpha');
    expect(await curatorCheck(ctx)).toEqual({
      id: 'curator.sessions',
      status: 'pass',
      blocking: false,
      fix: 'alpha: curator cur-alpha, session cur-alpha-7. gamma: no curator configured.',
    });
  });

  it('fits many projects in the fix limit', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `project-${String(i + 10)}`);
    const entry = await curatorCheck(doctorContext({ operator: true, projects: curators(...ids) }));
    expect(entry).toMatchObject({ status: 'warning', blocking: false });
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
    expect(entry?.fix).toMatch(
      /^project-10: curator cur-project-10, no live session\..*; and \d+ more projects\. Start a Spur session of each curator with no live session\.$/,
    );
  });

  it('reports a live row whose detail and first seen cannot be read', async () => {
    const ctx = doctorContext({ operator: true, projects: curators('alpha') });
    await seedSession(ctx, 'cur-alpha-1', 'cur-alpha', {
      detail: 'not json',
      first_seen: 'not a date',
    });
    expect(await curatorCheck(ctx)).toEqual({
      id: 'curator.sessions',
      status: 'pass',
      blocking: false,
      fix: 'alpha: curator cur-alpha, session cur-alpha-1.',
    });
  });
});

describe('daemon doctor link rules', () => {
  const linkRules = (report: Awaited<ReturnType<typeof runDaemonDoctor>>) =>
    report.checks.find((entry) => entry.id === 'link.rules');
  const issuesDoctor = (fetcher: typeof fetch, options?: { deadlineMs?: number }) =>
    runDaemonDoctor(
      doctorContext({ operator: true, slack: false, issues: true }),
      '1.2.3',
      fetcher,
      options,
    );

  it('warns on link.rules naming the PRs the link rules do not match', async () => {
    const fetcher = doctorFetch(undefined, [
      samplePr(5, 'claude-5-widget'),
      samplePr(4, 'someone-4-x', 'someone'),
      samplePr(3, 'feature/no-key'),
      samplePr(2, 'claude-2-widget'),
    ]);
    const report = await issuesDoctor(fetcher);
    const check = linkRules(report);
    expect(check).toMatchObject({ status: 'warning', blocking: false });
    expect(check?.fix).toContain('board: link rules match 2 of the last 3 PRs in example/board');
    expect(check?.fix).toContain('not matched: #3 `feature/no-key`');
    expect(check?.fix).toContain('projects[].link');
    expect(check?.fix).not.toContain('Secret title words');
    expect(report.checks.map((entry) => entry.id).slice(2, 4)).toEqual([
      'github.credentials',
      'link.rules',
    ]);
    // No Jira project: repository, permission probe, link sample and two Spur requests.
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('passes link.rules with the match count when every sampled PR matches', async () => {
    const report = await issuesDoctor(
      doctorFetch(undefined, [
        samplePr(3, 'claude-3-widget'),
        samplePr(2, 'claude-2-widget'),
        samplePr(1, 'claude-1-widget'),
      ]),
    );
    expect(linkRules(report)).toEqual({
      id: 'link.rules',
      status: 'pass',
      blocking: false,
      fix: 'board: link rules match 3 of the last 3 PRs in example/board.',
    });
  });

  it('skips link.rules with a note when the operator has no PRs in the tracker repo', async () => {
    const report = await issuesDoctor(
      doctorFetch(undefined, [samplePr(4, 'feature/other', 'someone')]),
    );
    expect(linkRules(report)).toEqual({
      id: 'link.rules',
      status: 'warning',
      blocking: false,
      fix: 'board: skipped: no PRs by operator in example/board.',
    });
  });

  it('warns, never fails, when the link sample request fails', async () => {
    const report = await issuesDoctor(doctorFetch('link.failed'));
    expect(linkRules(report)).toEqual({
      id: 'link.rules',
      status: 'warning',
      blocking: false,
      fix: 'board: could not read PRs in example/board.',
    });
    expect(report.checks.find((entry) => entry.id === 'github.credentials')).toMatchObject({
      status: 'pass',
    });
    expect(JSON.stringify(report)).not.toMatch(/secret-canary/);
    const tokenless = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false, issues: true, secrets: {} }),
      '1.2.3',
      doctorFetch(),
    );
    expect(linkRules(tokenless)).toMatchObject({ status: 'warning', blocking: false });
    expect(linkRules(tokenless)?.fix).toContain('GITHUB_TOKEN');
  });

  it("samples a Jira project's repos against projectKeys", async () => {
    const fetcher = doctorFetch(undefined, [
      samplePr(3, 'BOARD-3-x'),
      samplePr(2, 'feature/no-key'),
    ]);
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      fetcher,
    );
    const check = linkRules(report);
    expect(check).toMatchObject({ status: 'warning', blocking: false });
    expect(check?.fix).toContain('board: link rules match 1 of the last 2 PRs in example/board');
    expect(check?.fix).toContain('not matched: #2 `feature/no-key`');
    // Jira, repository, permission probe, link sample and two Spur requests.
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('samples every repo of a Jira project', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false, repos: ['example/board', 'example/api'] }),
      '1.2.3',
      doctorFetch(undefined, [samplePr(3, 'feature/no-key')]),
    );
    const check = linkRules(report);
    expect(check?.fix).toContain('in example/board');
    expect(check?.fix).toContain('in example/api');
  });

  it('warns on link.rules without GITHUB_TOKEN when only Jira projects exist', async () => {
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false, secrets: {} }),
      '1.2.3',
      doctorFetch(),
    );
    expect(linkRules(report)).toMatchObject({ status: 'warning', blocking: false });
    expect(linkRules(report)?.fix).toContain('GITHUB_TOKEN');
  });

  it('keeps the link.rules fix within the report limit for many projects', async () => {
    const branch = `${'b'.repeat(240)}\`\u0007tail`;
    const longRepo = (i: number) => `owner${String(i)}/${'r'.repeat(90)}`;
    const projects = (count: number, repoOf: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => ({
        id: `project-${String(i)}`,
        tracker: { type: 'github-issues', repo: repoOf(i), label: 'board' },
        repos: [repoOf(i)],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: `operator-${String(i)}`, role: 'operator' }],
      }));
    const run = async (count: number, repoOf = longRepo, unmatched = [5, 4, 3, 2]) => {
      // Probes fail; only the sample of each tracker repo answers.
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          isLinkSample(init)
            ? linkSampleResponse([
                ...unmatched.map((number) => samplePr(number, branch)),
                samplePr(1, 'claude-1-widget'),
              ])
            : new Response(null, { status: 500 }),
        ),
      );
      const ctx = doctorContext({ slack: false });
      const report = await runDaemonDoctor(
        {
          ...ctx,
          config: configSchema.parse({
            projects: projects(count, repoOf),
            operator: { slack: 'U0000000000' },
            digest: { tz: 'UTC' },
          }),
        },
        '1.2.3',
        fetcher,
      );
      // Limits of doctorReportSchema in packages/core/src/api/server.ts.
      expect(report.checks.length).toBeLessThanOrEqual(30);
      for (const entry of report.checks) {
        expect(entry.id).toMatch(/^[a-z][a-z._]+$/);
        expect(entry.id.length).toBeLessThanOrEqual(60);
        if (entry.fix !== null) expect(entry.fix.length).toBeLessThanOrEqual(300);
      }
      const check = linkRules(report);
      expect(check).toMatchObject({ status: 'warning', blocking: false });
      return check?.fix ?? '';
    };
    const many = await run(8);
    expect(many.length).toBeLessThanOrEqual(300);
    expect(many).toContain('projects[].link');
    const one = await run(1, () => 'example/board', [2]);
    expect(one).toBe(
      `project-0: link rules match 1 of the last 2 PRs in example/board; not matched: #2 \`${'b'.repeat(40)}...\`. Change projects[].link to the repo's branch and PR title rules.`,
    );
    expect(one).not.toContain('\u0007');
  });

  it('bounds the link sample with the doctor deadline when the body never ends', async () => {
    const started = Date.now();
    const report = await issuesDoctor(doctorFetch('link.stalled-body'), { deadlineMs: 250 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(linkRules(report)).toEqual({
      id: 'link.rules',
      status: 'warning',
      blocking: false,
      fix: 'board: could not read PRs in example/board.',
    });
    expect(report.checks.find((entry) => entry.id === 'github.credentials')).toMatchObject({
      status: 'pass',
      blocking: false,
    });
  });
});

describe('live session lookup', () => {
  it('reads a recorded session detail and encodes the requested ID', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn((url: RequestInfo | URL) => {
      requested.push(url instanceof URL ? url : new URL(url instanceof Request ? url.url : url));
      return Promise.resolve(Response.json({ ...wire, id: 'worker-1' }));
    });
    const result = await lookupLiveSession('http://127.0.0.1:4310', 'worker-1', fetcher);
    expect(result).toEqual({ project: 'worker', status: 'running' });
    expect(requested.map((url) => url.pathname)).toEqual(['/sessions/worker-1']);
  });

  it.each([
    { name: 'completed', status: 'completed' },
    { name: 'killed', status: 'killed' },
  ])('retains the $name terminal state for the identity boundary', async ({ status }) => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ ...wire, status })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, fetcher)).resolves.toEqual({
      project: 'worker',
      status,
    });
  });

  it('treats 404 as unknown and failures or invalid responses as unavailable', async () => {
    const missing = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, missing)).resolves.toBeNull();
    const down = vi.fn(() => Promise.reject(new Error('connection refused')));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, down)).rejects.toThrow(
      'connection refused',
    );
    const invalid = vi.fn(() => Promise.resolve(Response.json({ ...wire, id: 'another-session' })));
    await expect(lookupLiveSession('http://127.0.0.1:4310', wire.id, invalid)).rejects.toThrow(
      'Invalid session detail response',
    );
  });
});

describe('HTTP module', () => {
  it('serves schema.get through the real operation route on an assigned port', async () => {
    const config = VALID_CONFIG_YAML.replace(
      'operatorGithubLogin: octocat',
      'operatorGithubLogin: octocat\n    spurProjects:\n      - name: worker\n        role: worker',
    );
    const home = makeHome({ config, httpPort: 0 });
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      { write: (line) => records.push(JSON.parse(line) as Record<string, unknown>) },
      {},
    ).child({ module: 'http' });
    const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
    const module = createHttpModule(ctx, {
      fetcher: () => Promise.resolve(Response.json(wire)),
      registry: createOperationRegistry({
        config: loaded.config,
        clock,
        completeSince: new Map(),
      }),
    });
    try {
      await module.start(new AbortController().signal);
      const listening = records.find((record) => record['msg'] === 'http listening');
      expect(listening?.['port']).toEqual(expect.any(Number));
      const response = await fetch(
        `http://127.0.0.1:${String(listening?.['port'])}/v1/ops/schema.get`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board-session': 'worker-1' },
          body: JSON.stringify({ input: {} }),
        },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        ok: boolean;
        value: { version: string; operations: unknown[] };
      };
      expect(result.ok).toBe(true);
      expect(result.value.version).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(result.value.operations)).toBe(true);
      const filtered = await fetch(
        `http://127.0.0.1:${String(listening?.['port'])}/v1/ops/schema.get`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board-session': 'worker-1' },
          body: JSON.stringify({ input: { role: 'worker' } }),
        },
      );
      expect(filtered.status).toBe(200);
      const body = (await filtered.json()) as { value: { operations: { id: string }[] } };
      expect(body.value.operations.map((entry) => entry.id)).toContain('schema.get');
      expect(body.value.operations.map((entry) => entry.id)).not.toContain('task.add');
    } finally {
      await module.stop();
    }
  });

  it('serves starting until ready and stopping after, logs request IDs, and closes its listener', async () => {
    const home = makeHome();
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      {
        write(line) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
      {},
    ).child({ module: 'http' });
    const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
    let state: DaemonState = 'starting';
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => state,
    };
    const module = createHttpModule(ctx);
    const url = `http://127.0.0.1:${String(loaded.config.http.port)}/v1/schema`;
    try {
      await module.start(new AbortController().signal);
      const starting = await fetch(url);
      expect(starting.status).toBe(503);
      expect(await starting.json()).toMatchObject({ code: 'starting' });
      state = 'ready';
      const ready = await fetch(url);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toHaveProperty('version');
      state = 'stopping';
      const stopping = await fetch(url);
      expect(stopping.status).toBe(503);
      expect(await stopping.json()).toMatchObject({
        code: 'stopping',
        message: 'The daemon is stopping; nothing was applied.',
      });
      const requestId = ready.headers.get('x-request-id');
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(records).toContainEqual(
        expect.objectContaining({ requestId, module: 'http', msg: 'http request', status: 200 }),
      );
    } finally {
      await module.stop();
    }
    await expect(fetch(url)).rejects.toThrow();
  });

  it('logs an unexpected error with its requestId and redacted stack, and no CommandError', async () => {
    const canary = 'xoxb-http-error-canary';
    const home = makeHome({ httpPort: 0 });
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const lines: string[] = [];
    const log = createLogger(
      {
        write(line) {
          lines.push(line);
        },
      },
      { SLACK_BOT_TOKEN: canary },
    ).child({ module: 'http' });
    const records = (): Record<string, unknown>[] =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const clock = { now: () => Date.parse('2026-11-04T08:00:00.000Z') };
    let state: DaemonState = 'ready';
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store,
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => state,
    };
    const module = createHttpModule(ctx, {
      doctor: () => Promise.reject(new Error(`doctor broke with ${canary}`)),
    });
    try {
      await module.start(new AbortController().signal);
      const port = records().find((record) => record['msg'] === 'http listening')?.['port'];
      const base = `http://127.0.0.1:${String(port)}`;
      const failed = await fetch(`${base}/v1/doctor`);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ code: 'unexpected' });
      const errors = records().filter((record) => record['level'] === 50);
      expect(errors).toEqual([
        expect.objectContaining({
          module: 'http',
          msg: 'http request failed',
          requestId: failed.headers.get('x-request-id'),
          err: expect.objectContaining({
            stack: expect.stringContaining('doctor broke with [Redacted]') as unknown,
          }) as unknown,
        }),
      ]);
      state = 'starting';
      const starting = await fetch(`${base}/v1/schema`);
      expect(starting.status).toBe(503);
      expect(records().filter((record) => record['level'] === 50)).toHaveLength(1);
      expect(lines.join('\n')).not.toContain(canary);
    } finally {
      await module.stop();
    }
  });
});
