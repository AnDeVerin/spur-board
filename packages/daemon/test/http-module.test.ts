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
  } = {},
) {
  const store = openStore(join(makeHome(), 'board.sqlite'));
  stores.push(store);
  const config = configSchema.parse({
    projects: [
      {
        id: 'board',
        tracker: {
          type: 'jira',
          baseUrl: 'https://jira.example.test',
          jql: 'project = BOARD',
          doneStatuses: ['Done'],
          readyStatuses: ['Ready'],
        },
        repos: ['example/board'],
        operatorGithubLogin: 'operator',
        spurProjects: options.operator ? [{ name: 'operator', role: 'operator' }] : [],
      },
    ],
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

function doctorFetch(fail?: string): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof URL ? input.href : input instanceof Request ? input.url : input,
    );
    const path = url.pathname;
    if (path.endsWith('/myself'))
      return Promise.resolve(
        new Response(null, { status: fail === 'jira.credentials' ? 401 : 200 }),
      );
    if (url.host === 'api.github.com')
      return Promise.resolve(
        new Response(null, { status: fail === 'github.credentials' ? 403 : 200 }),
      );
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
      'spur.api',
      'slack.configured',
      'operator.path',
    ]);
    expect(report.checks.find((check) => check.id === 'slack.configured')).toEqual({
      id: 'slack.configured',
      status: 'warning',
      blocking: false,
      fix: 'Slack is not configured: questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to configure slack.channels.',
    });
    expect(report.checks.every((check) => !check.blocking)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
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
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports every daemon-owned check as passing without returning credential values', async () => {
    const ctx = doctorContext({ operator: true });
    const report = await runDaemonDoctor(ctx, '1.2.3', doctorFetch());
    expect(report.version).toBe('1.2.3');
    expect(report.checks.map((check) => check.id)).toEqual([
      'secrets',
      'jira.credentials',
      'github.credentials',
      'spur.api',
      'slack.auth',
      'slack.orchestrators_member',
      'slack.feed_member',
      'slack.command',
      'operator.path',
    ]);
    expect(report.checks.every((check) => check.status === 'pass' && check.fix === null)).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toMatch(/secret-canary/);
  });

  it.each([
    ['jira.credentials', 'Check the Jira account, API token, and project access.'],
    ['github.credentials', 'Check the GitHub token and repository access.'],
    ['spur.api', 'Start or correct the configured Spur API.'],
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

  it('serves starting until ready, logs request IDs, and closes its listener', async () => {
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
});
