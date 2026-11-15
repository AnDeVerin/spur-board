// A fake of GitHub's pull requests over GraphQL, driven by `stand fake github pr ...`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { FakeViolation, type FakeModule } from './fetch.ts';
import { PR_VERBS, prControlSchema, type Pr, type Seed, type Verb } from './github-pr-control.ts';
import {
  canonicalizeQuery,
  canonicalize,
  createRequestLog,
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
const BOT = 'stand-bot';

// The request shapes the adapter may send, written out here on purpose: a change to an adapter
// query must fail until this list is updated, so these never come from the adapter's builders.
const REVIEWER_FIELDS =
  'requestedReviewer { __typename ... on Bot { login } ... on Mannequin { login } ... on User { login } ... on Team { slug } ... on EnterpriseTeam { slug } } asCodeOwner';
const REVIEW_FIELDS =
  'id author { __typename login } state commit { oid } submittedAt url lastEditedAt';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const COMMENT_FIELDS =
  'nodes { id author { __typename login } createdAt body url lastEditedAt } pageInfo { hasPreviousPage startCursor }';
const THREAD_FIELDS =
  'id isResolved comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } }';
const CLOSING_FIELDS = `nodes { number repository { nameWithOwner } } ${PAGE_INFO}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } ${PAGE_INFO}`;
const RATE_LIMIT = 'rateLimit { cost remaining resetAt }';
const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}';
const contextNodes = (number: string): string =>
  `nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: ${number}) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${number}) } }`;
const prAlias = (closing: boolean): string =>
  `pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { id number url title updatedAt mergedAt closedAt state isDraft mergeable mergeStateStatus author { login } headRefName headRefOid statusCheckRollup { contexts(first: 100) { ${contextNodes('1')} ${PAGE_INFO} } } reviews(first: 100) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} } comments(last: 100) { ${COMMENT_FIELDS} } reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} } reviewRequests(first: 100) { nodes { ${REVIEWER_FIELDS} } ${PAGE_INFO} }${closing ? ` closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''} } }`;
const prBatch = (states: string, baseline: string): string =>
  `query PrBatch($owner: String!, $repo: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} }${baseline} } }`;
const PR_INDEX = `query PrIndex($owner: String!, $repo: String!) { ${RATE_LIMIT} pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { number updatedAt state isDraft mergeable mergeStateStatus headRefOid statusCheckRollup { state contexts(first: 100) { totalCount nodes { ... on CheckRun { __typename name status conclusion completedAt } ... on StatusContext { __typename context state } } } } reviews(first: 100) { totalCount nodes { id state lastEditedAt } } reviewThreads(first: 100) { totalCount nodes { isResolved } } reviewRequests(first: 100) { totalCount nodes { ${REVIEWER_FIELDS} } } comments(last: 1) { totalCount nodes { id } } edited: comments(first: 1, ${ORDER}) { nodes { id updatedAt } } } } }`;
const prDetails = (closing: boolean): string =>
  `query PrDetails($owner: String!, $repo: String!) { ${RATE_LIMIT} ${prAlias(closing)} }`;
const prPage = (field: string, cursor = 'after'): string =>
  `query PrPage($owner: String!, $repo: String!, $number: Int!, $${cursor}: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
const discoveryPage = (states: string): string =>
  `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} } } }`;
const BASELINE = ` mergedBaseline: pullRequests(first: 1, states: [MERGED, CLOSED], ${ORDER}) { nodes { updatedAt } }`;
const KNOWN_DOCUMENTS = [
  prBatch('OPEN, MERGED, CLOSED', ''),
  prBatch('OPEN', BASELINE),
  PR_INDEX,
  `query PrStates($owner: String!, $repo: String!) { ${RATE_LIMIT} pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { number state } } }`,
  prDetails(false),
  prDetails(true),
  prPage(`reviews(first: 100, after: $after) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} }`),
  prPage(`reviewThreads(first: 100, after: $after) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} }`),
  prPage(`reviewRequests(first: 100, after: $after) { nodes { ${REVIEWER_FIELDS} } ${PAGE_INFO} }`),
  prPage(
    `statusCheckRollup { contexts(first: 100, after: $after) { ${contextNodes('$number')} ${PAGE_INFO} } }`,
  ),
  prPage(`closingIssuesReferences(first: 100, after: $after) { ${CLOSING_FIELDS} }`),
  prPage(`comments(last: 100, before: $before) { ${COMMENT_FIELDS} }`, 'before'),
  discoveryPage('OPEN, MERGED, CLOSED'),
  discoveryPage('OPEN'),
];
// Keep exact legacy shapes for the committed live recordings, which select neither the cost, a
// comment body, links and edits, nor thread ids and inline comments; none is inferred.
const legacy = (query: string): string =>
  query
    .replace('cost remaining', 'remaining')
    .replaceAll('createdAt body url lastEditedAt }', 'createdAt }')
    .replaceAll('submittedAt url lastEditedAt', 'submittedAt')
    .replaceAll(THREAD_FIELDS, 'isResolved')
    .replace('nodes { id state lastEditedAt }', 'nodes { id state }')
    .replace(` edited: comments(first: 1, ${ORDER}) { nodes { id updatedAt } }`, '');
const KNOWN_SHAPES = new Set(
  KNOWN_DOCUMENTS.flatMap((query) => [canonicalizeQuery(query), canonicalizeQuery(legacy(query))]),
);

/** Whether a query text is one of the shapes this fake answers. */
export function isKnownShape(query: string): boolean {
  return KNOWN_SHAPES.has(canonicalizeQuery(query));
}

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
    totalCount: items.length,
    nodes,
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: nodes.length === 0 ? null : `fake:${connection}:${String(offset + nodes.length)}`,
    },
  };
}
// GitHub's backward paging: the `last` items before the `before` cursor, newest page first.
function pageBack(connection: string, items: readonly Wire[], args: Args): WireObject {
  // The variable check has already made a given `before` a string.
  const before = args['before'] as string | undefined;
  let end = items.length;
  if (before !== undefined) {
    const match = new RegExp(`^fake:${connection}:(0|[1-9][0-9]*)$`).exec(before);
    end = Number(match?.[1] ?? Number.NaN);
    if (!(end <= items.length)) throw new FakeViolation(`Unknown ${connection} cursor ${before}.`);
  }
  const start = Math.max(0, end - Number(args['last']));
  const nodes = items.slice(start, end);
  return {
    totalCount: items.length,
    nodes,
    pageInfo: {
      hasPreviousPage: start > 0,
      startCursor: nodes.length === 0 ? null : `fake:${connection}:${String(start)}`,
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
  // Not part of `state`: a restore keeps the requests answered so far.
  const requests = createRequestLog(now);
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
      mergedAt: seed.state === 'MERGED' ? (seed.updatedAt ?? at) : null,
      // GitHub stamps closedAt on a merge too.
      closedAt: seed.state === 'MERGED' || seed.state === 'CLOSED' ? (seed.updatedAt ?? at) : null,
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
      comments: [],
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

  type Author = NonNullable<Pr['comments'][number]['author']>;
  function authorOf(command: { author?: string | undefined; bot: boolean }): Author {
    return {
      __typename: command.bot ? 'Bot' : 'User',
      login: command.author ?? (command.bot ? BOT : REVIEWER),
    };
  }
  /** Adds a review on the current head; a submitted review drops its author's request. */
  function addReview(pr: Pr, author: Author, state: string, at: string): void {
    pr.reviews = [
      ...pr.reviews,
      { author, state, commit: { oid: pr.headRefOid }, submittedAt: at, lastEditedAt: null },
    ];
    pr.reviewRequests = pr.reviewRequests.filter(
      ({ requestedReviewer: reviewer }) =>
        reviewer === null || !('login' in reviewer) || reviewer.login !== author.login,
    );
  }

  /** Edits one comment; GitHub leaves the PR's updatedAt as it was. */
  function edit(pr: Pr, command: Extract<Verb, { verb: 'edit' }>, name: string): RouteResult {
    const comment = pr.comments[command.index];
    if (comment === undefined)
      return { status: 404, body: { error: `No comment ${String(command.index)} on ${name}.` } };
    // Strictly after the previous edit, so two edits under a fixed clock still differ.
    const previous = Date.parse(comment.lastEditedAt ?? comment.createdAt);
    comment.lastEditedAt = iso(Math.max(now(), previous + 1));
    if (command.body !== undefined) comment.body = command.body;
    return { status: 200, body: { pr: name, editedAt: comment.lastEditedAt } };
  }

  function apply(pr: Pr, command: Exclude<Verb, { verb: 'edit' }>): void {
    const at = touch(pr);
    switch (command.verb) {
      case 'approve':
        addReview(pr, { __typename: 'User', login: REVIEWER }, 'APPROVED', at);
        break;
      case 'review':
        addReview(pr, authorOf(command), command.state, at);
        break;
      case 'comment':
        pr.comments = [
          ...pr.comments,
          { author: authorOf(command), createdAt: at, body: command.body, lastEditedAt: null },
        ];
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
        pr.mergedAt = at;
        pr.closedAt = at;
        pr.mergeable = 'UNKNOWN';
        pr.mergeStateStatus = 'UNKNOWN';
        break;
      case 'reopen':
        pr.state = 'OPEN';
        pr.closedAt = null;
        break;
      case 'close':
        pr.state = 'CLOSED';
        pr.closedAt = at;
        break;
    }
  }

  /** GitHub's combined state: any failure wins, then anything still running. */
  function rollupState(contexts: readonly Context[]): string {
    const failed = contexts.some((context) =>
      context.__typename === 'StatusContext'
        ? context.state === 'FAILURE' || context.state === 'ERROR'
        : context.status === 'COMPLETED' &&
          ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(
            context.conclusion ?? '',
          ),
    );
    if (failed) return 'FAILURE';
    const running = contexts.some((context) =>
      context.__typename === 'StatusContext'
        ? context.state === 'PENDING' || context.state === 'EXPECTED'
        : context.status !== 'COMPLETED',
    );
    return running ? 'PENDING' : 'SUCCESS';
  }

  function prView(pr: Pr): WireObject {
    const { closingIssuesReferences: closing, contexts } = pr;
    const n = String(pr.number);
    const url = `https://github.stand.invalid/${pr.repo}/pull/${String(pr.number)}`;
    const reviewId = (i: number): string => `PRR_${n}_${String(i)}`;
    const reviews = pr.reviews.map((review, i) => ({
      id: reviewId(i),
      ...review,
      url: `${url}#pullrequestreview-${String(i)}`,
    }));
    const comments = pr.comments.map((comment, i) => ({
      id: `IC_${n}_${String(i)}`,
      ...comment,
      url: `${url}#issuecomment-${String(i)}`,
      updatedAt: comment.lastEditedAt ?? comment.createdAt,
    }));
    // `comments(first:, orderBy: UPDATED_AT DESC)` is the index's edit sign; otherwise back paging.
    const updatedFirst = comments
      .map((comment, i) => ({ comment, i }))
      .sort(
        (a, b) => Date.parse(b.comment.updatedAt) - Date.parse(a.comment.updatedAt) || b.i - a.i,
      )
      .map(({ comment }) => comment);
    const threads = pr.reviewThreads.map((thread, t) => {
      const inline = thread.comments.map((comment, c) => ({
        id: `PRRC_${n}_${String(t)}_${String(c)}`,
        url: `${url}#discussion_r${String(t)}_${String(c)}`,
        lastEditedAt: comment.lastEditedAt,
        pullRequestReview: comment.review === null ? null : { id: reviewId(comment.review) },
      }));
      return {
        id: `PRRT_${n}_${String(t)}`,
        isResolved: thread.isResolved,
        comments: (args: Args) => pageBack('threadComments', inline, args),
      };
    });
    return {
      id: `PR_${String(pr.number)}`,
      number: pr.number,
      url,
      title: pr.title,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
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
          : {
              state: rollupState(contexts),
              contexts: (args: Args) => page('contexts', contexts, args),
            },
      reviews: (args: Args) => page('reviews', reviews, args),
      comments: (args: Args) =>
        args['first'] === undefined
          ? pageBack('comments', comments, args)
          : page('comments', updatedFirst, args),
      reviewThreads: (args: Args) => page('reviewThreads', threads, args),
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

  function control(verb: string, args: unknown): RouteResult | undefined {
    if (verb === 'inspect')
      return z.strictObject({}).safeParse(args ?? {}).success
        ? { status: 200, body: { requests: requests.list() } }
        : { status: 400, body: { error: 'inspect takes no arguments.' } };
    if (!PR_VERBS.has(verb)) return undefined;
    const parsed = prControlSchema.safeParse({ ...(args as object), verb });
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
    if (command.verb === 'reopen' ? existing.state !== 'CLOSED' : existing.state !== 'OPEN')
      return { status: 409, body: { error: `Pull request ${name} is ${existing.state}.` } };
    if (command.verb === 'edit') return edit(existing, command, name);
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
      // Synthetic operation costs make request savings measurable without claiming live pricing.
      const operationName = operation.name?.value;
      const points =
        operationName === 'PrDetails'
          ? 5
          : operationName === 'PrPage'
            ? 3
            : operationName === 'PrIndex'
              ? 2
              : 1;
      const root: WireObject = {
        rateLimit: { cost: points, remaining: 5_000, resetAt: iso(now() + 3_600_000) },
        repository: (args: Args) => repositoryView(args['owner'], args['name']),
      };
      const answer = () => {
        const { data, errors } = project(operation, variables, root);
        return { status: 200, body: errors.length === 0 ? { data } : { data, errors } };
      };
      // A dry run, so a request the state cannot answer is logged before any failure applies.
      answer();
      requests.record(operation, variables, points);
      return answer;
    },
    control,
    reset() {
      prs.clear();
      requests.clear();
    },
    state: () => structuredClone(prs),
    restore(state) {
      prs.clear();
      for (const [key, pr] of structuredClone(state as Map<string, Pr>)) prs.set(key, pr);
    },
  };
}
