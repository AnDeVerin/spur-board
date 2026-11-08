// Samples the operator's recent PRs in a project repo against the project's link rules, for
// `board doctor`.
import { AdapterError, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';
import { GithubClient, deniedReference } from './client.ts';
import { closingRefs, closingWire, prKeys, projectKeyRule } from './prBatch.ts';

const MALFORMED = 'Malformed GitHub response';
/** PRs read per sample; the operator's PRs among them are matched. */
const SCANNED = 50;
/** Operator PRs matched per sample. */
const SAMPLED = 10;
const sampleRootWire = z.object({
  pullRequests: z.object({
    nodes: z.array(
      z.object({
        number: z.int().positive(),
        title: z.string(),
        headRefName: z.string(),
        author: z.object({ login: z.string().optional() }).nullish(),
        closingIssuesReferences: closingWire,
      }),
    ),
  }),
});

function sampleQuery(closing: boolean): string {
  const refs = closing
    ? ' closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } }'
    : '';
  return `query LinkSample($owner: String!, $repo: String!) { rateLimit { remaining resetAt } repository(owner: $owner, name: $repo) { pullRequests(first: ${String(SCANNED)}, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title headRefName author { login }${refs} } } } }`;
}

interface LinkSampleTarget {
  repo: string;
  login: string;
  tracker: Config['projects'][number]['tracker'];
  link: Config['projects'][number]['link'];
}
interface LinkSampleOptions {
  token: string;
  fetch?: typeof fetch;
  signal: AbortSignal;
}
interface LinkSample {
  /** Operator PRs matched, at most 10. */
  sampled: number;
  /** Sampled PRs the rules give no key, newest updated first, with the raw branch name. */
  unmatched: { number: number; branch: string }[];
}

/**
 * Matches up to 10 of the operator's most recently updated open or merged PRs in `repo` (among
 * the last 50) against the key rule `tracker` and `link` give that repo. A denied closing
 * reference is dropped, as the poller does; any other GraphQL error rejects with a transient
 * `AdapterError`.
 */
export async function sampleLinkRules(
  { repo, login, tracker, link }: LinkSampleTarget,
  { token, fetch: fetcher, signal }: LinkSampleOptions,
): Promise<LinkSample> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new AdapterError('config', 'Invalid repository');
  const rule = projectKeyRule(tracker, link, repo);
  const closing = rule.type === 'issues' && rule.sources.includes('closing');
  const response = await new GithubClient(token, fetcher).query(
    sampleQuery(closing),
    { owner, repo: name },
    signal,
  );
  if (response.errors.some((error) => !deniedReference(error)))
    throw new AdapterError('transient', 'GitHub link sample failed');
  const root = parseWire(sampleRootWire, response.data['repository'], MALFORMED, [
    'data',
    'repository',
  ]);
  const operator = login.toLowerCase();
  const sampled = root.pullRequests.nodes
    .filter((pr) => pr.author?.login?.toLowerCase() === operator)
    .slice(0, SAMPLED);
  return {
    sampled: sampled.length,
    unmatched: sampled
      .filter(
        (pr) =>
          prKeys(rule, pr.title, pr.headRefName, closingRefs(pr.closingIssuesReferences)).length ===
          0,
      )
      .map((pr) => ({ number: pr.number, branch: pr.headRefName })),
  };
}
