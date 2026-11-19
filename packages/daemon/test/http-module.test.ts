import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAccessDenied,
  graphqlFailure,
  sampleLinkRules,
  teamScopeDenied,
} from '@spur-board/adapters';
import { configSchema, doctorReportSchema, type ConfigInput } from '@spur-board/contracts';
import {
  createOperationRegistry,
  openStore,
  requestToken,
  tokenAttentionLine,
  type Store,
} from '@spur-board/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolvePaths } from '../src/config.ts';
import {
  createHttpModule,
  createWebModule,
  listenerPort,
  lookupLiveSession,
} from '../src/http-module.ts';
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
      columns?: { id: string; orchestrator?: string; approvalRule?: string }[];
      spurProjects: readonly {
        name: string;
        role: 'worker' | 'operator' | 'curator' | 'orchestrator';
      }[];
    }[];
    // Top-level `spurProjects`: Spur projects bound board-wide.
    boardWide?: ConfigInput['spurProjects'];
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
    projects: projects.map(({ id, spurProjects, columns }) => ({
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
      columns,
    })),
    spurProjects: options.boardWide ?? [],
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
      if (fail === 'github.graphql-stalled-403')
        return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 403 }));
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
                    message: 'Resource not accessible by personal access token',
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
                      message: 'Your token has not been granted the required scopes.',
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
                  ? [
                      {
                        message: 'Resource not accessible by personal access token',
                        type: 'FORBIDDEN',
                        path: ['repository', 'name'],
                      },
                    ]
                  : [],
        }),
      );
    }
    if (url.host === 'api.github.com' && fail === 'github.rest-stalled-403')
      return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 403 }));
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

describe('listenerPort', () => {
  it.each([
    ['http://127.0.0.1:80', 80],
    ['http://127.0.0.1:80/', 80],
    ['http://127.0.0.1:4777', 4777],
    ['http://127.0.0.1:4780/', 4780],
    ['http://[::1]:8080', 8080],
  ])('reads the port of %s as %i', (address, port) => {
    expect(listenerPort(address)).toBe(port);
  });
});

describe('daemon doctor checks', () => {
  it('warns when the optional web listener is unavailable', async () => {
    const ctx = doctorContext({ slack: false });
    ctx.config.web = { port: 12345, publicOrigin: 'http://localhost:12345' };
    const report = await runDaemonDoctor(ctx, '1.2.3', doctorFetch(), {
      webListening: () => false,
    });
    expect(report.checks.find(({ id }) => id === 'web.listening')).toMatchObject({
      status: 'warning',
      blocking: false,
    });
  });
  it('warns once for an unset UI origin without sending a UI request', async () => {
    const fetcher = vi.fn(doctorFetch());
    const report = await runDaemonDoctor(doctorContext({ slack: false }), '1.2.3', fetcher);
    expect(report.checks.filter(({ id }) => id === 'web.spurUiOrigin')).toEqual([
      {
        id: 'web.spurUiOrigin',
        status: 'warning',
        blocking: false,
        fix: 'Set web.spurUiOrigin to the Spur UI origin for session links; without it, the intended fallback is plain session IDs.',
      },
    ]);
    expect(
      fetcher.mock.calls.every(
        ([input]) => !(input instanceof URL && input.origin === 'https://ui.example.test'),
      ),
    ).toBe(true);
    expect(doctorReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([200, 302, 401, 404, 500])(
    'passes on UI HTTP %i without reading or awaiting its body',
    async (status) => {
      const ctx = doctorContext({ slack: false });
      ctx.config.web.spurUiOrigin = 'https://ui.example.test';
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream({ cancel });
      const response = new Response(body, {
        status,
        headers: { Location: 'https://redirect-private-canary.test' },
      });
      const readBody = vi.spyOn(response, 'text');
      const fallback = doctorFetch();
      const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        input instanceof URL && input.origin === ctx.config.web.spurUiOrigin
          ? Promise.resolve(response)
          : fallback(input, init),
      );
      const report = await runDaemonDoctor(ctx, '1.2.3', fetcher);
      expect(report.checks.filter(({ id }) => id === 'web.spurUiOrigin')).toEqual([
        { id: 'web.spurUiOrigin', status: 'pass', blocking: false, fix: null },
      ]);
      const calls = fetcher.mock.calls.filter(
        ([input]) => input instanceof URL && input.href === 'https://ui.example.test/',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({
        method: 'GET',
        redirect: 'manual',
      });
      expect(Object.keys(calls[0]?.[1] ?? {}).sort()).toEqual(['method', 'redirect', 'signal']);
      expect(calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(cancel).toHaveBeenCalledOnce();
      expect(readBody).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain('redirect-private-canary');
    },
  );

  it.each<[string, unknown, string]>([
    ...[
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].map((code): [string, unknown, string] => [
      code,
      new TypeError('message-canary', {
        cause: Object.assign(new Error('cause-canary'), { code }),
      }),
      code,
    ]),
    [
      'unknown code',
      new TypeError('message-canary', {
        cause: { code: 'unknown-code-canary\u001b' },
      }),
      'TypeError',
    ],
    [
      'connection refused',
      new TypeError('message-canary', { cause: new Error('refused-cause-canary') }),
      'TypeError',
    ],
    [
      'TLS',
      new TypeError('tls-message-canary', { cause: new Error('tls-cause-canary') }),
      'TypeError',
    ],
    ['non-Error', 'non-error-canary', 'Error'],
    [
      'malicious name',
      Object.assign(new Error('message-canary'), { name: 'name-canary' }),
      'Error',
    ],
    ['abort', new DOMException('abort-canary', 'AbortError'), 'AbortError'],
  ])(
    'reports a safe UI warning for %s and sanitizes before real logging',
    async (_case, error, errorClass) => {
      const ctx = doctorContext({ slack: false });
      // A long valid origin must not overflow the report fix limit.
      ctx.config.web.spurUiOrigin = `https://${'a'.repeat(300)}.example.test`;
      let logs = '';
      const log = createLogger(
        {
          write: (line) => {
            logs += line;
          },
        },
        {},
      );
      ctx.logCall = (call, fn) => logCall(log, ctx.clock, call, fn);
      const fallback = doctorFetch();
      const report = await runDaemonDoctor(ctx, '1.2.3', (input, init) =>
        input instanceof URL && input.origin === ctx.config.web.spurUiOrigin
          ? // A fetch implementation can reject with an arbitrary value; exercise that boundary.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise arbitrary fetch rejections
            Promise.reject(error)
          : fallback(input, init),
      );
      const ui = report.checks.find(({ id }) => id === 'web.spurUiOrigin');
      expect(ui).toMatchObject({
        id: 'web.spurUiOrigin',
        status: 'warning',
        blocking: false,
      });
      expect(ui?.fix).toContain(`(${errorClass})`);
      if (errorClass === 'CERT_HAS_EXPIRED') expect(ui?.fix).toContain('Renew');
      else if (
        [
          'DEPTH_ZERO_SELF_SIGNED_CERT',
          'SELF_SIGNED_CERT_IN_CHAIN',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        ].includes(errorClass)
      )
        expect(ui?.fix).toContain('NODE_EXTRA_CA_CERTS');
      expect(doctorReportSchema.safeParse(report).success).toBe(true);
      expect(logs).toContain('doctor.web.spurUiOrigin');
      expect(logs).toContain('"outcome":"error"');
      expect(JSON.stringify(report) + logs).not.toContain('canary');
    },
  );

  it.each([
    [false, 50, 50],
    [true, 50, 50],
    [false, 5_000, 2_000],
  ] as const)(
    'bounds UI probes even when fetch ignores abort (%s, %i ms)',
    async (abortAware, deadlineMs, budget) => {
      vi.useFakeTimers();
      try {
        const ctx = doctorContext({ slack: false });
        ctx.config.web.spurUiOrigin = 'https://ui.example.test';
        let signal: AbortSignal | null | undefined;
        const fallback = doctorFetch();
        const pending = runDaemonDoctor(
          ctx,
          '1.2.3',
          (input, init) => {
            if (!(input instanceof URL && input.origin === ctx.config.web.spurUiOrigin))
              return fallback(input, init);
            signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              if (abortAware)
                signal?.addEventListener('abort', () => {
                  reject(new TypeError('abort-canary'));
                });
            });
          },
          { deadlineMs },
        );
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(budget - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const report = await pending;
        expect(signal?.aborted).toBe(true);
        const ui = report.checks.find(({ id }) => id === 'web.spurUiOrigin');
        expect(ui).toMatchObject({
          status: 'warning',
          blocking: false,
        });
        expect(ui?.fix).toContain('(TimeoutError)');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('accepts only the exact mixed-case doctor ID and preserves report bounds', () => {
    const report = (id: string, fix: string | null = null) => ({
      version: '1',
      checks: [{ id, status: 'pass', blocking: false, fix }],
    });
    expect(doctorReportSchema.safeParse(report('web.spurUiOrigin')).success).toBe(true);
    for (const id of [
      'web.spurUIOrigin',
      'Other.check',
      'web.spurUiOrigin.extra',
      'bad-id',
      'a'.repeat(61),
    ])
      expect(doctorReportSchema.safeParse(report(id)).success).toBe(false);
    expect(doctorReportSchema.safeParse(report('web.spurUiOrigin', 'x'.repeat(301))).success).toBe(
      false,
    );
    expect(
      doctorReportSchema.safeParse({
        version: '1',
        checks: Array.from({ length: 31 }, () => report('web').checks[0]),
      }).success,
    ).toBe(false);
  });

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

  // A failed body is read for the rate-limit rule, so its read must end at the deadline too.
  it.each([
    ['REST', 'github.rest-stalled-403'],
    ['GraphQL', 'github.graphql-stalled-403'],
  ])('bounds a failed %s body with the doctor deadline', async (_probe, mode) => {
    const started = Date.now();
    const report = await runDaemonDoctor(
      doctorContext({ operator: true, slack: false }),
      '1.2.3',
      doctorFetch(mode),
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
      [...section.matchAll(/^### ([a-z][a-z0-9_.]+|web\.spurUiOrigin)$/gm)].map(
        (match) => match[1],
      ),
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
      'operator.tokens',
      'curator.sessions',
      'orchestrator.sessions',
      'web.spurUiOrigin',
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
    ctx.config.web.spurUiOrigin = 'https://ui.example.test';
    const fallback = doctorFetch(undefined, [samplePr(1, 'BOARD-1-x')]);
    const report = await runDaemonDoctor(ctx, '1.2.3', (input, init) =>
      input instanceof URL && input.href === 'https://ui.example.test/'
        ? Promise.resolve(new Response(null))
        : fallback(input, init),
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
      'operator.tokens',
      'curator.sessions',
      'orchestrator.sessions',
      'web.spurUiOrigin',
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
        // curator.sessions passes with text naming each project's curator, operator.path with
        // each project's operator.
        .every(
          (check) =>
            check.status === 'pass' &&
            (['curator.sessions', 'orchestrator.sessions', 'operator.path'].includes(check.id) ||
              check.fix === null),
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

const GITHUB_THROTTLED =
  'GitHub is rate limiting this token, so access was not checked; rerun board doctor after the limit resets.';
const GITHUB_FIX_TEXT = 'Check the GitHub token and repository access.';
type GithubErrorFixture = Parameters<typeof graphqlFailure>[0][number];
// One GitHub answer for the parity table; `errors` rows answer 200 with these GraphQL errors.
type GithubFixture = { http: () => Response } | { errors: readonly GithubErrorFixture[] };

// Answers the doctor's GitHub probe `target` and the link sample with `answer`; the rest of the
// doctor's requests get the passing doctorFetch answers.
function githubFixtureFetch(target: 'rest' | 'graphql', answer: () => Response): typeof fetch {
  const passing = doctorFetch();
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof URL ? input.href : input instanceof Request ? input.url : input,
    );
    const graphql = url.pathname === '/graphql';
    if (url.host === 'api.github.com' && (isLinkSample(init) || graphql === (target === 'graphql')))
      return Promise.resolve(answer());
    return passing(input, init);
  });
}

function errorsResponse(errors: readonly GithubErrorFixture[]): Response {
  return Response.json({ data: { repository: null }, errors });
}

// The doctor's own GraphQL probe query, read from the request it sent.
function sentProbeQuery(fetcher: typeof fetch): string {
  const call = vi
    .mocked(fetcher)
    .mock.calls.find(
      ([input, init]) =>
        typeof input === 'string' && input.endsWith('/graphql') && !isLinkSample(init),
    );
  if (typeof call?.[1]?.body !== 'string') throw new Error('Expected the doctor GraphQL probe');
  return (JSON.parse(call[1].body) as { query: string }).query;
}

async function githubCheckFor(fetcher: typeof fetch) {
  const report = await runDaemonDoctor(
    doctorContext({ operator: true, slack: false }),
    '1.2.3',
    fetcher,
  );
  return report.checks.find((entry) => entry.id === 'github.credentials');
}

const teamPath = [
  'repository',
  'pullRequests',
  'nodes',
  0,
  'reviewRequests',
  'nodes',
  0,
  'requestedReviewer',
  'slug',
];
const scopeMessage = 'Your token has not been granted the required scopes.';

describe('doctor and adapter GitHub classification', () => {
  const failed = { status: 'fail', blocking: true, fix: GITHUB_FIX_TEXT };
  const throttled = { status: 'warning', blocking: false, fix: GITHUB_THROTTLED };
  const teams = {
    status: 'fail',
    blocking: true,
    fix: expect.stringContaining('read:org') as string,
  };
  it.each<[string, GithubFixture, string, object]>([
    ['401', { http: () => new Response('Bad credentials', { status: 401 }) }, 'auth', failed],
    ['plain 403', { http: () => new Response(null, { status: 403 }) }, 'auth', failed],
    [
      '403 with no remaining requests',
      {
        http: () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      },
      'throttled',
      throttled,
    ],
    [
      '403 with a rate limit body',
      { http: () => new Response('API rate limit exceeded', { status: 403 }) },
      'throttled',
      throttled,
    ],
    ['429', { http: () => new Response(null, { status: 429 }) }, 'throttled', throttled],
    [
      'RATE_LIMITED GraphQL error',
      { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
      'throttled',
      throttled,
    ],
  ])('classifies %s alike', async (_case, fixture, kind, expected) => {
    const answer = 'http' in fixture ? fixture.http : () => errorsResponse(fixture.errors);
    const targets = 'http' in fixture ? (['rest', 'graphql'] as const) : (['graphql'] as const);
    for (const target of targets)
      expect(await githubCheckFor(githubFixtureFetch(target, answer))).toEqual({
        id: 'github.credentials',
        ...expected,
      });
    const project = doctorContext().config.projects[0];
    if (project === undefined) throw new Error('Expected a project');
    await expect(
      sampleLinkRules(
        {
          repo: 'example/board',
          login: project.operatorGithubLogin,
          tracker: project.tracker,
          link: project.link,
        },
        {
          token: 'github-secret-canary',
          now: () => 0,
          fetch: githubFixtureFetch('graphql', answer),
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ kind });
  });

  // The team rule needs `... on Team { slug }` in the query, so these rows use the doctor's own.
  it.each<[string, GithubErrorFixture[], object, object | null, boolean]>([
    [
      'RATE_LIMITED GraphQL error',
      [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
      throttled,
      { kind: 'throttled' },
      false,
    ],
    [
      'INSUFFICIENT_SCOPES on the team path',
      [{ type: 'INSUFFICIENT_SCOPES', message: scopeMessage, path: teamPath }],
      teams,
      { kind: 'auth', message: 'GitHub token needs read:org for team review requests' },
      true,
    ],
    [
      'pathless INSUFFICIENT_SCOPES naming slug and read:org',
      [
        {
          type: 'INSUFFICIENT_SCOPES',
          message: "Field 'slug' requires read:org or read:discussion scope",
        },
      ],
      teams,
      { kind: 'auth', message: 'GitHub token needs read:org for team review requests' },
      true,
    ],
    [
      'INSUFFICIENT_SCOPES off the team path',
      [
        {
          type: 'INSUFFICIENT_SCOPES',
          message: scopeMessage,
          path: ['repository', 'defaultBranchRef'],
        },
      ],
      failed,
      { kind: 'auth', message: 'GitHub token lacks a required GraphQL read scope' },
      false,
    ],
    [
      'FORBIDDEN check runs',
      [
        {
          type: 'FORBIDDEN',
          message: 'Resource not accessible by personal access token',
          path: ['repository', 'defaultBranchRef', 'target', 'statusCheckRollup', 'contexts'],
        },
      ],
      { status: 'fail', blocking: true, fix: expect.stringContaining('SSO') as string },
      null,
      false,
    ],
  ])('classifies %s with the doctor query', async (_case, errors, expected, failure, team) => {
    const fetcher = githubFixtureFetch('graphql', () => errorsResponse(errors));
    expect(await githubCheckFor(fetcher)).toEqual({ id: 'github.credentials', ...expected });
    const query = sentProbeQuery(fetcher);
    const classified = graphqlFailure(errors, query, new Headers(), 0);
    if (failure === null) {
      expect(classified).toBeNull();
      expect(checkAccessDenied(errors)).toBe(true);
    } else expect(classified).toMatchObject(failure);
    expect(errors.some((error) => teamScopeDenied(error, query))).toBe(team);
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

describe('daemon doctor orchestrator sessions', () => {
  it('warns without blocking for missing sessions and unused orchestrators within report bounds', async () => {
    const ctx = doctorContext({
      operator: true,
      projects: [
        {
          id: 'alpha',
          spurProjects: [
            { name: 'reviewer', role: 'orchestrator' },
            { name: 'unused', role: 'orchestrator' },
          ],
          columns: [
            { id: 'todo', orchestrator: 'none' },
            { id: 'dev', orchestrator: 'none' },
            { id: 'review', orchestrator: 'reviewer' },
            { id: 'done', orchestrator: 'none' },
          ],
        },
      ],
    });
    await seedSession(ctx, 'review-1', 'reviewer');
    const report = await runDaemonDoctor(ctx, '1.2.3', doctorFetch());
    const entry = report.checks.find((check) => check.id === 'orchestrator.sessions');
    expect(entry).toMatchObject({ status: 'warning', blocking: false });
    expect(entry?.fix).toContain('unused');
    expect(entry?.fix).toContain('no live session');
    expect(entry?.fix).toContain('review-1');
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
    expect(report.checks.length).toBeLessThanOrEqual(30);
  });
});

describe('daemon doctor board-wide bindings', () => {
  const boardWide = () =>
    doctorContext({
      projects: [
        { id: 'alpha', spurProjects: [{ name: 'alpha-ops', role: 'operator' }] },
        { id: 'beta', spurProjects: [] },
      ],
      boardWide: [
        { name: 'br', role: 'orchestrator', columns: ['review'] },
        { name: 'hq', role: 'operator' },
      ],
    });
  const checkOf = (report: Awaited<ReturnType<typeof runDaemonDoctor>>, id: string) =>
    report.checks.find((check) => check.id === id);

  it('tags a board-wide orchestrator in orchestrator.sessions', async () => {
    const ctx = boardWide();
    await seedSession(ctx, 'br-1', 'br');
    const entry = checkOf(
      await runDaemonDoctor(ctx, '1.2.3', doctorFetch()),
      'orchestrator.sessions',
    );
    expect(entry).toMatchObject({ status: 'pass', blocking: false });
    expect(entry?.fix).toBe(
      'alpha: orchestrator br (board-wide), session br-1, columns review. beta: orchestrator br (board-wide), session br-1, columns review.',
    );
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
  });

  it('names each project operator with its source and the default addressee on a pass', async () => {
    const entry = checkOf(
      await runDaemonDoctor(boardWide(), '1.2.3', doctorFetch()),
      'operator.path',
    );
    expect(entry).toEqual({
      id: 'operator.path',
      status: 'pass',
      blocking: false,
      fix: 'alpha: operator alpha-ops (project). beta: operator hq (board-wide). Default Slack addressee: hq (board-wide).',
    });
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
  });

  it('keeps a long operator list within the fix bound', async () => {
    const ctx = doctorContext({
      projects: [
        ...Array.from({ length: 15 }, (_, index) => ({
          id: `project-${String(index)}`,
          spurProjects: [
            { name: `ops-${String(index)}-${'x'.repeat(180)}`, role: 'operator' as const },
          ],
        })),
        { id: 'project-15', spurProjects: [] },
      ],
      boardWide: [{ name: 'hq', role: 'operator' }],
    });
    const entry = checkOf(await runDaemonDoctor(ctx, '1.2.3', doctorFetch()), 'operator.path');
    expect(entry).toMatchObject({ status: 'pass', blocking: false });
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
    expect(entry?.fix).toMatch(
      /^project-0: operator ops-0-x+ \(project\); and 15 more projects\. Default Slack addressee: hq \(board-wide\)\.$/,
    );
  });

  it("names the other projects' operators while no board-wide operator exists", async () => {
    const ctx = doctorContext({
      projects: [
        { id: 'alpha', spurProjects: [{ name: 'alpha-ops', role: 'operator' }] },
        { id: 'beta', spurProjects: [{ name: 'beta-ops', role: 'operator' }] },
      ],
    });
    const entry = checkOf(await runDaemonDoctor(ctx, '1.2.3', doctorFetch()), 'operator.path');
    expect(entry).toMatchObject({ status: 'pass', blocking: false });
    expect(entry?.fix).toBe(
      'alpha: operator alpha-ops (project), beta-ops (other-project). beta: operator beta-ops (project), alpha-ops (other-project).',
    );
  });

  it('falls back to a project count when every long operator acts on every project', async () => {
    const ctx = doctorContext({
      projects: Array.from({ length: 15 }, (_, index) => ({
        id: `project-${String(index)}`,
        spurProjects: [
          { name: `ops-${String(index)}-${'x'.repeat(200)}`, role: 'operator' as const },
        ],
      })),
    });
    const entry = checkOf(await runDaemonDoctor(ctx, '1.2.3', doctorFetch()), 'operator.path');
    expect(entry).toMatchObject({
      status: 'pass',
      blocking: false,
      fix: '15 projects have an operator Spur project.',
    });
  });

  it('passes operator.path with no text for an approved token alone', async () => {
    const ctx = doctorContext();
    await seedApprovedToken(ctx.store, ctx.config, { name: 'desk', folder: tokenFolder() });
    expect(checkOf(await runDaemonDoctor(ctx, '1.2.3', doctorFetch()), 'operator.path')).toEqual({
      id: 'operator.path',
      status: 'pass',
      blocking: false,
      fix: null,
    });
  });
});

describe('bounded orchestrator diagnostics', () => {
  it('shortens many long orchestrator names without blocking', async () => {
    const ctx = doctorContext({
      operator: true,
      projects: Array.from({ length: 15 }, (_, index) => ({
        id: `project-${String(index)}`,
        spurProjects: [
          { name: `executor-${String(index)}-${'x'.repeat(200)}`, role: 'orchestrator' as const },
        ],
      })),
    });
    const report = await runDaemonDoctor(ctx, '1.2.3', doctorFetch());
    const entry = report.checks.find((check) => check.id === 'orchestrator.sessions');
    expect(entry).toMatchObject({ status: 'warning', blocking: false });
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
    expect(entry?.fix).toContain('15');
    expect(report.checks.length).toBeLessThanOrEqual(30);
  });
});

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

const DOCTOR_NOW = Date.parse('2026-11-04T08:00:00.000Z');
const DAY_MS = 86_400_000;

/** A folder holding `.spur-board/token`, as `board token create` leaves it. */
function tokenFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'doctor-token-'));
  mkdirSync(join(folder, '.spur-board'));
  writeFileSync(join(folder, '.spur-board', 'token'), 'example-file-secret');
  return folder;
}

/** Requests a token and approves it with a test-side update; core does not export the decision. */
async function seedApprovedToken(
  store: Store,
  config: ModuleContext<Store>['config'],
  token: { name: string; folder: string; host?: string; lastUsedAt?: number },
): Promise<string> {
  const secret = `secret-${token.name}`;
  await requestToken(
    store,
    config,
    {
      name: token.name,
      folder: token.folder,
      host: token.host ?? hostname(),
      hash: createHash('sha256').update(secret).digest('hex'),
    },
    new Date(DOCTOR_NOW),
  );
  await store.db
    .updateTable('operator_token')
    .set({
      status: 'approved',
      last_used_at:
        token.lastUsedAt === undefined ? null : new Date(token.lastUsedAt).toISOString(),
    })
    .where('name', '=', token.name)
    .execute();
  return secret;
}

describe('daemon doctor operator tokens', () => {
  const tokensCheck = async (ctx: ModuleContext<Store>) =>
    (await runDaemonDoctor(ctx, '1.2.3', doctorFetch())).checks.find(
      (check) => check.id === 'operator.tokens',
    );
  const PASS = { id: 'operator.tokens', status: 'pass', blocking: false, fix: null };

  it('passes for a fresh token whose file is present', async () => {
    const ctx = doctorContext({ operator: true });
    await seedApprovedToken(ctx.store, ctx.config, { name: 'desk', folder: tokenFolder() });
    expect(await tokensCheck(ctx)).toEqual(PASS);
  });

  it('warns about a token unused for longer than unusedAfterDays, and not before', async () => {
    const ctx = doctorContext({ operator: true });
    await seedApprovedToken(ctx.store, ctx.config, {
      name: 'desk',
      folder: tokenFolder(),
      lastUsedAt: DOCTOR_NOW - 15 * DAY_MS,
    });
    await seedApprovedToken(ctx.store, ctx.config, {
      name: 'recent',
      folder: tokenFolder(),
      lastUsedAt: DOCTOR_NOW - 13 * DAY_MS,
    });
    expect(await tokensCheck(ctx)).toEqual({
      id: 'operator.tokens',
      status: 'warning',
      blocking: false,
      fix: tokenAttentionLine({ fileMissing: [], unused: ['desk'] }, 14),
    });
    expect((await tokensCheck(ctx))?.fix).toContain('unused for 14+ days: desk');
  });

  it('passes for a token used 13 days ago', async () => {
    const ctx = doctorContext({ operator: true });
    await seedApprovedToken(ctx.store, ctx.config, {
      name: 'desk',
      folder: tokenFolder(),
      lastUsedAt: DOCTOR_NOW - 13 * DAY_MS,
    });
    expect(await tokensCheck(ctx)).toEqual(PASS);
  });

  it('warns about a deleted folder and a folder without its token file', async () => {
    const ctx = doctorContext({ operator: true });
    const gone = tokenFolder();
    rmSync(gone, { recursive: true });
    const emptied = tokenFolder();
    rmSync(join(emptied, '.spur-board', 'token'));
    await seedApprovedToken(ctx.store, ctx.config, { name: 'gone', folder: gone });
    await seedApprovedToken(ctx.store, ctx.config, { name: 'emptied', folder: emptied });
    expect(await tokensCheck(ctx)).toEqual({
      id: 'operator.tokens',
      status: 'warning',
      blocking: false,
      fix: tokenAttentionLine({ fileMissing: ['gone', 'emptied'], unused: [] }, 14),
    });
    expect((await tokensCheck(ctx))?.fix).toContain('no token file: gone, emptied');
    expect((await tokensCheck(ctx))?.fix).not.toContain(gone);
  });

  it('skips the folder check for another host and ignores a revoked token', async () => {
    const ctx = doctorContext({ operator: true });
    const missing = join(tmpdir(), 'doctor-token-never-created');
    await seedApprovedToken(ctx.store, ctx.config, {
      name: 'away',
      folder: missing,
      host: 'elsewhere',
    });
    await seedApprovedToken(ctx.store, ctx.config, { name: 'revoked', folder: missing });
    await ctx.store.db
      .updateTable('operator_token')
      .set({ status: 'revoked' })
      .where('name', '=', 'revoked')
      .execute();
    expect(await tokensCheck(ctx)).toEqual(PASS);
  });

  it('fits twenty long token names in the fix limit', async () => {
    const ctx = doctorContext({ operator: true });
    const names = Array.from(
      { length: 20 },
      (_, n) => `${String(n).padStart(2, '0')}-${'t'.repeat(57)}`,
    );
    // Each request is approved before the next, so the open request limit never applies.
    for (const name of names) {
      await seedApprovedToken(ctx.store, ctx.config, {
        name,
        folder: tokenFolder(),
        lastUsedAt: DOCTOR_NOW - 30 * DAY_MS,
      });
    }
    const entry = await tokensCheck(ctx);
    expect(entry).toMatchObject({ status: 'warning', blocking: false });
    expect(entry?.fix).toBe(tokenAttentionLine({ fileMissing: [], unused: names }, 14));
    expect(entry?.fix?.length).toBeLessThanOrEqual(300);
    expect(entry?.fix).toMatch(/ and \d+ more$/);
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
      expect(doctorReportSchema.safeParse(report).success).toBe(true);
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

  /** Lists tokens with Bearer `secret` through a real HTTP module on a fixed clock. */
  async function listWithToken(failFirstTransaction: boolean) {
    const home = makeHome({ httpPort: 0 });
    const store = openStore(join(home, 'board.sqlite'));
    stores.push(store);
    const loaded = loadConfig(resolvePaths({ BOARD_HOME: home }, home));
    const records: Record<string, unknown>[] = [];
    const log = createLogger(
      { write: (line) => records.push(JSON.parse(line) as Record<string, unknown>) },
      {},
    ).child({ module: 'http' });
    const clock = { now: () => DOCTOR_NOW };
    const secret = await seedApprovedToken(store, loaded.config, { name: 'desk', folder: '/w/a' });
    await seedApprovedToken(store, loaded.config, { name: 'idle', folder: '/w/b' });
    let failNext = false;
    const ctx: ModuleContext<Store> = {
      ...loaded,
      store: {
        ...store,
        transaction: (fn) => {
          if (!failNext) return store.transaction(fn);
          failNext = false;
          return Promise.reject(new Error('injected'));
        },
      },
      log,
      clock,
      logCall: (call, fn) => logCall(log, clock, call, fn),
      state: () => 'ready',
    };
    const module = createHttpModule(ctx, {
      fetcher: () => Promise.resolve(Response.json(wire)),
      registry: createOperationRegistry({ config: loaded.config, clock, completeSince: new Map() }),
    });
    try {
      await module.start(new AbortController().signal);
      const listening = records.find((record) => record['msg'] === 'http listening');
      failNext = failFirstTransaction;
      const response = await fetch(
        `http://127.0.0.1:${String(listening?.['port'])}/v1/ops/token.list`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ input: {} }),
        },
      );
      const body = (await response.json()) as {
        value?: { tokens: { name: string; lastUsedAt: string | null }[] };
      };
      return { status: response.status, tokens: body.value?.tokens, records };
    } finally {
      await module.stop();
    }
  }

  it("records the calling token's last use at the daemon clock", async () => {
    const result = await listWithToken(false);
    expect(result.status).toBe(200);
    expect(result.tokens).toMatchObject([
      { name: 'desk', lastUsedAt: '2026-11-04T08:00:00.000Z' },
      { name: 'idle', lastUsedAt: null },
    ]);
    expect(result.records.some((record) => record['msg'] === 'token use not recorded')).toBe(false);
  });

  it('serves the call and logs the error when the token use is not recorded', async () => {
    const result = await listWithToken(true);
    expect(result.status).toBe(200);
    expect(result.tokens).toMatchObject([
      { name: 'desk', lastUsedAt: null },
      { name: 'idle', lastUsedAt: null },
    ]);
    expect(
      result.records.find((record) => record['msg'] === 'token use not recorded'),
    ).toMatchObject({
      level: 40,
      err: { message: 'injected' },
    });
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

describe('optional web module', () => {
  it('resolves an ephemeral public origin, logs browser audit fields, reports state and closes', async () => {
    const ctx = doctorContext({ issues: true });
    const lines: string[] = [];
    const config = configSchema.parse({
      ...ctx.config,
      http: { port: 4311 },
      web: { port: 0, publicOrigin: 'http://127.0.0.1:{port}' },
    });
    const context = {
      ...ctx,
      config,
      log: createLogger(
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
        {},
      ).child({ module: 'web' }),
    };
    let address = '';
    const web = createWebModule(context, {
      registry: createOperationRegistry({ config, clock: ctx.clock, completeSince: new Map() }),
      onListening: (value) => {
        address = value;
      },
      firstPollDone: () => Promise.resolve(true),
      webRoot: join(makeHome(), 'missing'),
    });
    expect(web.listening()).toBe(false);
    await web.start(new AbortController().signal);
    try {
      expect(web.listening()).toBe(true);
      const response = await fetch(`${address}/v1/health?secret=hidden`, {
        headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Browser test' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ firstPollDone: true });
      const accepted = await fetch(`${address}/v1/ops/status.get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: address },
        body: '{"input":{}}',
      });
      expect(accepted.status).toBe(200);
      await accepted.body?.cancel();
      const denied = await fetch(`${address}/v1/ops/status.get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'null' },
        body: '{"input":{}}',
      });
      expect(denied.status).toBe(403);
      await denied.body?.cancel();
      const report = await runDaemonDoctor(context, '1.2.3', doctorFetch(), {
        webListening: () => web.listening(),
      });
      expect(report.checks.find((check) => check.id === 'web.listening')?.status).toBe('pass');
      expect(lines.join('')).toContain('"via":"web"');
      expect(lines.join('')).toContain('"forwardedFor":"192.0.2.1"');
      expect(lines.join('')).toContain('"userAgent":"Browser test"');
      expect(lines.join('')).toContain('"status":403');
      expect(lines.join('')).not.toContain('secret=hidden');
    } finally {
      await web.stop();
    }
    expect(web.listening()).toBe(false);
    await expect(fetch(`${address}/v1/health`)).rejects.toThrow();
  });

  it('leaves an aborted web start closed', async () => {
    const ctx = doctorContext();
    const controller = new AbortController();
    controller.abort();
    const web = createWebModule(ctx, { registry: {} });
    await web.start(controller.signal);
    expect(web.listening()).toBe(false);
    await web.stop();
  });
});

describe('daemon doctor github.review_rule', () => {
  const ruledColumns = [
    { id: 'todo' },
    { id: 'dev' },
    { id: 'external-review', approvalRule: 'github-rules' },
    { id: 'done' },
  ];
  const ruledContext = (secrets?: Readonly<Record<string, string>>, repos?: readonly string[]) =>
    doctorContext({
      operator: true,
      slack: false,
      ...(secrets === undefined ? {} : { secrets }),
      ...(repos === undefined ? {} : { repos }),
      projects: [{ id: 'board', spurProjects: [], columns: ruledColumns }],
    });
  // A branch-rule fixture recorded or written for the adapter tests, as GitHub answers it.
  const fixture = (name: string): { data: { repository: unknown } } =>
    JSON.parse(
      readFileSync(
        new URL(`../../adapters/test/github/fixtures/branch-rule/${name}.json`, import.meta.url),
        'utf8',
      ),
    ) as { data: { repository: unknown } };
  const isRuleRead = (init?: RequestInit) =>
    typeof init?.body === 'string' && init.body.includes('query BranchRule');
  // Answers the rule read with the fixture `answers` names, one for every repo or one per repo
  // name, or a GraphQL error for `error`; every other request goes to `doctorFetch`.
  const ruleFetch = (answers: string | Readonly<Record<string, string>>): typeof fetch => {
    const fallback = doctorFetch();
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!isRuleRead(init)) return fallback(input, init);
      const { repo } = (JSON.parse(init?.body as string) as { variables: { repo: string } })
        .variables;
      const answer = typeof answers === 'string' ? answers : (answers[repo] ?? 'error');
      const rateLimit = { remaining: 4000, resetAt: '2026-11-04T09:00:00.000Z' };
      if (answer === 'error')
        return Promise.resolve(
          Response.json({
            data: { rateLimit, repository: { defaultBranchRef: null } },
            errors: [{ message: 'secret-canary denied', type: 'FORBIDDEN', path: ['repository'] }],
          }),
        );
      return Promise.resolve(
        Response.json({ data: { rateLimit, repository: fixture(answer).data.repository } }),
      );
    });
  };
  const checkOf = async (fetcher: typeof fetch, ctx = ruledContext()) => {
    const report = await runDaemonDoctor(ctx, '1.2.3', fetcher);
    expect(doctorReportSchema.parse(report)).toEqual(report);
    return {
      rule: report.checks.find((check) => check.id === 'github.review_rule'),
      credentials: report.checks.find((check) => check.id === 'github.credentials'),
      ids: report.checks.map((check) => check.id),
    };
  };

  it('github.review_rule passes on the recorded ruleset and names what it read', async () => {
    const fetcher = ruleFetch('live-default-branch');
    const { rule, ids } = await checkOf(fetcher);
    expect(rule).toEqual({
      id: 'github.review_rule',
      status: 'pass',
      blocking: false,
      fix: 'board example/board@main: ruleset: 1 approvals, code owners no, resolved conversations yes, checks ci-ok.',
    });
    expect(ids.indexOf('github.review_rule')).toBe(ids.indexOf('link.rules') + 1);
    const read = vi.mocked(fetcher).mock.calls.find(([, init]) => isRuleRead(init))?.[1]
      ?.body as string;
    expect(JSON.parse(read)).toMatchObject({ variables: { owner: 'example', repo: 'board' } });
    expect(read).toContain('defaultBranchRef { name refUpdateRule {');
    expect(read).toContain('rules(first: 100)');
  });

  it('github.review_rule passes naming branch protection', async () => {
    expect((await checkOf(ruleFetch('branch-protection'))).rule).toMatchObject({
      status: 'pass',
      fix: 'board example/board@main: branch protection: 2 approvals, code owners yes, resolved conversations no, checks build, test.',
    });
  });

  it('github.review_rule passes on a rule that requires only resolved conversations', async () => {
    expect((await checkOf(ruleFetch('conversation-only'))).rule).toEqual({
      id: 'github.review_rule',
      status: 'pass',
      blocking: false,
      fix: 'board example/board@main: branch protection: 0 approvals, code owners no, resolved conversations yes, checks none.',
    });
  });

  it('github.review_rule warns when the repo has no review rule', async () => {
    const { rule } = await checkOf(ruleFetch('none'));
    expect(rule).toMatchObject({ status: 'warning', blocking: false });
    expect(rule?.fix).toBe(
      'board example/board@main: no branch protection or ruleset, no review rule to follow. Require an approval or code owner review on the default branch, or remove approvalRule.',
    );
  });

  it('github.review_rule warns when the branch has more ruleset rules than one read returns', async () => {
    const { rule } = await checkOf(ruleFetch('truncated'));
    expect(rule).toMatchObject({ status: 'warning', blocking: false });
    expect(rule?.fix).toBe(
      'board example/board@main: more than 100 ruleset rules, more than the Board reads.',
    );
  });

  it('github.review_rule warns on a failed read and leaves github.credentials passing', async () => {
    const { rule, credentials } = await checkOf(ruleFetch('error'));
    expect(rule).toMatchObject({ status: 'warning', blocking: false });
    // The rule is still in force, unread: the fix is access, never a weaker gate.
    expect(rule?.fix).toBe(
      "board example/board: could not read the review rule. Give the token read access to the default branch's branch protection and rulesets, then rerun board doctor.",
    );
    expect(rule?.fix).not.toContain('secret-canary');
    expect(credentials).toMatchObject({ status: 'pass' });
  });

  it('github.review_rule keeps approvalRule when another repo of the project is unread', async () => {
    const { rule } = await checkOf(
      ruleFetch({ a: 'none', b: 'error' }),
      ruledContext(undefined, ['o/a', 'o/b']),
    );
    expect(rule).toMatchObject({ status: 'warning', blocking: false });
    // Removing the shared approvalRule would also turn off the gate of the unread repo.
    expect(rule?.fix).toBe(
      "board o/a@main: no branch protection or ruleset, no review rule to follow. board o/b: could not read the review rule. Require an approval or code owner review on the default branch. Give the token read access to the default branch's branch protection and rulesets, then rerun board doctor.",
    );
  });

  it('github.review_rule warns without a GitHub token and is absent without github-rules', async () => {
    const { rule } = await checkOf(ruleFetch('none'), ruledContext({}));
    expect(rule).toMatchObject({ status: 'warning', blocking: false });
    expect(rule?.fix).toContain('GITHUB_TOKEN');
    const fetcher = ruleFetch('live-default-branch');
    const plain = await checkOf(fetcher, doctorContext({ operator: true, slack: false }));
    expect(plain.rule).toBeUndefined();
    expect(vi.mocked(fetcher).mock.calls.some(([, init]) => isRuleRead(init))).toBe(false);
  });

  it('documents github.review_rule under Doctor checks', () => {
    const guide = readFileSync(new URL('../../../TROUBLESHOOTING.md', import.meta.url), 'utf8');
    const section = guide.split('## Doctor checks\n')[1]?.split('\n## ')[0] ?? '';
    expect(section).toMatch(/^### github\.review_rule$/m);
  });
});
