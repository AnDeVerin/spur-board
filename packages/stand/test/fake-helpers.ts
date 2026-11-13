import { configSchema, type Adapter, type Batch, type PollContext } from '@spur-board/contracts';
import { githubSources } from '../../adapters/src/github/index.ts';
import { createFakes, type Fakes } from '../src/fakes/fetch.ts';
import { createGithubIssuesFake } from '../src/fakes/github-issues.ts';
import { createGithubPrFake } from '../src/fakes/github-pr.ts';
import { standConfig } from '../src/stand.ts';

export const NOW = Date.parse('2026-01-02T00:00:00.000Z');
export const BOARD = 'stand-org/board';
export const SERVICE = 'stand-org/service';
export const GRAPHQL = 'https://api.github.com/graphql';

export function githubFakes(now: () => number = () => NOW): Fakes {
  return createFakes({
    now,
    modules: [(clock) => createGithubPrFake({ now: clock, repos: [BOARD, SERVICE] })],
  });
}

/** Both GitHub fakes, in the stand's order. */
export function issueFakes(now: () => number = () => NOW): Fakes {
  return createFakes({
    now,
    modules: [
      (clock) => createGithubPrFake({ now: clock, repos: [BOARD, SERVICE] }),
      (clock) => createGithubIssuesFake({ now: clock, repos: [BOARD, SERVICE] }),
    ],
  });
}

/** Sends one issue verb (`open`, `close`, `label`, `milestone`) and returns the result. */
export function issue(
  fakes: Fakes,
  number: number,
  verb: string,
  extra: Record<string, unknown> = {},
  repo = BOARD,
) {
  return fakes.control({
    system: 'github',
    verb: `issue-${verb}`,
    args: { repo, number, ...extra },
  });
}

/** The fetch under test; a request no fake claims is a test bug. */
export function fakeFetch(fakes: Fakes): typeof fetch {
  return fakes.wrap(() => Promise.reject(new Error('The request reached the fallback.')));
}

/** A POST of a GraphQL document, as the adapter's client sends it. */
export function postQuery(
  fetcher: typeof fetch,
  query: string,
  variables: Record<string, unknown> = { owner: 'stand-org', repo: 'board' },
  init: RequestInit = {},
): Promise<Response> {
  return fetcher(GRAPHQL, { method: 'POST', body: JSON.stringify({ query, variables }), ...init });
}

export function pollContext(overrides: Partial<PollContext> = {}): PollContext {
  return {
    observe: { prs: [], tickets: [], sessions: [] },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** The real GitHub adapter for `repo` under the stand's own config, to poll more than once. */
export function repoSource(
  fakes: Fakes,
  repo: string,
  now: () => number = () => NOW,
  fetcher: typeof fetch = fakeFetch(fakes),
): Adapter {
  const config = configSchema.parse(standConfig(0));
  const source = githubSources(config, { token: 'dummy', now, fetch: fetcher }).find(
    (candidate) => candidate.repo === repo,
  );
  if (source === undefined) throw new Error(`No source for ${repo}`);
  return source.adapter;
}

/** Polls `repo` once through a fresh adapter, so nothing carries over from an earlier poll. */
export function pollRepo(
  fakes: Fakes,
  repo: string,
  context: PollContext = pollContext(),
  now: () => number = () => NOW,
): Promise<Batch> {
  return repoSource(fakes, repo, now).poll(context);
}

/** Sends one pull request verb and returns the result. */
export function pr(
  fakes: Fakes,
  number: number,
  verb: string,
  extra: Record<string, unknown> = {},
  repo = BOARD,
) {
  return fakes.control({ system: 'github', verb, args: { repo, number, ...extra } });
}

export function violations(fakes: Fakes): readonly { reason: string }[] {
  return fakes.violations().items;
}
