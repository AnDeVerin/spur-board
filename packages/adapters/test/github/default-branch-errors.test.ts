import { configSchema, sourceCursorSchema } from '@spur-board/contracts';
import { expect, it, vi } from 'vitest';
import { githubSources } from '../../src/github/index.ts';

const branch = 'main';
const shas = ['a', 'b', 'c'].map((letter) => letter.repeat(40));
const check = {
  __typename: 'StatusContext',
  context: 'build',
  state: 'SUCCESS',
  createdAt: '2026-01-01T00:00:00.000Z',
  targetUrl: null,
};
const config = configSchema.parse({
  projects: [
    {
      id: 'demo',
      tracker: {
        type: 'jira',
        baseUrl: 'https://jira.example.test',
        jql: 'project = DEMO',
        doneStatuses: ['Done'],
        readyStatuses: ['Ready'],
      },
      repos: ['demo/widgets'],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'U123' },
  digest: { tz: 'UTC' },
  github: { reserveRemaining: 0 },
});

it.each([
  { name: 'keep the tip before an unreadable parent', checked: 0, depth: 1, read: true },
  {
    name: 'keep the tip when its parents cannot be read',
    checked: 0,
    depth: 0,
    read: true,
    field: 'parents',
  },
  {
    name: 'keep the first parent before an unreadable grandparent',
    checked: 1,
    depth: 2,
    read: true,
  },
  { name: 'stop at an unreadable tip', checked: 0, depth: 0, read: false },
  { name: 'stop at an unreadable first parent', checked: 1, depth: 1, read: false },
  { name: 'stop before a checked grandparent', checked: 2, depth: 1, read: false },
])('$name', async ({ checked, depth, read, field = 'statusCheckRollup' }) => {
  const commit = (index: number) => ({
    oid: shas[index],
    statusCheckRollup: {
      contexts: { nodes: index === checked ? [check] : [], pageInfo: { hasNextPage: false } },
    },
  });
  const firstParent = { ...commit(1), parents: { nodes: [commit(2)] } };
  const target = {
    __typename: 'Commit',
    ...commit(0),
    parents: field === 'parents' ? null : { nodes: [firstParent] },
  };
  const prefix = ['repository', 'defaultBranchRef', 'target'];
  const firstParents = Array.from({ length: depth }, () => ['parents', 'nodes', 0]).flat();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      data: {
        rateLimit: { remaining: 90, resetAt: '2026-01-03T00:00:00.000Z' },
        repository: {
          defaultBranchRef: { name: branch, target },
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
      errors: [{ message: 'field failed', path: [...prefix, ...firstParents, field] }],
    }),
  );
  const source = githubSources(config, {
    token: 'synthetic',
    fetch,
    now: () => Date.parse(check.createdAt),
  })[0];
  if (source === undefined) throw new Error('Missing GitHub source');
  const batch = await source.adapter.poll({
    observe: { prs: [], tickets: [], sessions: [] },
    cursor: sourceCursorSchema.parse(check.createdAt),
    signal: new AbortController().signal,
  });
  expect(batch.complete).toBe(true);
  expect(batch.defaultBranch).toEqual(
    read ? { state: 'green', branch, sha: shas[checked] } : undefined,
  );
});
