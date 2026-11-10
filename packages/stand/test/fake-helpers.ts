import { configSchema, type Batch, type PollContext } from '@spur-board/contracts';
import { githubSources } from '../../adapters/src/github/index.ts';
import { createFakes, type Fakes } from '../src/fakes/fetch.ts';
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

/** Polls `repo` once through the real GitHub adapter and the stand's own config. */
export function pollRepo(
  fakes: Fakes,
  repo: string,
  context: PollContext = pollContext(),
  now: () => number = () => NOW,
): Promise<Batch> {
  const config = configSchema.parse(standConfig(0));
  const source = githubSources(config, { token: 'dummy', now, fetch: fakeFetch(fakes) }).find(
    (candidate) => candidate.repo === repo,
  );
  if (source === undefined) throw new Error(`No source for ${repo}`);
  return source.adapter.poll(context);
}

/** Sends one `pr` control body and returns the result. */
export function pr(
  fakes: Fakes,
  number: number,
  verb: string,
  extra: Record<string, unknown> = {},
  repo = BOARD,
) {
  return fakes.control({ system: 'github', action: 'pr', repo, number, verb, ...extra });
}

export function violations(fakes: Fakes): { reason: string }[] {
  return (fakes.control({ action: 'violations' }).body as { violations: { reason: string }[] })
    .violations;
}
