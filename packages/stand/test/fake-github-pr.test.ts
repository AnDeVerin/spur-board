import { sourceCursorSchema, type PrFacts } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as client from '../../adapters/src/github/client.ts';
import { detailQuery, initialQuery, pageQuery } from '../../adapters/src/github/client.ts';
import type { Fakes } from '../src/fakes/fetch.ts';
import { isKnownShape } from '../src/fakes/github-pr.ts';
import {
  BOARD,
  fakeFetch,
  githubFakes,
  GRAPHQL,
  NOW,
  pollContext,
  pollRepo,
  postQuery,
  pr,
  SERVICE,
  violations,
} from './fake-helpers.ts';

const SHA = 'a'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const CONNECTIONS = {
  pullRequests: true,
  reviews: true,
  reviewThreads: true,
  reviewRequests: true,
  contexts: true,
  closingIssuesReferences: true,
  comments: true,
} satisfies Record<Parameters<typeof pageQuery>[0], true>;
const FIELDS = Object.keys(CONNECTIONS) as (keyof typeof CONNECTIONS)[];

let fakes: Fakes;

beforeEach(() => {
  fakes = githubFakes();
});

afterEach(() => {
  expect(violations(fakes)).toEqual([]);
});

function factsOf(batch: { items: readonly unknown[] }, number: number): PrFacts {
  const items = batch.items as { kind: string; facts: PrFacts }[];
  const item = items.find(({ kind, facts }) => kind === 'pr' && facts.number === number);
  if (item === undefined) throw new Error(`PR ${String(number)} was not delivered`);
  return item.facts;
}

function created(number: number, seed: Record<string, unknown> = {}, repo = BOARD): void {
  expect(pr(fakes, number, 'create', { seed }, repo).status).toBe(200);
}

describe('adapter queries', () => {
  const booleans = [false, true];
  const numberSets = [[1], [7, 8, 9]];

  it('exports only the builders this file walks', () => {
    expect(
      Object.keys(client)
        .filter((name) => name.endsWith('Query'))
        .sort(),
    ).toEqual(['detailQuery', 'initialQuery', 'pageQuery']);
  });

  it.each(booleans.flatMap((bootstrap) => booleans.map((closing) => [bootstrap, closing])))(
    'knows PrBatch for bootstrap %s, closing %s',
    (bootstrap, closing) => {
      for (const numbers of [[], ...numberSets])
        expect(isKnownShape(initialQuery(numbers, bootstrap, closing))).toBe(true);
    },
  );

  it.each(booleans)('knows PrDetails for closing %s', (closing) => {
    for (const numbers of numberSets)
      expect(isKnownShape(detailQuery(numbers, closing))).toBe(true);
  });

  it.each(FIELDS.flatMap((field) => booleans.map((bootstrap) => [field, bootstrap] as const)))(
    'knows the %s page for bootstrap %s',
    (field, bootstrap) => {
      expect(isKnownShape(pageQuery(field, bootstrap))).toBe(true);
    },
  );
});

describe('matching', () => {
  const batch = initialQuery([1, 2]);
  const page = pageQuery('reviews');
  const pageVars = { owner: 'stand-org', repo: 'board', number: 1, after: 'fake:reviews:1' };

  it.each<[string, string, Record<string, unknown>?]>([
    ['unknown field', batch.replace('isDraft', 'isDraft locked')],
    ['dropped field', batch.replaceAll(' isDraft', '')],
    ['changed argument', batch.replaceAll('reviews(first: 100)', 'reviews(first: 50)')],
    ['missing variable', batch, { owner: 'stand-org' }],
    ['extra variable', batch, { owner: 'stand-org', repo: 'board', extra: 'x' }],
    ['wrongly typed variable', batch, { owner: 'stand-org', repo: 7 }],
    ['unknown repo', batch, { owner: 'stand-org', repo: 'other' }],
    ['unknown cursor', page, { ...pageVars, after: 'nope' }],
    ['cursor of another connection', page, { ...pageVars, after: 'fake:reviewThreads:1' }],
    ['non-contiguous alias', batch.replace('pr1:', 'pr2:')],
    [
      'mismatched isRequired number',
      batch.replace('isRequired(pullRequestNumber: 2)', 'isRequired(pullRequestNumber: 3)'),
    ],
    ['directive on a field', batch.replaceAll(' isDraft', ' isDraft @skip(if: true)')],
    [
      'directive on a field with arguments',
      batch.replaceAll('reviews(first: 100)', 'reviews(first: 100) @include(if: false)'),
    ],
    [
      'directive on an aliased root',
      batch.replace(/pr\d: repository\([^)]*\)/g, '$& @include(if: true)'),
    ],
    [
      'directive on an inline fragment',
      batch.replaceAll('... on CheckRun', '... on CheckRun @skip(if: false)'),
    ],
    ['directive on the operation', batch.replace('$repo: String!)', '$repo: String!) @live')],
    ['directive on a variable', batch.replace('$repo: String!', '$repo: String! @deprecated')],
    ['variable default', batch.replace('$repo: String!', '$repo: String! = "x"')],
    ['syntax error', 'query {'],
  ])('logs one violation and refuses: %s', async (_name, query, variables) => {
    created(1, {
      reviews: [
        {
          author: { __typename: 'User', login: 'r' },
          state: 'APPROVED',
          commit: { oid: SHA },
          submittedAt: AT,
        },
      ],
    });
    const response = await postQuery(fakeFetch(fakes), query, variables);
    expect(response.ok).toBe(false);
    expect(violations(fakes)).toHaveLength(1);
    fakes.reset();
  });

  it('logs one violation and refuses a non-POST', async () => {
    const response = await fakeFetch(fakes)(GRAPHQL, { method: 'GET' });
    expect(response.ok).toBe(false);
    expect(violations(fakes)).toHaveLength(1);
    fakes.reset();
  });

  it('accepts selections and arguments in another order', async () => {
    const reordered = initialQuery([1])
      .replace('id number url', 'url number id')
      .replaceAll('(owner: $owner, name: $repo)', '(name: $repo, owner: $owner)')
      .replace('$owner: String!, $repo: String!', '$repo: String!, $owner: String!')
      .replace(
        'first: 100, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}',
        'orderBy: {direction: DESC, field: UPDATED_AT}, states: [OPEN, MERGED], first: 100',
      );
    expect(reordered).not.toBe(initialQuery([1]));
    const response = await postQuery(fakeFetch(fakes), reordered);
    expect(response.status).toBe(200);
  });
});

describe('wire facts', () => {
  it('reaches PrFacts with seeded state through the real adapter', async () => {
    created(5, {
      title: 'feat: #12 seeded',
      isDraft: true,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      headRefName: 'claude-12-seeded',
      headRefOid: SHA,
      contexts: [
        {
          __typename: 'CheckRun',
          name: 'required-run',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: AT,
          completedAt: AT,
          checkSuite: { createdAt: AT },
          isRequired: true,
        },
        {
          __typename: 'CheckRun',
          name: 'optional-run',
          status: 'QUEUED',
          conclusion: null,
          startedAt: null,
          completedAt: null,
          checkSuite: null,
          isRequired: false,
        },
        {
          __typename: 'StatusContext',
          context: 'required-status',
          state: 'FAILURE',
          createdAt: AT,
          isRequired: true,
        },
        {
          __typename: 'StatusContext',
          context: 'optional-status',
          state: 'SUCCESS',
          createdAt: AT,
          isRequired: false,
        },
      ],
      reviews: [
        {
          author: { __typename: 'User', login: 'alice' },
          state: 'CHANGES_REQUESTED',
          commit: { oid: SHA },
          submittedAt: AT,
        },
      ],
      reviewThreads: [{ isResolved: true }, { isResolved: false }],
      reviewRequests: [
        { requestedReviewer: { __typename: 'User', login: 'u' }, asCodeOwner: false },
        { requestedReviewer: { __typename: 'Mannequin', login: 'm' }, asCodeOwner: false },
        { requestedReviewer: { __typename: 'Bot', login: 'b' }, asCodeOwner: true },
        { requestedReviewer: { __typename: 'Team', slug: 't' }, asCodeOwner: true },
        { requestedReviewer: { __typename: 'EnterpriseTeam', slug: 'e' }, asCodeOwner: false },
        { requestedReviewer: null, asCodeOwner: false },
      ],
      closingIssuesReferences: [{ number: 44, repository: { nameWithOwner: BOARD } }],
    });
    const batch = await pollRepo(fakes, BOARD);
    expect(batch.complete).toBe(true);
    expect(factsOf(batch, 5)).toMatchObject({
      repo: BOARD,
      title: 'feat: #12 seeded',
      author: 'stand-agent',
      headSha: SHA,
      headBranch: 'claude-12-seeded',
      state: 'open',
      draft: true,
      mergeable: 'conflicting',
      mergeState: 'dirty',
      checks: [
        { name: 'optional-run', state: 'pending', completedAt: null },
        { name: 'optional-status', state: 'success', completedAt: null },
        { name: 'required-run', state: 'success', completedAt: AT },
        { name: 'required-status', state: 'failure', completedAt: null },
      ],
      requiredChecks: [
        { name: 'required-run', state: 'success', completedAt: AT },
        { name: 'required-status', state: 'failure', completedAt: null },
      ],
      reviews: [{ reviewer: 'alice', state: 'changes_requested', commitSha: SHA, submittedAt: AT }],
      reviewThreads: [{ resolved: true }, { resolved: false }],
      reviewRequests: [
        { kind: 'user', id: 'u', asCodeOwner: false },
        { kind: 'user', id: 'm', asCodeOwner: false },
        { kind: 'bot', id: 'b', asCodeOwner: true },
        { kind: 'team', id: 't', asCodeOwner: true },
        { kind: 'team', id: 'e', asCodeOwner: false },
      ],
      ticketKeys: [`${BOARD}#44`],
    });
  });

  it('reports a merged PR once the cursor is past bootstrap', async () => {
    created(6, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
    const cursor = sourceCursorSchema.parse('2025-01-01T00:00:00.000Z');
    const batch = await pollRepo(fakes, BOARD, pollContext({ cursor }));
    expect(factsOf(batch, 6)).toMatchObject({
      state: 'merged',
      mergeable: 'unknown',
      mergeState: 'unknown',
      mergedAt: new Date(NOW).toISOString(),
    });
  });

  it('answers a missing aliased PR with null and a NOT_FOUND error at its path', async () => {
    const response = await postQuery(fakeFetch(fakes), initialQuery([999]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Record<string, unknown>;
      errors: { type: string; path: unknown[] }[];
    };
    expect(body.data['pr0']).toEqual({ pullRequest: null });
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ type: 'NOT_FOUND', path: ['pr0', 'pullRequest'] });
  });

  it('turns a missing PR into not_found, keeps the batch complete and delivers its sibling', async () => {
    created(1);
    const missing = { kind: 'pr' as const, repo: BOARD, number: 999 };
    const sibling = { kind: 'pr' as const, repo: BOARD, number: 1 };
    const batch = await pollRepo(
      fakes,
      BOARD,
      pollContext({ observe: { prs: [missing, sibling], tickets: [], sessions: [] } }),
    );
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([
      { ref: missing, status: 'not_found' },
      { ref: sibling, status: 'ok' },
    ]);
    expect(factsOf(batch, 1).number).toBe(1);
  });

  it('answers null closing references', async () => {
    created(1, { headRefName: 'no-link', closingIssuesReferences: null });
    const batch = await pollRepo(fakes, BOARD);
    expect(batch.complete).toBe(true);
    expect(factsOf(batch, 1).ticketKeys).toEqual([]);
  });

  it('answers null closing nodes with a non-null pageInfo and keeps seeded casing', async () => {
    created(1, {
      closingIssuesReferences: [
        null,
        { number: 7, repository: { nameWithOwner: 'Stand-Org/Board' } },
      ],
    });
    const response = await postQuery(fakeFetch(fakes), initialQuery([1], false, true));
    const body = (await response.json()) as {
      data: { pr0: { pullRequest: { closingIssuesReferences: unknown } } };
    };
    expect(body.data.pr0.pullRequest.closingIssuesReferences).toEqual({
      nodes: [null, { number: 7, repository: { nameWithOwner: 'Stand-Org/Board' } }],
      pageInfo: { hasNextPage: false, endCursor: 'fake:closingIssuesReferences:2' },
    });
    const batch = await pollRepo(fakes, BOARD);
    expect(factsOf(batch, 1).ticketKeys).toEqual([`${BOARD}#7`]);
  });

  it('finds a repository under another letter case', async () => {
    created(1);
    const response = await postQuery(fakeFetch(fakes), initialQuery([1]), {
      owner: 'Stand-Org',
      repo: 'BOARD',
    });
    const body = (await response.json()) as { data: { pr0: { pullRequest: unknown } } };
    expect(body.data.pr0.pullRequest).not.toBeNull();
  });
});

describe('pagination', () => {
  const CURSOR = sourceCursorSchema.parse('2025-01-01T00:00:00.000Z');
  const many = <T>(make: (i: number) => T): T[] =>
    Array.from({ length: 101 }, (_, i) => make(i + 1));
  const comment = (i: number) => ({
    author: { __typename: 'User', login: `commenter-${String(i)}` },
    createdAt: new Date(Date.parse(AT) + i * 1000).toISOString(),
  });

  it('reads every connection past its first page through the real adapter', async () => {
    created(1, {
      contexts: many((i) => ({
        __typename: 'StatusContext',
        context: `status-${String(i)}`,
        state: 'SUCCESS',
        createdAt: AT,
        isRequired: false,
      })),
      reviews: many((i) => ({
        author: { __typename: 'User', login: `reviewer-${String(i)}` },
        state: 'APPROVED',
        commit: { oid: SHA },
        submittedAt: AT,
      })),
      reviewThreads: many(() => ({ isResolved: false })),
      reviewRequests: many((i) => ({
        requestedReviewer: { __typename: 'User', login: `asked-${String(i)}` },
        asCodeOwner: false,
      })),
      closingIssuesReferences: many((i) => ({
        number: i,
        repository: { nameWithOwner: BOARD },
      })),
      comments: many(comment),
    });
    const ref = { kind: 'pr' as const, repo: BOARD, number: 1 };
    const batch = await pollRepo(
      fakes,
      BOARD,
      pollContext({ observe: { prs: [ref], tickets: [], sessions: [] } }),
    );
    expect(batch.complete).toBe(true);
    const facts = factsOf(batch, 1);
    expect(facts.checks).toHaveLength(101);
    expect(facts.reviews).toHaveLength(101);
    expect(facts.reviewThreads).toHaveLength(101);
    expect(facts.reviewRequests).toHaveLength(101);
    expect(facts.feedback).toHaveLength(202);
    expect(facts.feedbackComplete).toBe(true);
  });

  it('reads comments back to the cursor through the real adapter', async () => {
    created(1, { comments: Array.from({ length: 250 }, (_, i) => comment(i)) });
    const ref = { kind: 'pr' as const, repo: BOARD, number: 1 };
    const batch = await pollRepo(
      fakes,
      BOARD,
      pollContext({
        observe: { prs: [ref], tickets: [], sessions: [] },
        feedbackCursors: [{ ref, id: 'IC_1_120', postedAt: comment(120).createdAt }],
      }),
    );
    const facts = factsOf(batch, 1);
    expect(facts.feedback?.filter((entry) => entry.kind === 'comment')).toHaveLength(200);
    expect(facts.feedback?.[0]).toMatchObject({ id: 'IC_1_50', author: { type: 'user' } });
    expect(facts.feedbackComplete).toBe(true);
  });

  it.each([
    ['bootstrap', undefined],
    ['a later poll', CURSOR],
  ])('discovers 101 PRs over two pages on %s', async (_name, cursor) => {
    for (let number = 1; number <= 101; number += 1)
      created(number, { updatedAt: new Date(NOW + number).toISOString() }, SERVICE);
    const batch = await pollRepo(fakes, SERVICE, pollContext({ cursor }));
    expect(batch.complete).toBe(true);
    expect(batch.items).toHaveLength(101);
  });

  it.each([
    ['closing, with a cursor', BOARD, CURSOR],
    ['no closing, with a cursor', SERVICE, CURSOR],
    ['no closing, on bootstrap', SERVICE, undefined],
  ])('answers an observed PR in PrBatch: %s', async (_name, repo, cursor) => {
    created(1, {}, repo);
    const ref = { kind: 'pr' as const, repo, number: 1 };
    const batch = await pollRepo(
      fakes,
      repo,
      pollContext({ cursor, observe: { prs: [ref], tickets: [], sessions: [] } }),
    );
    expect(batch.complete).toBe(true);
    expect(batch.entities).toEqual([{ ref, status: 'ok' }]);
    expect(factsOf(batch, 1).repo).toBe(repo);
  });

  it('answers newest first and honours states', async () => {
    created(1, { updatedAt: '2026-01-01T00:00:00.001Z' });
    created(2, { updatedAt: '2026-01-01T00:00:00.003Z', state: 'MERGED' });
    created(3, { updatedAt: '2026-01-01T00:00:00.002Z' });
    const read = async (bootstrap: boolean): Promise<number[]> => {
      const response = await postQuery(fakeFetch(fakes), initialQuery([], bootstrap));
      const body = (await response.json()) as {
        data: { repository: { pullRequests: { nodes: { number: number }[] } } };
      };
      return body.data.repository.pullRequests.nodes.map((node) => node.number);
    };
    expect(await read(false)).toEqual([2, 3, 1]);
    expect(await read(true)).toEqual([3, 1]);
  });
});

describe('updatedAt', () => {
  it('moves strictly forward under a fixed clock and takes a later now as given', () => {
    let now = NOW;
    fakes = githubFakes(() => now);
    const at = (result: { body: unknown }): string =>
      (result.body as { updatedAt: string }).updatedAt;
    const first = at(pr(fakes, 1, 'create'));
    const second = at(pr(fakes, 1, 'ci-green'));
    const third = at(pr(fakes, 1, 'approve'));
    expect(Date.parse(first)).toBe(NOW);
    expect(Date.parse(second)).toBe(NOW + 1);
    expect(Date.parse(third)).toBe(NOW + 2);
    now = NOW + 60_000;
    expect(Date.parse(at(pr(fakes, 1, 'conflict')))).toBe(NOW + 60_000);
  });
});

describe('state and restore', () => {
  it('gives a fresh fake the same pull requests, unaffected by later changes', async () => {
    created(1, { title: 'Seeded' });
    created(2);
    const before = await pollRepo(fakes, BOARD);
    const state = fakes.state();
    expect(pr(fakes, 1, 'merge').status).toBe(200);
    created(3);

    const restored = githubFakes();
    restored.restore(state);
    const after = await pollRepo(restored, BOARD);
    expect(factsOf(after, 1)).toEqual(factsOf(before, 1));
    expect(factsOf(after, 2)).toEqual(factsOf(before, 2));
    expect(after.items.filter(({ kind }) => kind === 'pr')).toHaveLength(2);
    expect(pr(restored, 1, 'merge').status).toBe(200);
    expect(violations(restored)).toEqual([]);
  });
});
