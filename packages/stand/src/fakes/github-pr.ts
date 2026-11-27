// A fake of GitHub's pull requests over GraphQL, driven by `stand fake github pr ...`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { FakeViolation, type FakeModule } from './fetch.ts';
import { BASE_SHA, commitsView } from './github-pr-commits.ts';
import {
  branchControlSchema,
  PR_VERBS,
  prControlSchema,
  type Pr,
  type Seed,
  type Verb,
} from './github-pr-control.ts';
import type { IssueProject } from './github-issues.ts';
import { rollupState } from './github-pr-rollup.ts';
import { KNOWN_SHAPES } from './github-pr-shapes.ts';
import { projectIssuesView, projectOwnerView } from './github-project.ts';
import {
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
interface BranchCommit {
  sha: string;
  contexts: Wire[];
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
  /** The open issues of a repository with their Project items, from the GitHub Issues fake. */
  issueProjects?: (owner: string, name: string) => readonly IssueProject[];
}): FakeModule {
  const { now } = options;
  const repos = new Set(options.repos.map((repo) => repo.toLowerCase()));
  const prs = new Map<string, Pr>();
  // Default-branch commits in head-first order, by lowercase repository name.
  const branches = new Map<string, BranchCommit[]>();
  let heads = 0;
  // Not part of `state`: a restore keeps the requests answered so far.
  const requests = createRequestLog(now);
  const keyOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${String(number)}`;
  const iso = (ms: number): string => new Date(ms).toISOString();

  const threadId = (pr: Pr, i: number): string => `PRRT_${String(pr.number)}_${String(i)}`;

  /** Moves `updatedAt` strictly forward, so two verbs in one millisecond still differ. */
  function touch(pr: Pr): string {
    pr.updatedAt = iso(Math.max(now(), Date.parse(pr.updatedAt) + 1));
    return pr.updatedAt;
  }

  function create(repo: string, number: number, seed: Seed): Pr {
    const at = iso(now());
    const head = seed.headRefOid ?? createHash('sha1').update(keyOf(repo, number)).digest('hex');
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
      headRefOid: head,
      contexts: [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'IN_PROGRESS',
          conclusion: null,
          startedAt: at,
          completedAt: null,
          checkSuite: { createdAt: at, id: null, workflowRun: null, app: null },
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
      checkSuites: [],
      reviews: [],
      comments: [],
      reviewThreads: [],
      reviewRequests: [
        { requestedReviewer: { __typename: 'User', login: REVIEWER }, asCodeOwner: false },
      ],
      closingIssuesReferences: [],
      commits: [{ oid: head, parents: [BASE_SHA], changed: [] }],
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
        pr.reviewThreads = [
          ...pr.reviewThreads,
          ...Array.from({ length: command.threads }, () => ({
            isResolved: false,
            isOutdated: false,
            comments: [],
          })),
        ];
        break;
      case 'resolve':
        pr.reviewThreads = pr.reviewThreads.map((thread, i) =>
          command.thread === undefined || command.thread === threadId(pr, i)
            ? { ...thread, isResolved: true }
            : thread,
        );
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
        pr.commits = [...pr.commits, { oid: command.sha, parents: [pr.headRefOid], changed: [] }];
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

  function prView(pr: Pr): WireObject {
    const { closingIssuesReferences: closing, contexts } = pr;
    const n = String(pr.number);
    const url = `https://github.stand.invalid/${pr.repo}/pull/${n}`;
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
    // A thread links through its first comment, as on GitHub; one seeded without comments, as
    // `review --threads` opens them, lists a root comment of no review.
    const threads = pr.reviewThreads.map((thread, t) => {
      const seeded = thread.comments.length > 0;
      const listed = seeded ? thread.comments : [{ review: null, lastEditedAt: null }];
      const inline = listed.map((comment, c) => ({
        id: `PRRC_${n}_${String(t)}_${String(c)}`,
        url: `${url}#discussion_r${String(t)}${seeded ? `_${String(c)}` : ''}`,
        lastEditedAt: comment.lastEditedAt,
        pullRequestReview: comment.review === null ? null : { id: reviewId(comment.review) },
      }));
      return {
        id: threadId(pr, t),
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
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
      baseRefName: pr.baseRefName ?? 'main',
      headRefOid: pr.headRefOid,
      statusCheckRollup:
        contexts.length === 0
          ? null
          : {
              state: rollupState(contexts),
              contexts: (args: Args) => page('contexts', contexts, args),
              commit: {
                checkSuites: (args: Args) => page('checkSuites', pr.checkSuites, args),
              },
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
      commits: (args: Args) => commitsView(pr.commits, args),
    };
  }

  function branchCommitView(commits: readonly BranchCommit[], index: number): WireObject | null {
    const commit = commits[index];
    if (commit === undefined) return null;
    return {
      __typename: 'Commit',
      oid: commit.sha,
      statusCheckRollup:
        commit.contexts.length === 0
          ? null
          : { contexts: (args: Args) => page('contexts', commit.contexts, args) },
      parents: () => {
        const parent = branchCommitView(commits, index + 1);
        return { nodes: parent === null ? [] : [parent] };
      },
    };
  }

  function repositoryView(owner: unknown, name: unknown): WireObject {
    const repo = `${String(owner)}/${String(name)}`;
    if (!repos.has(repo.toLowerCase())) throw new FakeViolation(`Unknown repository ${repo}.`);
    const own = [...prs.values()].filter((pr) => pr.repo.toLowerCase() === repo.toLowerCase());
    const branch = branches.get(repo.toLowerCase());
    return {
      defaultBranchRef:
        branch === undefined ? null : { name: 'main', target: branchCommitView(branch, 0) },
      issues: (args: Args) => projectIssuesView(repo, args, options.issueProjects),
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

  /** A new default-branch head with a push run of the CI workflow and, when asked, a failed
   * scheduled run of the nightly workflow. */
  function setBranch(args: unknown): RouteResult {
    const parsed = branchControlSchema.safeParse(args ?? {});
    if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
    const { repo, state, check, scheduledFailure } = parsed.data;
    if (!repos.has(repo.toLowerCase()))
      return { status: 400, body: { error: 'Unknown repository.', repos: [...repos] } };
    heads += 1;
    const at = iso(now());
    const sha = createHash('sha1')
      .update(`${repo.toLowerCase()}:${String(heads)}`)
      .digest('hex');
    const run = (name: string, conclusion: string, event: string): Wire => ({
      __typename: 'CheckRun',
      name,
      status: 'COMPLETED',
      conclusion,
      startedAt: at,
      completedAt: at,
      detailsUrl: `https://github.stand.invalid/${repo}/actions/runs/${String(heads)}`,
      checkSuite: {
        createdAt: at,
        workflowRun: {
          event,
          workflow: { id: event === 'push' ? 'W_stand_ci' : 'W_stand_nightly' },
        },
      },
    });
    const contexts =
      state === 'unchecked' ? [] : [run(check, state === 'red' ? 'FAILURE' : 'SUCCESS', 'push')];
    if (scheduledFailure !== undefined) contexts.push(run(scheduledFailure, 'FAILURE', 'schedule'));
    const branch = branches.get(repo.toLowerCase()) ?? [];
    branch.unshift({ sha, contexts });
    branches.set(repo.toLowerCase(), branch);
    return { status: 200, body: { repo, branch: 'main', sha, state } };
  }

  function control(verb: string, args: unknown): RouteResult | undefined {
    if (verb === 'branch') return setBranch(args);
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
      if (pr.commits.at(-1)?.oid !== pr.headRefOid)
        return { status: 400, body: { error: 'The last seeded commit must be headRefOid.' } };
      prs.set(key, pr);
      return { status: 200, body: { pr: name, updatedAt: pr.updatedAt } };
    }
    if (existing === undefined) return { status: 404, body: { error: `No pull request ${name}.` } };
    if (command.verb === 'reopen' ? existing.state !== 'CLOSED' : existing.state !== 'OPEN')
      return { status: 409, body: { error: `Pull request ${name} is ${existing.state}.` } };
    if (command.verb === 'edit') return edit(existing, command, name);
    if (
      command.verb === 'resolve' &&
      command.thread !== undefined &&
      !existing.reviewThreads.some((_, i) => threadId(existing, i) === command.thread)
    )
      return { status: 404, body: { error: `No review thread ${command.thread} on ${name}.` } };
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
          `Unknown query shape ${operation.name?.value ?? '(unnamed)'}: if the adapter changed on purpose, update KNOWN_DOCUMENTS in packages/stand/src/fakes/github-pr-shapes.ts.`,
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
        rateLimit: {
          cost: points,
          limit: 5_000,
          remaining: 5_000,
          resetAt: iso(now() + 3_600_000),
        },
        repository: (args: Args) => repositoryView(args['owner'], args['name']),
        repositoryOwner: (args: Args) => projectOwnerView(args['login']),
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
      branches.clear();
      heads = 0;
      requests.clear();
    },
    state: () => structuredClone({ prs, branches, heads }),
    restore(state) {
      const saved = structuredClone(
        state as { prs: typeof prs; branches: typeof branches; heads: number },
      );
      prs.clear();
      for (const [key, pr] of saved.prs) prs.set(key, pr);
      branches.clear();
      for (const [key, branch] of saved.branches) branches.set(key, branch);
      heads = saved.heads;
    },
  };
}
