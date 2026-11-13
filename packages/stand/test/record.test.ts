import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { resolvePaths } from '@spur-board/daemon/in-process';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  createReadGuard,
  narrow,
  needlesOf,
  record,
  RECORDING_FILES,
  scan,
} from '../src/record.ts';

const NOW = Date.parse('2026-03-04T05:06:07.000Z');
const SPUR = 'http://127.0.0.1:4999';
const JIRA = 'https://acme.atlassian.net';
const BOARD = 'acme-real/acme-board';
const SERVICE = 'acme-real/acme-service';
const LOGIN = 'real-person';
const SECRETS = {
  GITHUB_TOKEN: 'ghp_livetoken0123456789',
  JIRA_EMAIL: 'jane.doe@acme.example',
  JIRA_API_TOKEN: 'jira-live-token-xyz',
  SLACK_BOT_TOKEN: 'xoxb-live-slack-bot',
};
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
/** Every live-only word the fixtures use; none may survive a recording. */
const LIVE_WORDS = ['acme', 'real', 'jane', 'livetoken', 'live-token', 'live-slack', 'wiki'];

type Raw = Record<string, unknown>;

function liveConfig(spurNames: [string, string] = ['acme-worker', 'acme-dev']): Raw {
  return {
    projects: [
      {
        id: 'acme-jira',
        tracker: {
          type: 'jira',
          baseUrl: JIRA,
          jql: 'project = ACMEX AND labels in (team-blue) ORDER BY updated DESC',
          projectKeys: ['ACMEX'],
          doneStatuses: ['Shipped'],
          readyStatuses: ['Queued'],
        },
        repos: [SERVICE],
        operatorGithubLogin: LOGIN,
        spurProjects: [{ name: spurNames[0], role: 'worker' }],
      },
      {
        id: 'acme-board',
        tracker: { type: 'github-issues', repo: BOARD },
        repos: [BOARD],
        operatorGithubLogin: LOGIN,
        spurProjects: [{ name: spurNames[1], role: 'worker' }],
      },
    ],
    operator: { slack: 'U0OPERATOR' },
    slack: { channels: { orchestrators: 'C0ORCH', feed: 'C0FEED' } },
    digest: { tz: 'UTC' },
    adapters: { spur: { baseUrl: SPUR } },
  };
}

function projects(config: Raw): Raw[] {
  return config['projects'] as Raw[];
}

/** A temp home holding only config.yaml and secrets.env, as BOARD_HOME lays them out. */
function liveHome(config: Raw) {
  const home = mkdtempSync(join(tmpdir(), 'record-home-'));
  const paths = resolvePaths({ BOARD_HOME: home }, home);
  writeFileSync(paths.configFile, YAML.stringify(config));
  writeFileSync(
    paths.secretsFile,
    Object.entries(SECRETS)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
  chmodSync(paths.secretsFile, 0o600);
  return { home, paths, outDir: join(mkdtempSync(join(tmpdir(), 'record-out-')), 'recordings') };
}

const iso = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function prNode(number: number) {
  const page = { hasNextPage: false, endCursor: null };
  return {
    id: `PR_kwDOfixture${String(number)}`,
    number,
    url: `https://github.com/${BOARD}/pull/${String(number)}`,
    title: 'Fix the acme login for jane.doe@acme.example',
    updatedAt: iso(5),
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    author: { login: 'Real-Person' },
    headRefName: 'real-person/acme-fix',
    headRefOid: 'a'.repeat(40),
    statusCheckRollup: {
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name: 'acme-build',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            startedAt: iso(9),
            completedAt: iso(8),
            checkSuite: { createdAt: iso(9) },
            isRequired: true,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpHOAAAB' },
      },
    },
    reviews: {
      nodes: [
        {
          id: 'PRR_kwDOfixture',
          author: { __typename: 'User', login: 'someone-else' },
          state: 'APPROVED',
          commit: { oid: 'a'.repeat(40) },
          submittedAt: iso(7),
        },
      ],
      pageInfo: page,
    },
    comments: {
      nodes: [
        { id: 'IC_kwDOfixture', author: { __typename: 'User', login: LOGIN }, createdAt: iso(6) },
      ],
      pageInfo: { hasPreviousPage: false, startCursor: null },
    },
    reviewThreads: { nodes: [{ isResolved: false }], pageInfo: page },
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'acme-core' }, asCodeOwner: true }],
      pageInfo: page,
    },
    closingIssuesReferences: {
      nodes: [
        { number: 3, repository: { nameWithOwner: BOARD } },
        { number: 4, repository: { nameWithOwner: 'other-real/other-repo' } },
      ],
      pageInfo: page,
    },
  };
}

interface Fixture {
  statuses: string[];
  issueNodeId: string;
  spurLinks: { label: string; url: string }[];
  /** The Spur 404 body for the probe session. */
  probeBody?: Raw;
}

function defaultFixture(): Fixture {
  return {
    statuses: ['Queued', 'Shipped'],
    issueNodeId: 'I_kwDOfixture3',
    spurLinks: [
      { label: 'pr', url: `https://github.com/${BOARD}/pull/7` },
      { label: 'tracker', url: `${JIRA}/browse/ACMEX-3` },
      { label: 'docs', url: 'https://wiki.acme.example/page' },
    ],
  };
}

/** Answers the reads one bootstrap poll of the live config sends. */
function syntheticLive(fixture: Fixture = defaultFixture()) {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers });
  return vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Raw) : {};
    if (url.origin === SPUR) {
      if (url.pathname === '/sessions')
        return Promise.resolve(
          json(
            [
              {
                id: 'acme-worker-1f2e',
                project: 'acme-worker',
                branch: 'real-person/acme-fix',
                status: 'running',
                state: 'working',
                lastActivityAt: iso(1),
                note: 'free text for jane.doe@acme.example',
                slots: { title: 'Acme title', titleSource: 'agent', links: fixture.spurLinks },
              },
            ],
            200,
            { 'x-spur-lifecycle-instance-id': 'acme-instance-7' },
          ),
        );
      return Promise.resolve(
        json(fixture.probeBody ?? { error: `Session not found: ${url.pathname}` }, 404),
      );
    }
    if (url.href === 'https://api.github.com/graphql') {
      const variables = body['variables'] as Raw;
      const repo = `${String(variables['owner'])}/${String(variables['repo'])}`;
      const query = String(body['query']);
      const rateLimit = { remaining: 4_999, resetAt: iso(-60) };
      if (query.startsWith('query PrDetails'))
        return Promise.resolve(json({ data: { rateLimit, pr0: { pullRequest: prNode(7) } } }));
      const nodes =
        repo === BOARD
          ? [
              { number: 7, updatedAt: iso(5), author: { login: 'Real-Person' }, state: 'OPEN' },
              { number: 8, updatedAt: iso(4), author: { login: 'someone-else' }, state: 'OPEN' },
            ]
          : [];
      return Promise.resolve(
        json({
          data: {
            rateLimit,
            repository: {
              pullRequests: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: nodes.length > 0 ? 'Y3Vyc29y' : null },
              },
              mergedBaseline: { nodes: repo === BOARD ? [{ updatedAt: iso(30) }] : [] },
            },
          },
        }),
      );
    }
    if (url.origin === 'https://api.github.com')
      return Promise.resolve(
        json([
          {
            node_id: fixture.issueNodeId,
            number: 3,
            title: 'Acme issue by jane.doe@acme.example',
            state: 'open',
            html_url: `https://github.com/${BOARD}/issues/3`,
            updated_at: iso(3),
            labels: [{ name: 'acme-label', color: 'ffffff' }],
            assignee: { login: LOGIN, id: 5 },
            milestone: { title: 'Acme Q3', number: 1 },
            body: `secret ${SECRETS.GITHUB_TOKEN}`,
            user: { login: LOGIN },
          },
          {
            node_id: 'PR_kwDOfixture7',
            number: 7,
            title: 'Fix the acme login',
            state: 'open',
            html_url: `https://github.com/${BOARD}/pull/7`,
            updated_at: iso(5),
            labels: [],
            assignee: null,
            milestone: null,
            pull_request: {
              url: `https://api.github.com/repos/${BOARD}/pulls/7`,
              html_url: `https://github.com/${BOARD}/pull/7`,
            },
          },
        ]),
      );
    if (url.origin === JIRA) {
      if (url.pathname.endsWith('/statuses'))
        return Promise.resolve(
          json([
            {
              id: '10001',
              name: 'Acme Story',
              subtask: false,
              self: `${JIRA}/rest/api/3/issuetype/10001`,
              statuses: fixture.statuses.map((name, i) => ({
                id: String(i + 1),
                name,
                self: `${JIRA}/rest/api/3/status/${String(i + 1)}`,
              })),
            },
          ]),
        );
      if (url.pathname === '/rest/api/3/field')
        return Promise.resolve(
          json([
            {
              id: 'summary',
              name: 'Summary',
              custom: false,
              schema: { type: 'string', system: 'summary' },
            },
            { id: 'status', name: 'Status', custom: false, schema: { type: 'status' } },
            { id: 'assignee', name: 'Assignee', custom: false, schema: { type: 'user' } },
            { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array' } },
            { id: 'updated', name: 'Updated', custom: false, schema: { type: 'datetime' } },
            { id: 'customfield_99', name: 'Acme secret field', custom: true },
            {
              id: 'customfield_12345',
              name: 'Sprint',
              custom: true,
              schema: { type: 'array', custom: SPRINT_SCHEMA, customId: 12_345 },
            },
          ]),
        );
      return Promise.resolve(
        json({
          issues: [
            {
              id: '20001',
              key: 'ACMEX-3',
              self: `${JIRA}/rest/api/3/issue/20001`,
              expand: 'acme',
              fields: {
                summary: 'Acme summary',
                status: { name: 'Queued', self: `${JIRA}/rest/api/3/status/1` },
                assignee: {
                  accountId: '5b-acme-id',
                  displayName: 'Jane Doe',
                  emailAddress: SECRETS.JIRA_EMAIL,
                },
                labels: ['team-blue'],
                updated: '2026-03-04T00:00:00.000+0000',
                customfield_12345: [{ id: 1, name: 'Acme Sprint 4', state: 'active', boardId: 9 }],
                customfield_99: 'acme secret',
              },
            },
          ],
          isLast: true,
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request ${url.href}`));
  });
}

async function run(config: Raw = liveConfig(), fixture?: Fixture) {
  const { home, paths, outDir } = liveHome(config);
  const transport = syntheticLive(fixture);
  const errors: string[] = [];
  const code = await record({
    paths,
    fetch: transport,
    outDir,
    now: () => NOW,
    env: {},
    writeErr: (text) => errors.push(text),
  });
  const read = (source: string): Raw =>
    JSON.parse(readFileSync(join(outDir, RECORDING_FILES[source] ?? ''), 'utf8')) as Raw;
  const texts = (): string[] =>
    Object.values(RECORDING_FILES).map((file) => readFileSync(join(outDir, file), 'utf8'));
  return { code, errors: errors.join(''), home, outDir, transport, read, texts };
}

/** Every string at a key in `keys`, anywhere under `value`. */
function stringsAt(value: unknown, keys: ReadonlySet<string>, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) stringsAt(item, keys, out);
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key) && typeof item === 'string') out.push(item);
      stringsAt(item, keys, out);
    }
  return out;
}

type Exchange = {
  request: { url: string; headers: Raw; body: Raw | null };
  response: { status: number; headers: Raw; body: unknown };
};
const exchanges = (recording: Raw): Exchange[] => recording['exchanges'] as Exchange[];

describe('record:fakes', () => {
  it('refuses requests outside the read allowlist', async () => {
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const refused: string[] = [];
    const guarded = createReadGuard(narrow(configSchema.parse(liveConfig())), transport, refused);
    const post = (url: string, body: unknown, method = 'POST') =>
      guarded(url, { method, body: JSON.stringify(body) });
    const refusedCalls = [
      post('https://api.github.com/graphql', { query: 'mutation { addComment { id } }' }),
      post('https://api.github.com/graphql', { query: ' mutation Q { x }' }),
      post('https://api.github.com/graphql', {
        query: 'query A { a } mutation B { b }',
        operationName: 'B',
      }),
      post('https://api.github.com/graphql', { query: 'fragment F on Q { a }' }),
      post('https://api.github.com/graphql', { query: 'query { a' }),
      post(`https://api.github.com/repos/${BOARD}/issues`, { title: 'x' }),
      guarded(`https://api.github.com/repos/${BOARD}/issues/3`, { method: 'PATCH' }),
      guarded(`https://api.github.com/repos/${BOARD}/issues/3`, { method: 'DELETE' }),
      guarded('https://api.github.com/graphql', { method: 'PUT', body: '{"query":"query { a }"}' }),
      post(`${JIRA}/rest/api/3/issue`, { fields: {} }),
      post(`${JIRA}/rest/api/3/issue/20001/transitions`, {}),
      guarded(`${JIRA}/rest/api/3/issue/20001`, { method: 'PUT', body: '{}' }),
      post(`${SPUR}/sessions/acme-worker-1f2e/send`, { message: 'hi' }),
      guarded('https://evil.example/sessions'),
      guarded('https://api.github.com/repos/other-org/other-repo/issues'),
    ];
    for (const call of refusedCalls) await expect(call).rejects.toThrow(/refused/);
    expect(transport).not.toHaveBeenCalled();
    expect(refused).toHaveLength(refusedCalls.length);
    expect(refused.join('\n')).not.toMatch(/acme|evil|other-org/i);

    for (const url of [
      `${SPUR}/sessions`,
      `${SPUR}/sessions/stand-missing-session`,
      `https://api.github.com/repos/${BOARD}`,
      `https://api.github.com/repos/${BOARD}/issues?state=open&per_page=100`,
      `https://api.github.com/repos/${BOARD}/milestones?state=all&per_page=100`,
      `https://api.github.com/repos/${BOARD}/issues/3`,
      `${JIRA}/rest/api/3/project/ACMEX/statuses`,
      `${JIRA}/rest/api/3/field`,
      `${JIRA}/rest/api/3/issue/20001`,
    ])
      await guarded(url);
    await post('https://api.github.com/graphql', { query: 'query PrBatch { a }' });
    await post(`${JIRA}/rest/api/3/search/jql`, { jql: 'x' });
    expect(transport).toHaveBeenCalledTimes(11);
  });

  it('refuses live config shapes the stand cannot hold', async () => {
    const shapes: [string, (config: Raw) => void][] = [
      [
        'exactly one github-issues project',
        (config) => {
          projects(config).push({
            id: 'acme-two',
            tracker: { type: 'github-issues', repo: 'acme-real/acme-two' },
            repos: ['acme-real/acme-two'],
            operatorGithubLogin: LOGIN,
            spurProjects: [{ name: 'acme-two', role: 'worker' }],
          });
        },
      ],
      [
        'only its tracker repo',
        (config) => {
          (projects(config)[1] as { repos: string[] }).repos.push('acme-real/acme-extra');
        },
      ],
      [
        'no label or milestone',
        (config) => {
          (projects(config)[1]?.['tracker'] as Raw)['label'] = 'acme';
        },
      ],
      [
        'exactly one Jira project',
        (config) => {
          projects(config).push({
            ...(projects(config)[0] as Raw),
            id: 'acme-jira-two',
            repos: ['acme-real/acme-other'],
            spurProjects: [],
          });
        },
      ],
      [
        'exactly one repo',
        (config) => {
          (projects(config)[0] as { repos: string[] }).repos.push('acme-real/acme-extra');
        },
      ],
      [
        'exactly one project key',
        (config) => {
          (projects(config)[0]?.['tracker'] as { projectKeys: string[] }).projectKeys.push('ACMEY');
        },
      ],
      [
        'different repos',
        (config) => {
          (projects(config)[0] as { repos: string[] }).repos = [BOARD];
        },
      ],
      [
        'link block',
        (config) => {
          (projects(config)[1] as Raw)['link'] = { sources: ['branch'] };
        },
      ],
    ];
    for (const [message, change] of shapes) {
      const config = liveConfig();
      change(config);
      const result = await run(config);
      expect(result.code, message).toBe(1);
      expect(result.errors).toContain(message);
      expect(result.errors).not.toMatch(/acme/i);
      expect(result.transport).not.toHaveBeenCalled();
      expect(existsSync(result.outDir)).toBe(false);
    }
  });

  it('refuses to run in CI', async () => {
    const { paths, outDir } = liveHome(liveConfig());
    const transport = syntheticLive();
    const errors: string[] = [];
    const code = await record({
      paths,
      fetch: transport,
      outDir,
      now: () => NOW,
      env: { CI: 'true' },
      writeErr: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join('')).toContain('CI');
    expect(transport).not.toHaveBeenCalled();
  });

  it('scrubs live names into stand names', async () => {
    const result = await run();
    expect(result.errors).toBe('');
    expect(result.code).toBe(0);
    for (const text of result.texts()) {
      for (const word of LIVE_WORDS) expect(text.toLowerCase()).not.toContain(word);
      expect(text).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(text.toLowerCase()).not.toContain('authorization');
      expect(text).not.toContain('customfield_12345');
    }

    const board = exchanges(result.read('github:stand:stand-org/board'));
    const [batch, details] = board;
    expect(batch?.request.body?.['variables']).toEqual({ owner: 'stand-org', repo: 'board' });
    const pr = (details?.response.body as { data: { pr0: { pullRequest: Raw } } }).data.pr0
      .pullRequest;
    expect(pr['author']).toEqual({ login: 'stand-agent' });
    expect(pr['url']).toBe('https://github.com/stand-org/board/pull/7');
    expect(pr['title']).toMatch(/^Recorded title \d+$/);
    expect(pr['headRefName']).toMatch(/^recorded-branch-\d+$/);
    expect(pr['closingIssuesReferences']).toMatchObject({
      nodes: [
        { repository: { nameWithOwner: 'stand-org/board' } },
        {
          repository: {
            nameWithOwner: expect.stringMatching(/^recorded-org\/recorded-repo-\d+$/) as unknown,
          },
        },
      ],
    });
    const service = exchanges(result.read('github:stand-jira:stand-org/service'));
    expect(service[0]?.request.body?.['variables']).toEqual({
      owner: 'stand-org',
      repo: 'service',
    });

    const [issues] = exchanges(result.read('github-issues:stand:stand-org/board'));
    expect(issues?.request.url).toBe(
      'https://api.github.com/repos/stand-org/board/issues?state=open&per_page=100',
    );
    expect(issues?.request.headers).not.toHaveProperty('authorization');
    const [issue] = issues?.response.body as Raw[];
    expect(issue).toMatchObject({
      html_url: 'https://github.com/stand-org/board/issues/3',
      assignee: { login: 'stand-agent' },
      labels: [{ name: expect.stringMatching(/^label-\d+$/) as unknown }],
      milestone: { title: expect.stringMatching(/^recorded-milestone-\d+$/) as unknown, number: 1 },
    });
    expect(Object.keys(issue ?? {}).sort()).toEqual([
      'assignee',
      'html_url',
      'labels',
      'milestone',
      'node_id',
      'number',
      'state',
      'title',
      'updated_at',
    ]);

    const [spurList] = exchanges(result.read('spur'));
    expect(spurList?.request.url).toBe('http://spur.stand.invalid/sessions');
    expect(spurList?.response.headers['x-spur-lifecycle-instance-id']).toBe('recorded-instance-1');
    const [session] = spurList?.response.body as Raw[];
    expect(session).toMatchObject({
      id: expect.stringMatching(/^recorded-session-\d+$/) as unknown,
      project: expect.stringMatching(/^recorded-project-\d+$/) as unknown,
      slots: {
        links: [
          { label: 'pr', url: 'https://github.com/stand-org/board/pull/7' },
          { label: 'tracker', url: 'https://jira.stand.invalid/browse/STAND-3' },
          {
            label: 'docs',
            url: expect.stringMatching(/^https:\/\/recorded\.invalid\/link-\d+$/) as unknown,
          },
        ],
      },
    });
    // The branch the session and the PR share keeps one placeholder.
    expect(session?.['branch']).toBe(pr['headRefName']);

    const jira = result.read('jira:stand-jira');
    expect(jira['tracker']).toEqual({ doneStatuses: ['Shipped'], readyStatuses: ['Queued'] });
    const [statuses, fields, search] = exchanges(jira);
    expect(statuses?.request.url).toBe(
      'https://jira.stand.invalid/rest/api/3/project/STAND/statuses',
    );
    expect(search?.request.headers).not.toHaveProperty('authorization');
    expect(search?.request.body).toMatchObject({
      jql: 'project = STAND',
      fields: ['summary', 'status', 'assignee', 'labels', 'updated', 'customfield_10020'],
    });
    expect((fields?.response.body as Raw[]).map((field) => field['id'])).toEqual([
      'summary',
      'status',
      'assignee',
      'labels',
      'updated',
      'customfield_10020',
    ]);
    const [ticket] = (search?.response.body as { issues: Raw[] }).issues;
    expect(ticket?.['id']).toMatch(/^99\d{5}$/);
    expect(ticket).toMatchObject({
      key: 'STAND-3',
      self: `https://jira.stand.invalid/rest/api/3/issue/${String(ticket?.['id'])}`,
      fields: {
        assignee: {
          accountId: expect.stringMatching(/^recorded-account-\d+$/) as unknown,
          displayName: expect.stringMatching(/^recorded-user-\d+$/) as unknown,
        },
        customfield_10020: [
          { name: expect.stringMatching(/^Recorded sprint \d+$/) as unknown, state: 'active' },
        ],
      },
    });
  });

  it('keeps URL shape', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    const urls = Object.keys(RECORDING_FILES).flatMap((source) =>
      stringsAt(result.read(source), new Set(['url', 'html_url', 'self'])),
    );
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) expect(new URL(url).protocol).toMatch(/^https?:$/);
  });

  it('is deterministic', async () => {
    const first = await run();
    const second = await run();
    expect(first.code).toBe(0);
    expect(second.texts()).toEqual(first.texts());
  });

  it('never opens the board store', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(readdirSync(result.home).sort()).toEqual(['config.yaml', 'secrets.env']);
  });

  it('refuses output that still holds a live value', async () => {
    const fixture = { ...defaultFixture(), statuses: ['Queued', 'Shipped', 'Acme-Real review'] };
    const result = await run(liveConfig(), fixture);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('jira/stand-jira.json');
    expect(result.errors).toContain('exchanges[0].response.body[0].statuses[2].name');
    expect(result.errors).toContain('rule 2');
    expect(result.errors).not.toMatch(/acme/i);
    expect(existsSync(result.outDir)).toBe(false);
  });

  it('masks a live name in a refused error-response key', async () => {
    const fixture = { ...defaultFixture(), probeBody: { 'acme-real-hint': 'Session not found' } };
    const result = await run(liveConfig(), fixture);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('rule 1 or 2 (key)');
    expect(result.errors).toContain('<live>');
    expect(result.errors).not.toMatch(/acme/i);
    expect(existsSync(result.outDir)).toBe(false);
  });

  it('replaces live node ids, commit SHAs and Jira ids with synthetic ones', async () => {
    const fixture = { ...defaultFixture(), issueNodeId: `I_${BOARD}` };
    const result = await run(liveConfig(), fixture);
    expect(result.errors).toBe('');
    expect(result.code).toBe(0);
    for (const text of result.texts())
      for (const live of ['kwDOfixture', 'a'.repeat(40), 'I_acme', '20001'])
        expect(text).not.toContain(live);

    const [, details] = exchanges(result.read('github:stand:stand-org/board'));
    const pr = (details?.response.body as { data: { pr0: { pullRequest: Raw } } }).data.pr0
      .pullRequest;
    const sha = /^0{30}\d{10}$/;
    expect(pr['id']).toMatch(/^recorded-node-\d+$/);
    expect(pr['headRefOid']).toMatch(sha);
    const [review] = (pr['reviews'] as { nodes: Raw[] }).nodes;
    const [comment] = (pr['comments'] as { nodes: Raw[] }).nodes;
    expect(review?.['id']).toMatch(/^recorded-node-\d+$/);
    expect(comment?.['id']).toMatch(/^recorded-node-\d+$/);
    expect(new Set([pr['id'], review?.['id'], comment?.['id']]).size).toBe(3);
    // The same live value keeps one placeholder: the review's commit is the head commit, and the
    // PR's node id in the Issues listing is the one GraphQL answered.
    expect(review?.['commit']).toEqual({ oid: pr['headRefOid'] });
    const [issues] = exchanges(result.read('github-issues:stand:stand-org/board'));
    const [issue, prItem] = issues?.response.body as Raw[];
    expect(issue?.['node_id']).toMatch(/^recorded-node-\d+$/);
    expect(prItem?.['node_id']).toBe(pr['id']);

    const [statuses] = exchanges(result.read('jira:stand-jira'));
    const [type] = statuses?.response.body as { id: string; statuses: { id: string }[] }[];
    for (const id of [type?.id, ...(type?.statuses ?? []).map((status) => status.id)])
      expect(id).toMatch(/^99\d{5}$/);
  });

  it('refuses a live id or commit SHA where only a synthetic one may stand', () => {
    const needles = needlesOf(configSchema.parse(liveConfig()), SECRETS);
    const body = (node: Raw) => ({
      exchanges: [{ response: { body: { data: { pr0: { pullRequest: node } } } } }],
    });
    const at = '$.exchanges[0].response.body.data.pr0.pullRequest';
    const shape = 'rule 4 (shape)';
    expect(scan(body({ id: 'PR_kwDOlive' }), needles, 'github-pr')).toEqual({
      path: `${at}.id`,
      rule: shape,
    });
    expect(scan(body({ headRefOid: 'b'.repeat(40) }), needles, 'github-pr')).toEqual({
      path: `${at}.headRefOid`,
      rule: shape,
    });
    expect(scan(body({ sha: 'c'.repeat(40) }), needles, 'github-pr')).toEqual({
      path: `${at}.sha`,
      rule: shape,
    });
    expect(scan({ body: [{ node_id: 'I_kwDOlive' }] }, needles, 'github-issues')).toEqual({
      path: '$.body[0].node_id',
      rule: shape,
    });
    expect(scan({ issues: [{ id: '20001' }] }, needles, 'jira')).toEqual({
      path: '$.issues[0].id',
      rule: shape,
    });
    expect(
      scan(
        { issues: [{ self: 'https://jira.stand.invalid/rest/api/3/issue/20001' }] },
        needles,
        'jira',
      ),
    ).toEqual({ path: '$.issues[0].self', rule: shape });
    expect(
      scan(
        body({ id: 'recorded-node-1', headRefOid: '1'.padStart(40, '0') }),
        needles,
        'github-pr',
      ),
    ).toBeUndefined();
  });

  it('refuses a secret inside the GraphQL query text', () => {
    const needles = needlesOf(configSchema.parse(liveConfig()), SECRETS);
    const recording = {
      exchanges: [
        { request: { body: { query: `query PrBatch { a(token: "${SECRETS.GITHUB_TOKEN}") }` } } },
      ],
    };
    expect(scan(recording, needles, 'github-pr')).toEqual({
      path: '$.exchanges[0].request.body.query',
      rule: 'rule 1 (substring)',
    });
  });

  it('does not refuse short live names inside fixed wire strings', async () => {
    const fixture = {
      ...defaultFixture(),
      spurLinks: [{ label: 'tracker', url: `${JIRA}/browse/ACMEX-3` }],
    };
    const result = await run(liveConfig(['oid', 'pr']), fixture);
    expect(result.errors).toBe('');
    expect(result.code).toBe(0);
    const text = result.texts().join('\n');
    expect(text).toContain('commit { oid }');
    expect(text).toContain('"oid"');
    expect(text).toContain('"pr0"');
  });

  it('refuses a short live name as a whole kept value', async () => {
    const fixture = { ...defaultFixture(), statuses: ['Queued', 'Shipped', 'OID'] };
    const result = await run(liveConfig(['oid', 'acme-dev']), fixture);
    expect(result.code).toBe(1);
    expect(result.errors).toContain('exchanges[0].response.body[0].statuses[2].name');
    expect(result.errors).toContain('rule 3');
    expect(existsSync(result.outDir)).toBe(false);
  });
});
