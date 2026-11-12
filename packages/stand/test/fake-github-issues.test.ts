import { configSchema, type Batch, type TicketFacts } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGithubIssuesAdapter } from '../../adapters/src/github/issues.ts';
import type { Fakes } from '../src/fakes/fetch.ts';
import { standConfig } from '../src/stand.ts';
import {
  BOARD,
  fakeFetch,
  issue,
  issueFakes,
  NOW,
  pollContext,
  SERVICE,
  violations,
} from './fake-helpers.ts';

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  authorization: 'Bearer dummy',
  'x-github-api-version': '2022-11-28',
};
const SOURCE = 'github-issues:stand:stand-org/board';

let fakes: Fakes;

beforeEach(() => {
  fakes = issueFakes();
});

afterEach(() => {
  expect(violations(fakes)).toEqual([]);
});

type Filter = { label?: string; milestone?: string };

/** Polls once through the real GitHub Issues adapter; no filter is the stand's own tracker. */
function pollIssues(filter: Filter = {}, tickets: number[] = [], repo = BOARD): Promise<Batch> {
  const config = configSchema.parse(standConfig(0));
  const project = config.projects.find(({ tracker }) => tracker.type === 'github-issues');
  if (project?.tracker.type !== 'github-issues') throw new Error('No GitHub Issues tracker');
  const adapter = createGithubIssuesAdapter({
    id: SOURCE,
    tracker: { ...project.tracker, repo, ...filter },
    token: 'dummy',
    intervalMs: 5_000,
    now: () => NOW,
    fetch: fakeFetch(fakes),
  });
  return adapter.poll(
    pollContext({
      observe: {
        prs: [],
        tickets: tickets.map((number) => ({
          kind: 'ticket',
          trackerId: SOURCE,
          key: `${repo}#${String(number)}`,
        })),
        sessions: [],
      },
    }),
  );
}

function facts(batch: Batch): TicketFacts[] {
  return batch.items.flatMap((item) => (item.kind === 'ticket' ? [item.facts] : []));
}

const keys = (batch: Batch): string[] => facts(batch).map(({ key }) => key);

function ok(result: { status: number; body: unknown }): void {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

function get(path: string, headers: Record<string, string> = HEADERS, method = 'GET') {
  return fakeFetch(fakes)(`${API}${path}`, { method, headers });
}

describe('verbs', () => {
  it('open creates an issue the real adapter lists with its node id, number and title', async () => {
    ok(issue(fakes, 3, 'open', { title: 'Stand task three' }));
    const batch = await pollIssues();
    expect(batch.complete).toBe(true);
    const [only] = facts(batch);
    expect(facts(batch)).toHaveLength(1);
    expect(only).toMatchObject({
      trackerId: SOURCE,
      key: `${BOARD}#3`,
      title: 'Stand task three',
      status: 'open',
      assignee: null,
      sprint: null,
      labels: [],
      inFilter: true,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(only?.id).toMatch(/^I_[0-9a-f]+$/);
  });

  it('open refuses an open issue and reopens a closed one under the same node id', async () => {
    ok(issue(fakes, 3, 'open'));
    const before = facts(await pollIssues())[0]?.id;
    expect(issue(fakes, 3, 'open').status).toBe(409);
    ok(issue(fakes, 3, 'close'));
    ok(issue(fakes, 3, 'open', { title: 'Renamed' }));
    const [reopened] = facts(await pollIssues());
    expect(reopened).toMatchObject({ id: before, title: 'Renamed', status: 'open' });
  });

  it('close drops the issue from the list, and detail answers it as closed', async () => {
    ok(issue(fakes, 3, 'open'));
    ok(issue(fakes, 3, 'label', { labels: ['on-board'] }));
    ok(issue(fakes, 3, 'close'));
    expect(issue(fakes, 3, 'close').status).toBe(409);
    expect(facts(await pollIssues({ label: 'on-board' }))).toEqual([]);
    const batch = await pollIssues({ label: 'on-board' }, [3]);
    expect(batch.entities).toEqual([expect.objectContaining({ status: 'ok' })]);
    // The adapter judges inFilter on detail by label or milestone alone, not by state.
    expect(facts(batch)).toEqual([
      expect.objectContaining({ key: `${BOARD}#3`, status: 'closed', inFilter: true }),
    ]);
  });

  it('label replaces the labels, and the label filter lists only the labelled issues', async () => {
    for (const number of [1, 2, 3]) ok(issue(fakes, number, 'open'));
    ok(issue(fakes, 1, 'label', { labels: ['on-board', 'bug', 'bug'] }));
    ok(issue(fakes, 2, 'label', { labels: ['bug'] }));
    ok(issue(fakes, 3, 'label', { labels: ['on-board'] }));
    ok(issue(fakes, 3, 'label', { labels: [] }));
    const batch = await pollIssues({ label: 'on-board' });
    expect(keys(batch)).toEqual([`${BOARD}#1`]);
    expect(facts(batch)[0]?.labels).toEqual(['on-board', 'bug']);
    expect(keys(await pollIssues())).toEqual([`${BOARD}#3`, `${BOARD}#2`, `${BOARD}#1`]);
  });

  it('milestone sets and clears the sprint, and the milestone filter lists its issues', async () => {
    for (const number of [1, 2, 3]) ok(issue(fakes, number, 'open'));
    ok(issue(fakes, 1, 'milestone', { milestone: 'Sprint 1' }));
    ok(issue(fakes, 2, 'milestone', { milestone: 'Sprint 2' }));
    ok(issue(fakes, 3, 'milestone', { milestone: 'Sprint 2' }));
    ok(issue(fakes, 3, 'milestone', { milestone: null }));
    const batch = await pollIssues({ milestone: 'Sprint 2' });
    expect(facts(batch)).toEqual([
      expect.objectContaining({ key: `${BOARD}#2`, sprint: 'Sprint 2' }),
    ]);
    await expect(pollIssues({ milestone: 'Sprint 9' })).rejects.toMatchObject({ kind: 'config' });
  });

  it('refuses a verb on a missing issue, an unknown repo and bad arguments', () => {
    expect(issue(fakes, 9, 'close').status).toBe(404);
    expect(issue(fakes, 9, 'label', { labels: ['x'] }).status).toBe(404);
    expect(issue(fakes, 1, 'open', {}, 'stand-org/other').status).toBe(400);
    expect(issue(fakes, 1, 'open', { extra: true }).status).toBe(400);
    expect(issue(fakes, 1, 'label', { labels: [''] }).status).toBe(400);
  });

  it('moves updatedAt strictly forward under a fixed clock', () => {
    const at = (result: { body: unknown }): number =>
      Date.parse((result.body as { updatedAt: string }).updatedAt);
    expect(at(issue(fakes, 1, 'open'))).toBe(NOW);
    expect(at(issue(fakes, 1, 'label', { labels: ['a'] }))).toBe(NOW + 1);
    expect(at(issue(fakes, 1, 'close'))).toBe(NOW + 2);
  });

  it('keeps each repository apart, and reset clears every issue', async () => {
    ok(issue(fakes, 1, 'open', {}, SERVICE));
    expect(facts(await pollIssues())).toEqual([]);
    expect(keys(await pollIssues({}, [], SERVICE))).toEqual([`${SERVICE}#1`]);
    fakes.reset();
    expect(facts(await pollIssues({}, [], SERVICE))).toEqual([]);
  });
});

describe('detail', () => {
  it('answers a missing observed issue with 404, which the adapter turns into not_found', async () => {
    ok(issue(fakes, 1, 'open'));
    const batch = await pollIssues({}, [1, 404]);
    expect(batch.complete).toBe(true);
    expect(batch.entities.map(({ status }) => status)).toEqual(['ok', 'not_found']);
  });
});

describe('pagination', () => {
  it('serves page two of 101 issues at /repositories/<id>, which the adapter checks', async () => {
    for (let number = 1; number <= 101; number += 1) ok(issue(fakes, number, 'open'));
    const first = await get('/repos/stand-org/board/issues?state=open&per_page=100');
    expect(((await first.json()) as unknown[]).length).toBe(100);
    const link = first.headers.get('link') ?? '';
    const next = /<([^>]+)>; rel="next"/.exec(link)?.[1] ?? '';
    const repo = (await (await get('/repos/stand-org/board')).json()) as { id: number };
    expect(new URL(next).pathname).toBe(`/repositories/${String(repo.id)}/issues`);
    expect(link).toContain('rel="last"');

    const batch = await pollIssues();
    expect(batch.complete).toBe(true);
    expect(facts(batch)).toHaveLength(101);
  });

  it('pages 101 milestones and finds the last one', async () => {
    for (let number = 1; number <= 101; number += 1) {
      ok(issue(fakes, number, 'open'));
      ok(issue(fakes, number, 'milestone', { milestone: `Sprint ${String(number)}` }));
    }
    const batch = await pollIssues({ milestone: 'Sprint 101' });
    expect(keys(batch)).toEqual([`${BOARD}#101`]);
  });
});

describe('matching', () => {
  const ISSUES = '/repos/stand-org/board/issues';

  it.each<[string, string, Record<string, string>?, string?]>([
    ['unknown path', '/user'],
    ['unknown repo path', '/repos/stand-org/board/pulls'],
    ['trailing slash', `${ISSUES}/`],
    ['unknown repository', '/repos/stand-org/other/issues?state=open&per_page=100'],
    ['unknown repository id', '/repositories/1/issues?state=open&per_page=100'],
    ['unknown query parameter', `${ISSUES}?state=open&per_page=100&sort=updated`],
    ['missing per_page', `${ISSUES}?state=open`],
    ['other state', `${ISSUES}?state=all&per_page=100`],
    ['repeated parameter', `${ISSUES}?state=open&state=open&per_page=100`],
    ['bad page', `${ISSUES}?state=open&per_page=100&page=0`],
    ['unknown milestone number', `${ISSUES}?state=open&per_page=100&milestone=7`],
    ['milestones without state=all', '/repos/stand-org/board/milestones?per_page=100'],
    ['query on the repo lookup', '/repos/stand-org/board?x=1'],
    ['inherited key on the repo lookup', '/repos/stand-org/board?constructor=x'],
    ['inherited key on the list', `${ISSUES}?state=open&per_page=100&toString=x`],
    ['query on the detail', `${ISSUES}/1?x=1`],
    ['GraphQL path with a query', '/graphql?x=1'],
    ['missing accept', ISSUES, { authorization: 'Bearer dummy' }],
    ['missing authorization', `${ISSUES}/1`, { ...HEADERS, authorization: '' }],
    ['POST', `${ISSUES}?state=open&per_page=100`, HEADERS, 'POST'],
  ])('logs one violation and refuses: %s', async (_name, path, headers, method) => {
    const response = await get(path, headers, method);
    expect(response.status).toBe(400);
    expect(violations(fakes)).toHaveLength(1);
    fakes.reset();
  });

  it('a mismatched adapter request fails the poll and is logged', async () => {
    fakes = issueFakes();
    const adapter = createGithubIssuesAdapter({
      id: SOURCE,
      tracker: { type: 'github-issues', repo: 'stand-org/unknown' },
      token: 'dummy',
      intervalMs: 5_000,
      now: () => NOW,
      fetch: fakeFetch(fakes),
    });
    const batch = await adapter.poll(pollContext());
    expect(batch.complete).toBe(false);
    expect(violations(fakes)).toEqual([
      expect.objectContaining({ reason: 'Unknown repository stand-org/unknown.' }),
    ]);
    fakes.reset();
  });
});

describe('state and restore', () => {
  it('gives a fresh fake the same issues and milestones, unaffected by later changes', async () => {
    ok(issue(fakes, 1, 'open', { title: 'Seeded' }));
    ok(issue(fakes, 2, 'open'));
    ok(issue(fakes, 2, 'milestone', { milestone: 'Sprint 1' }));
    const before = facts(await pollIssues());
    const state = fakes.state();
    ok(issue(fakes, 1, 'close'));
    ok(issue(fakes, 3, 'open'));

    fakes = issueFakes();
    fakes.restore(state);
    expect(facts(await pollIssues())).toEqual(before);
    expect(issue(fakes, 1, 'open').status).toBe(409);
  });
});
