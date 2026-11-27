import { configSchema, sourceCursorSchema } from '@spur-board/contracts';
import { expect, it, vi } from 'vitest';
import { githubSources } from '../../src/github/index.ts';

const repo = 'demo/widgets';
const branch = 'main';
const shas = ['a', 'b', 'c'].map((letter) => letter.repeat(40));
const at = '2026-01-01T00:00:00.000Z';
const check = {
  __typename: 'CheckRun',
  name: 'ci-ok',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  completedAt: at,
  checkSuite: { createdAt: at, workflowRun: { event: 'push', workflow: { id: 'ci' } } },
};
const config = configSchema.parse({
  projects: [
    {
      id: 'demo',
      tracker: { type: 'github-issues', repo, label: 'demo' },
      repos: [repo],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'U123' },
  digest: { tz: 'UTC' },
  github: { reserveRemaining: 0 },
});

type Fault =
  'parentRollup' | 'tipParents' | 'firstParentParents' | 'tipRollup' | 'differentTip' | 'tipSuites';
type TipChecks = 'queuedSuite' | 'scheduledSuite' | 'running' | 'red';

it.each<{ name: string; checked: number; failure?: Fault; tip?: TipChecks; read?: boolean }>([
  { name: 'walk past a release with no suite or checks', checked: 1, read: true },
  { name: 'hold on a queued push suite with no check runs', checked: 1, tip: 'queuedSuite' },
  {
    name: 'walk past a release with only a scheduled suite',
    checked: 1,
    tip: 'scheduledSuite',
    read: true,
  },
  { name: 'hold on a running push check', checked: 1, tip: 'running' },
  { name: 'read a completed red push check', checked: 1, tip: 'red', read: true },
  { name: 'read a completed green push check', checked: 0, read: true },
  {
    name: 'hold when the tip has no checks and its suite list is unreadable',
    checked: 1,
    failure: 'tipSuites',
  },
  {
    name: 'read the tip when its checks settle and only the suite list is unreadable',
    checked: 0,
    failure: 'tipSuites',
    read: true,
  },
  {
    name: 'keep the tip after a rollup error on an older alias',
    checked: 0,
    failure: 'parentRollup',
    read: true,
  },
  {
    name: 'keep the tip after a parents error nulls the history target',
    checked: 0,
    failure: 'tipParents',
    read: true,
  },
  {
    name: 'keep the first parent after its parents error nulls it in a deeper alias',
    checked: 1,
    failure: 'firstParentParents',
    read: true,
  },
  {
    name: 'stop at the tip after its check read fails',
    checked: 0,
    failure: 'tipRollup',
    read: false,
  },
  {
    name: 'stop before a checked grandparent after the first parent read fails',
    checked: 2,
    failure: 'parentRollup',
    read: false,
  },
  {
    name: 'ignore a parent selected from a different tip',
    checked: 1,
    failure: 'differentTip',
    read: false,
  },
])('$name', async ({ checked, failure, tip, read }) => {
  const suite = (event: string) => ({ workflowRun: { event } });
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const tipRuns = {
    running: [{ ...check, status: 'IN_PROGRESS', conclusion: null, completedAt: null }],
    red: [{ ...check, conclusion: 'FAILURE' }],
    queuedSuite: [],
    scheduledSuite: [],
  };
  const commit = (index: number) => ({
    oid: shas[index],
    checkSuites: connection(
      index === 0 && tip !== undefined
        ? [suite(tip === 'scheduledSuite' ? 'schedule' : 'push')]
        : index === checked
          ? [suite('push')]
          : [],
    ),
    statusCheckRollup: {
      contexts: connection(
        index === 0 && tip !== undefined ? tipRuns[tip] : index === checked ? [check] : [],
      ),
    },
  });
  const target = { __typename: 'Commit', ...commit(0) };
  const ancestor = (nodes: unknown[], oid = target.oid) => ({
    target: { oid, parents: { nodes } },
  });
  const responses = {
    tipRollup: {
      fields: {
        defaultBranchRef: { name: branch, target: { ...target, statusCheckRollup: null } },
      },
      path: ['defaultBranchRef', 'target', 'statusCheckRollup'],
    },
    tipSuites: {
      fields: { defaultBranchRef: { name: branch, target: { ...target, checkSuites: null } } },
      path: ['defaultBranchRef', 'target', 'checkSuites'],
    },
    parentRollup: {
      fields: { defaultBranchParent1: ancestor([{ ...commit(1), statusCheckRollup: null }]) },
      path: ['defaultBranchParent1', 'target', 'parents', 'nodes', 0, 'statusCheckRollup'],
    },
    tipParents: {
      fields: { defaultBranchParent1: { target: null } },
      path: ['defaultBranchParent1', 'target', 'parents'],
    },
    firstParentParents: {
      fields: { defaultBranchParent2: ancestor([null]) },
      path: ['defaultBranchParent2', 'target', 'parents', 'nodes', 0, 'parents'],
    },
    differentTip: {
      fields: { defaultBranchParent1: ancestor([commit(1)], 'd'.repeat(40)) },
      path: [],
    },
  };
  const { fields, path } = failure === undefined ? { fields: {}, path: [] } : responses[failure];
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      data: {
        rateLimit: { remaining: 90, resetAt: '2026-01-03T00:00:00.000Z' },
        repository: {
          defaultBranchRef: { name: branch, target },
          defaultBranchParent1: ancestor([commit(1)]),
          defaultBranchParent2: ancestor([{ parents: { nodes: [commit(2)] } }]),
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          ...fields,
        },
      },
      ...(path.length > 0
        ? { errors: [{ message: 'field failed', path: ['repository', ...path] }] }
        : {}),
    }),
  );
  const source = githubSources(config, { token: 'synthetic', fetch, now: () => Date.parse(at) })[0];
  if (source === undefined) throw new Error('Missing GitHub source');
  const batch = await source.adapter.poll({
    observe: { prs: [], tickets: [], sessions: [] },
    cursor: sourceCursorSchema.parse(at),
    signal: new AbortController().signal,
  });
  expect(batch.complete).toBe(true);
  const expected =
    tip === 'red'
      ? { state: 'red', branch, sha: shas[0], check: 'ci-ok', url: null }
      : { state: 'green', branch, sha: shas[checked] };
  expect(batch.defaultBranch).toEqual(read === true ? expected : undefined);
});
