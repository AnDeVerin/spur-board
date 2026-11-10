// A fake of GitHub's pull requests over GraphQL, driven by `stand fake github pr ...`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { FakeViolation, type FakeModule } from './fetch.ts';
import {
  canonicalizeQuery,
  canonicalize,
  NotFound,
  parseGraphqlRequest,
  project,
  type Args,
  type Wire,
  type WireObject,
} from './graphql.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const AGENT = 'stand-agent';
const REVIEWER = 'stand-reviewer';
const SHA = /^[0-9a-f]{40,64}$/;

// The request shapes the adapter may send, written out here on purpose: a change to an adapter
// query must fail until this list is updated, so these never come from the adapter's builders.
const REVIEWER_FIELDS =
  'requestedReviewer { __typename ... on Bot { login } ... on Mannequin { login } ... on User { login } ... on Team { slug } ... on EnterpriseTeam { slug } } asCodeOwner';
const REVIEW_FIELDS = 'author { login } state commit { oid } submittedAt';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const CLOSING_FIELDS = `nodes { number repository { nameWithOwner } } ${PAGE_INFO}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } ${PAGE_INFO}`;
const RATE_LIMIT = 'rateLimit { remaining resetAt }';
const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}';
const contextNodes = (number: string): string =>
  `nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: ${number}) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${number}) } }`;
const prAlias = (closing: boolean): string =>
  `pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { id number url title updatedAt state isDraft mergeable mergeStateStatus author { login } headRefName headRefOid statusCheckRollup { contexts(first: 100) { ${contextNodes('1')} ${PAGE_INFO} } } reviews(first: 100) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} } reviewThreads(first: 100) { nodes { isResolved } ${PAGE_INFO} } reviewRequests(first: 100) { nodes { ${REVIEWER_FIELDS} } ${PAGE_INFO} }${closing ? ` closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''} } }`;
const prBatch = (states: string, baseline: string, aliases: string): string =>
  `query PrBatch($owner: String!, $repo: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} }${baseline} } ${aliases} }`;
const prDetails = (closing: boolean): string =>
  `query PrDetails($owner: String!, $repo: String!) { ${RATE_LIMIT} ${prAlias(closing)} }`;
const prPage = (field: string): string =>
  `query PrPage($owner: String!, $repo: String!, $number: Int!, $after: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
const discoveryPage = (states: string): string =>
  `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} } } }`;
const BASELINE = ` mergedBaseline: pullRequests(first: 1, states: [MERGED], ${ORDER}) { nodes { updatedAt } }`;
const KNOWN_DOCUMENTS = [
  prBatch('OPEN, MERGED', '', ''),
  prBatch('OPEN, MERGED', '', prAlias(false)),
  prBatch('OPEN, MERGED', '', prAlias(true)),
  prBatch('OPEN', BASELINE, ''),
  prBatch('OPEN', BASELINE, prAlias(false)),
  prBatch('OPEN', BASELINE, prAlias(true)),
  prDetails(false),
  prDetails(true),
  prPage(`reviews(first: 100, after: $after) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} }`),
  prPage(`reviewThreads(first: 100, after: $after) { nodes { isResolved } ${PAGE_INFO} }`),
  prPage(`reviewRequests(first: 100, after: $after) { nodes { ${REVIEWER_FIELDS} } ${PAGE_INFO} }`),
  prPage(
    `statusCheckRollup { contexts(first: 100, after: $after) { ${contextNodes('$number')} ${PAGE_INFO} } }`,
  ),
  prPage(`closingIssuesReferences(first: 100, after: $after) { ${CLOSING_FIELDS} }`),
  discoveryPage('OPEN, MERGED'),
  discoveryPage('OPEN'),
];
const KNOWN_SHAPES = new Set(KNOWN_DOCUMENTS.map(canonicalizeQuery));

/** Whether a query text is one of the shapes this fake answers. */
export function isKnownShape(query: string): boolean {
  return KNOWN_SHAPES.has(canonicalizeQuery(query));
}

const actorSchema = z.strictObject({ login: z.string().min(1) }).nullable();
const contextSchema = z.discriminatedUnion('__typename', [
  z.strictObject({
    __typename: z.literal('CheckRun'),
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    checkSuite: z.strictObject({ createdAt: z.string() }).nullable(),
    isRequired: z.boolean(),
  }),
  z.strictObject({
    __typename: z.literal('StatusContext'),
    context: z.string().min(1),
    state: z.string(),
    createdAt: z.string(),
    isRequired: z.boolean(),
  }),
]);
const reviewerSchema = z.discriminatedUnion('__typename', [
  z.strictObject({ __typename: z.literal('User'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Mannequin'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Bot'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Team'), slug: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('EnterpriseTeam'), slug: z.string().min(1) }),
]);
const fieldsSchema = z.strictObject({
  title: z.string(),
  updatedAt: z.iso.datetime(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: actorSchema,
  headRefName: z.string().min(1),
  headRefOid: z.string().regex(SHA),
  contexts: z.array(contextSchema),
  reviews: z.array(
    z.strictObject({
      author: actorSchema,
      state: z.string(),
      commit: z.strictObject({ oid: z.string() }).nullable(),
      submittedAt: z.string().nullable(),
    }),
  ),
  reviewThreads: z.array(z.strictObject({ isResolved: z.boolean() })),
  reviewRequests: z.array(
    z.strictObject({ requestedReviewer: reviewerSchema.nullable(), asCodeOwner: z.boolean() }),
  ),
  closingIssuesReferences: z
    .array(
      z
        .strictObject({
          number: z.int().positive(),
          repository: z.strictObject({ nameWithOwner: z.string() }).nullable(),
        })
        .nullable(),
    )
    .nullable(),
});
/** What `create` accepts; each field replaces its default. An empty `contexts` means no rollup. */
const seedSchema = fieldsSchema.partial();
type Seed = z.output<typeof seedSchema>;
type Pr = z.output<typeof fieldsSchema> & { repo: string; number: number };

const target = {
  system: z.literal('github'),
  action: z.literal('pr'),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.int().positive(),
};
const prControlSchema = z.discriminatedUnion('verb', [
  z.strictObject({ ...target, verb: z.literal('create'), seed: seedSchema.default({}) }),
  z.strictObject({ ...target, verb: z.literal('approve') }),
  z.strictObject({ ...target, verb: z.literal('ci-red') }),
  z.strictObject({ ...target, verb: z.literal('ci-green') }),
  z.strictObject({ ...target, verb: z.literal('merge') }),
  z.strictObject({ ...target, verb: z.literal('conflict') }),
  z.strictObject({ ...target, verb: z.literal('push'), sha: z.string().regex(SHA) }),
]);
type Verb = Exclude<z.output<typeof prControlSchema>, { verb: 'create' }>;

function page(connection: string, items: readonly Wire[], args: Args): WireObject {
  // The variable check has already made a given `after` a string.
  const after = args['after'] as string | undefined;
  let offset = 0;
  if (after !== undefined) {
    const match = new RegExp(`^fake:${connection}:([1-9][0-9]*)$`).exec(after);
    offset = Number(match?.[1] ?? Number.NaN);
    if (!(offset <= items.length))
      throw new FakeViolation(`Unknown ${connection} cursor ${after}.`);
  }
  const end = offset + Number(args['first']);
  const nodes = items.slice(offset, end);
  return {
    nodes,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: nodes.length === 0 ? null : `fake:${connection}:${String(offset + nodes.length)}`,
    },
  };
}

/** Pull requests of the configured repositories, with the verbs that change them. */
export function createGithubPrFake(options: {
  now: () => number;
  repos: readonly string[];
}): FakeModule {
  const { now } = options;
  const repos = new Set(options.repos.map((repo) => repo.toLowerCase()));
  const prs = new Map<string, Pr>();
  const keyOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${String(number)}`;
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** Moves `updatedAt` strictly forward, so two verbs in one millisecond still differ. */
  function touch(pr: Pr): string {
    pr.updatedAt = iso(Math.max(now(), Date.parse(pr.updatedAt) + 1));
    return pr.updatedAt;
  }

  function create(repo: string, number: number, seed: Seed): Pr {
    const at = iso(now());
    return {
      repo,
      number,
      title: `Stand PR ${String(number)}`,
      updatedAt: at,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      author: { login: AGENT },
      headRefName: `stand-${String(number)}`,
      headRefOid: createHash('sha1').update(keyOf(repo, number)).digest('hex'),
      contexts: [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'IN_PROGRESS',
          conclusion: null,
          startedAt: at,
          completedAt: null,
          checkSuite: { createdAt: at },
          isRequired: true,
        },
        {
          __typename: 'StatusContext',
          context: 'status/lint',
          state: 'PENDING',
          createdAt: at,
          isRequired: false,
        },
      ],
      reviews: [],
      reviewThreads: [],
      reviewRequests: [
        { requestedReviewer: { __typename: 'User', login: REVIEWER }, asCodeOwner: false },
      ],
      closingIssuesReferences: [],
      ...seed,
    } as Pr;
  }

  type Context = Pr['contexts'][number];
  function finished(context: Context, conclusion: 'SUCCESS' | 'FAILURE', at: string): Context {
    return context.__typename === 'StatusContext'
      ? { ...context, state: conclusion }
      : { ...context, status: 'COMPLETED', conclusion, completedAt: at };
  }
  function pending(context: Context, at: string): Context {
    return context.__typename === 'StatusContext'
      ? { ...context, state: 'PENDING', createdAt: at }
      : { ...context, status: 'IN_PROGRESS', conclusion: null, startedAt: at, completedAt: null };
  }

  function apply(pr: Pr, command: Verb): void {
    const at = touch(pr);
    switch (command.verb) {
      case 'approve':
        pr.reviews = [
          ...pr.reviews,
          {
            author: { login: REVIEWER },
            state: 'APPROVED',
            commit: { oid: pr.headRefOid },
            submittedAt: at,
          },
        ];
        pr.reviewRequests = pr.reviewRequests.filter(
          ({ requestedReviewer: reviewer }) =>
            reviewer === null || !('login' in reviewer) || reviewer.login !== REVIEWER,
        );
        break;
      case 'ci-red': {
        const anyRequired = pr.contexts.some((context) => context.isRequired);
        pr.contexts = pr.contexts.map((context) =>
          context.isRequired || !anyRequired ? finished(context, 'FAILURE', at) : context,
        );
        if (pr.mergeStateStatus !== 'DIRTY') pr.mergeStateStatus = 'BLOCKED';
        break;
      }
      case 'ci-green':
        pr.contexts = pr.contexts.map((context) => finished(context, 'SUCCESS', at));
        if (pr.mergeStateStatus !== 'DIRTY') pr.mergeStateStatus = 'CLEAN';
        break;
      case 'conflict':
        pr.mergeable = 'CONFLICTING';
        pr.mergeStateStatus = 'DIRTY';
        break;
      case 'push':
        pr.headRefOid = command.sha;
        pr.contexts = pr.contexts.map((context) => pending(context, at));
        pr.mergeable = 'MERGEABLE';
        pr.mergeStateStatus = 'BLOCKED';
        break;
      case 'merge':
        pr.state = 'MERGED';
        pr.mergeable = 'UNKNOWN';
        pr.mergeStateStatus = 'UNKNOWN';
        break;
    }
  }

  function prView(pr: Pr): WireObject {
    const { closingIssuesReferences: closing, contexts } = pr;
    return {
      id: `PR_${String(pr.number)}`,
      number: pr.number,
      url: `https://github.stand.invalid/${pr.repo}/pull/${String(pr.number)}`,
      title: pr.title,
      updatedAt: pr.updatedAt,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      author: pr.author,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      statusCheckRollup:
        contexts.length === 0
          ? null
          : { contexts: (args: Args) => page('contexts', contexts, args) },
      reviews: (args: Args) => page('reviews', pr.reviews, args),
      reviewThreads: (args: Args) => page('reviewThreads', pr.reviewThreads, args),
      reviewRequests: (args: Args) => page('reviewRequests', pr.reviewRequests, args),
      closingIssuesReferences:
        closing === null ? null : (args: Args) => page('closingIssuesReferences', closing, args),
    };
  }

  function repositoryView(owner: unknown, name: unknown): WireObject {
    const repo = `${String(owner)}/${String(name)}`;
    if (!repos.has(repo.toLowerCase())) throw new FakeViolation(`Unknown repository ${repo}.`);
    const own = [...prs.values()].filter((pr) => pr.repo.toLowerCase() === repo.toLowerCase());
    return {
      // Newest first, which the adapter's scan relies on to stop at its cursor.
      pullRequests: (args: Args) => {
        const states = args['states'] as readonly string[];
        const nodes = own
          .filter((pr) => states.includes(pr.state))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number)
          .map((pr) => ({
            number: pr.number,
            updatedAt: pr.updatedAt,
            author: pr.author,
            state: pr.state,
          }));
        return page('pullRequests', nodes, args);
      },
      pullRequest: (args: Args) => {
        const number = Number(args['number']);
        const pr = prs.get(keyOf(repo, number));
        return pr === undefined
          ? new NotFound(`Could not resolve to a PullRequest with the number of ${String(number)}.`)
          : prView(pr);
      },
    };
  }

  function control(body: Record<string, unknown>): RouteResult | undefined {
    if (body['action'] !== 'pr') return undefined;
    const parsed = prControlSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
    const command = parsed.data;
    if (!repos.has(command.repo.toLowerCase()))
      return { status: 400, body: { error: 'Unknown repository.', repos: [...repos] } };
    const key = keyOf(command.repo, command.number);
    const existing = prs.get(key);
    const name = `${command.repo}#${String(command.number)}`;
    if (command.verb === 'create') {
      if (existing !== undefined)
        return { status: 409, body: { error: `Pull request ${name} already exists.` } };
      const pr = create(command.repo, command.number, command.seed);
      prs.set(key, pr);
      return { status: 200, body: { pr: name, updatedAt: pr.updatedAt } };
    }
    if (existing === undefined) return { status: 404, body: { error: `No pull request ${name}.` } };
    if (existing.state !== 'OPEN')
      return { status: 409, body: { error: `Pull request ${name} is ${existing.state}.` } };
    apply(existing, command);
    return { status: 200, body: { pr: name, updatedAt: existing.updatedAt } };
  }

  return {
    system: 'github',
    claims: (url) => url.href === GRAPHQL_URL,
    prepare(request) {
      if (request.method !== 'POST')
        throw new FakeViolation(`GraphQL takes POST, got ${request.method}.`);
      const { operation, variables } = parseGraphqlRequest(request.body);
      if (!KNOWN_SHAPES.has(canonicalize(operation)))
        throw new FakeViolation(
          `Unknown query shape ${operation.name?.value ?? '(unnamed)'}: if the adapter changed on purpose, update KNOWN_DOCUMENTS in packages/stand/src/fakes/github-pr.ts.`,
        );
      const root: WireObject = {
        rateLimit: { remaining: 5_000, resetAt: iso(now() + 3_600_000) },
        repository: (args: Args) => repositoryView(args['owner'], args['name']),
      };
      const answer = () => {
        const { data, errors } = project(operation, variables, root);
        return { status: 200, body: errors.length === 0 ? { data } : { data, errors } };
      };
      // A dry run, so a request the state cannot answer is logged before any failure applies.
      answer();
      return answer;
    },
    control,
    reset() {
      prs.clear();
    },
  };
}
