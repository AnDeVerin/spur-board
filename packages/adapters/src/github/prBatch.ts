import {
  AdapterError,
  DEFAULT_LINK,
  JIRA_PROJECT_KEY,
  REVIEW_STATES,
  assertNever,
  prFactsSchema,
  type Config,
  type PrFacts,
  type PrFeedback,
  type ReviewerKind,
} from '@spur-board/contracts';
import { z } from 'zod';
import { parseWire } from '../runner/wire.ts';

const KEPT_REVIEWS = ['approved', 'changes_requested', 'dismissed'];
const actor = z.object({ login: z.string().optional() }).nullish();
// The author of a comment or review; a deleted account arrives as null.
const typedActor = z.object({ __typename: z.string(), login: z.string().min(1) }).nullable();
const checkRunWire = z
  .object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullish(),
    completedAt: z.string().nullable(),
    checkSuite: z.object({ createdAt: z.string() }).nullish(),
    isRequired: z.boolean().nullish(),
  })
  .refine((run) => run.status !== 'COMPLETED' || run.conclusion !== null, {
    path: ['conclusion'],
  });
const statusContextWire = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  createdAt: z.string(),
  isRequired: z.boolean().nullish(),
});
const contextWire = z.discriminatedUnion('__typename', [checkRunWire, statusContextWire]);
// A kept review must name its commit.
const reviewWire = z
  .object({
    id: z.string().min(1),
    author: typedActor,
    state: z.string(),
    commit: z.object({ oid: z.string() }).nullable(),
    submittedAt: z.string().nullish(),
  })
  .refine(
    (review) =>
      review.commit !== null ||
      !review.author?.login ||
      review.submittedAt == null ||
      !KEPT_REVIEWS.includes(review.state.toLowerCase()),
    { path: ['commit'] },
  );
const nodes = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node) });
export const commentWire = z.object({
  id: z.string().min(1),
  author: typedActor,
  // Same check as the fact's postedAt, so a bad time fails its own history page.
  createdAt: z.iso.datetime(),
});
const loginReviewer = <T extends string>(type: T) =>
  z.object({ __typename: z.literal(type), login: z.string() });
const slugReviewer = <T extends string>(type: T) =>
  z.object({ __typename: z.literal(type), slug: z.string() });
// A requested team the token cannot see arrives as null, with no error.
const reviewerWire = z
  .discriminatedUnion('__typename', [
    loginReviewer('User'),
    loginReviewer('Mannequin'),
    loginReviewer('Bot'),
    slugReviewer('Team'),
    slugReviewer('EnterpriseTeam'),
  ])
  .nullable();
// A denied issue arrives as a null node.
export const closingWire = z
  .object({
    nodes: z.array(
      z
        .object({
          number: z.int().positive(),
          repository: z.object({ nameWithOwner: z.string() }).nullish(),
        })
        .nullable(),
    ),
  })
  .nullish();
// Vendor enums stay strings; normalizePr maps unknown values.
const prWire = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  state: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: actor,
  headRefName: z.string(),
  headRefOid: z.string(),
  statusCheckRollup: z.object({ contexts: nodes(contextWire) }).nullish(),
  reviews: nodes(reviewWire),
  comments: nodes(commentWire),
  reviewThreads: nodes(z.object({ isResolved: z.boolean() })),
  reviewRequests: nodes(
    z.object({
      requestedReviewer: reviewerWire,
      asCodeOwner: z.boolean(),
    }),
  ),
  // Selected only for the tracker repo of a github-issues project whose `link.sources` lists
  // `closing`; a Jira project never selects it.
  closingIssuesReferences: closingWire,
});
type ContextWire = z.output<typeof contextWire>;
type ReviewWire = z.output<typeof reviewWire>;
type CommentWire = z.output<typeof commentWire>;
type ActorWire = z.output<typeof typedActor>;
type ReviewerWire = NonNullable<z.output<typeof reviewerWire>>;
type ClosingWire = z.output<typeof closingWire>;
type IssuesRule = Extract<KeyRule, { type: 'issues' }>;
type JiraRule = Extract<KeyRule, { type: 'jira' }>;
type Link = Config['projects'][number]['link'];
type Tracker = Config['projects'][number]['tracker'];
/** An issue a PR closes, as GitHub names it. */
interface ClosingRef {
  repo: string;
  number: number;
}

/**
 * How a source turns a PR into task keys: every key with one of `prefixes` in the title and
 * branch, the issue numbers of a github-issues tracker repo, or Jira keys by a project's custom
 * `link` rules. A `jira` pattern left `undefined` scans that text for `prefixes` keys.
 */
export type KeyRule =
  | { type: 'prefixes'; prefixes: readonly string[] }
  | {
      type: 'issues';
      repo: string;
      sources: Link['sources'];
      branch: RegExp;
      title: RegExp;
    }
  | {
      type: 'jira';
      prefixes: readonly string[];
      sources: readonly ('branch' | 'title')[];
      branch: RegExp | undefined;
      title: RegExp | undefined;
    };

/** The key rule of a github-issues project's tracker repo, built from `projects[].link`. */
function issuesRule(repo: string, link: Link): IssuesRule {
  return {
    type: 'issues',
    repo,
    sources: link.sources,
    branch: new RegExp(link.branchPattern),
    title: new RegExp(link.titlePattern),
  };
}
// A Jira project's `link` field equal to its default counts as unset; all three unset keep the
// legacy scan of title and branch for every `projectKeys` key.
function jiraRule(prefixes: readonly string[], link: Link): KeyRule {
  const sources =
    link.sources.length === DEFAULT_LINK.sources.length &&
    link.sources.every((source, i) => source === DEFAULT_LINK.sources[i]);
  const branch = link.branchPattern === DEFAULT_LINK.branchPattern;
  const title = link.titlePattern === DEFAULT_LINK.titlePattern;
  if (sources && branch && title) return { type: 'prefixes', prefixes };
  return {
    type: 'jira',
    prefixes,
    sources: link.sources.filter((source) => source !== 'closing'),
    branch: branch ? undefined : new RegExp(link.branchPattern),
    title: title ? undefined : new RegExp(link.titlePattern),
  };
}
/**
 * The key rule of `repo` in a project: the github-issues tracker repo reads issue numbers by
 * `link`, its other repos link nothing, and a Jira project's repos read `projectKeys` keys.
 */
export function projectKeyRule(tracker: Tracker, link: Link, repo: string): KeyRule {
  switch (tracker.type) {
    case 'github-issues':
      return tracker.repo.toLowerCase() === repo.toLowerCase()
        ? issuesRule(tracker.repo, link)
        : { type: 'prefixes', prefixes: [] };
    case 'jira':
      return jiraRule(tracker.projectKeys, link);
    default:
      return assertNever(tracker);
  }
}
/** Drops denied (null) nodes and nodes without a repository. */
export function closingRefs(wire: ClosingWire): ClosingRef[] {
  return (wire?.nodes ?? []).flatMap((node) =>
    node?.repository ? [{ repo: node.repository.nameWithOwner, number: node.number }] : [],
  );
}

function checkState(node: ContextWire): PrFacts['checks'][number]['state'] {
  if (node.__typename === 'StatusContext') {
    const state = node.state.toLowerCase();
    return state === 'success'
      ? 'success'
      : state === 'pending'
        ? 'pending'
        : state === 'expected'
          ? 'expected'
          : 'failure';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  const value = node.conclusion?.toLowerCase();
  const allowed: PrFacts['checks'][number]['state'][] = [
    'success',
    'neutral',
    'skipped',
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
  ];
  return allowed.find((state) => state === value) ?? 'error';
}
function latestChecks(nodes: readonly ContextWire[]): {
  checks: PrFacts['checks'];
  requiredChecks: PrFacts['requiredChecks'];
} {
  const latest = new Map<
    string,
    { check: PrFacts['checks'][number]; required: boolean; at: string }
  >();
  for (const node of nodes) {
    const status = node.__typename === 'StatusContext';
    const name = status ? node.context : node.name;
    const completedAt = status ? null : node.completedAt;
    const at = status
      ? node.createdAt
      : (node.startedAt ?? node.checkSuite?.createdAt ?? completedAt ?? '');
    const old = latest.get(name);
    if (old !== undefined && old.at > at) continue;
    latest.set(name, {
      check: { name, state: checkState(node), completedAt },
      required: node.isRequired === true,
      at,
    });
  }
  const values = [...latest.values()].sort((a, b) => a.check.name.localeCompare(b.check.name));
  return {
    checks: values.map((v) => v.check),
    requiredChecks: values.filter((v) => v.required).map((v) => v.check),
  };
}
function latestReviews(nodes: readonly ReviewWire[]): PrFacts['reviews'] {
  const latest = new Map<string, PrFacts['reviews'][number]>();
  for (const node of nodes) {
    const reviewer = node.author?.login;
    if (!reviewer || node.submittedAt == null || node.commit === null) continue;
    const state = node.state.toLowerCase();
    if (!KEPT_REVIEWS.includes(state)) continue;
    const review = {
      reviewer,
      state,
      commitSha: node.commit.oid,
      submittedAt: node.submittedAt,
    } as PrFacts['reviews'][number];
    const old = latest.get(reviewer);
    if (old === undefined || old.submittedAt <= review.submittedAt) latest.set(reviewer, review);
  }
  return [...latest.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}
function feedbackAuthor(wire: ActorWire): PrFeedback['author'] {
  return wire === null
    ? null
    : { login: wire.login, type: wire.__typename === 'Bot' ? 'bot' : 'user' };
}
// Every comment and submitted review once, oldest first; equal times fall back to the id. Held
// comments from an earlier poll come first, so a comment read again replaces its held entry.
function feedbackOf(
  reviews: readonly ReviewWire[],
  comments: readonly CommentWire[],
  held: readonly PrFeedback[],
): PrFeedback[] {
  const entries = new Map<string, PrFeedback>();
  const add = (entry: PrFeedback): void => {
    entries.set(`${entry.kind}:${entry.id}`, entry);
  };
  for (const entry of held) if (entry.kind === 'comment') add(entry);
  for (const node of comments)
    add({
      kind: 'comment',
      id: node.id,
      author: feedbackAuthor(node.author),
      postedAt: node.createdAt,
    });
  for (const node of reviews) {
    if (node.submittedAt == null) continue;
    const state = REVIEW_STATES.find((known) => known === node.state.toLowerCase());
    add({
      kind: 'review',
      id: node.id,
      author: feedbackAuthor(node.author),
      postedAt: node.submittedAt,
      ...(state === undefined ? {} : { state }),
    });
  }
  const tie = (entry: PrFeedback): string => `${entry.id}\u0000${entry.kind}`;
  return [...entries.values()].sort(
    (a, b) =>
      Date.parse(a.postedAt) - Date.parse(b.postedAt) ||
      (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0),
  );
}
export function ticketKeys(title: string, branch: string, prefixes: readonly string[]): string[] {
  return scanKeys(`${title} ${branch}`, prefixes);
}
// A Jira key anywhere in a text, in any letter case; used only through `matchAll`.
const SCANNED_KEY = new RegExp(
  `(?<![A-Za-z0-9_])(${JIRA_PROJECT_KEY})-([1-9][0-9]*)(?![A-Za-z0-9_])`,
  'gi',
);
// Every key with one of `prefixes` in `text`, in any letter case, uppercased, in order.
function scanKeys(text: string, prefixes: readonly string[]): string[] {
  const keys = new Set<string>();
  const allowed = new Set(prefixes);
  for (const match of text.matchAll(SCANNED_KEY)) {
    const prefix = match[1]?.toUpperCase();
    const number = match[2];
    if (prefix !== undefined && number !== undefined && allowed.has(prefix))
      keys.add(`${prefix}-${number}`);
  }
  return [...keys];
}
const ISSUE_NUMBER = /^[1-9][0-9]{0,14}$/;
// The longest ref name GitHub accepts; a longer branch or title never reaches a pattern.
const MAX_MATCHED_LENGTH = 255;
function matchedNumber(text: string, pattern: RegExp): number | undefined {
  if (text.length > MAX_MATCHED_LENGTH) return undefined;
  const number = pattern.exec(text)?.[1];
  return number !== undefined && ISSUE_NUMBER.test(number) ? Number(number) : undefined;
}
// The first source in `rule.sources` that yields a number gives the keys.
function issueKeys(
  title: string,
  branch: string,
  refs: readonly ClosingRef[],
  rule: IssuesRule,
): string[] {
  const repo = rule.repo.toLowerCase();
  for (const source of rule.sources) {
    const numbers = new Set<number>();
    if (source === 'closing') {
      for (const ref of refs) {
        if (ref.repo.toLowerCase() === repo && ISSUE_NUMBER.test(String(ref.number)))
          numbers.add(ref.number);
      }
    } else {
      const number =
        source === 'branch' ? matchedNumber(branch, rule.branch) : matchedNumber(title, rule.title);
      if (number !== undefined) numbers.add(number);
    }
    if (numbers.size > 0)
      return [...numbers].sort((a, b) => a - b).map((number) => `${rule.repo}#${String(number)}`);
  }
  return [];
}
const JIRA_KEY = new RegExp(`^(${JIRA_PROJECT_KEY})-[1-9][0-9]*$`);
// The key a custom pattern captures, uppercased, when it is a key with one of `prefixes`.
function matchedKey(text: string, pattern: RegExp, prefixes: readonly string[]): string[] {
  if (text.length > MAX_MATCHED_LENGTH) return [];
  const key = pattern.exec(text)?.[1]?.toUpperCase();
  if (key === undefined) return [];
  const prefix = JIRA_KEY.exec(key)?.[1];
  return prefix !== undefined && prefixes.includes(prefix) ? [key] : [];
}
// The first source in `rule.sources` that yields a key gives the keys.
function jiraKeys(title: string, branch: string, rule: JiraRule): string[] {
  for (const source of rule.sources) {
    const text = source === 'branch' ? branch : title;
    const pattern = rule[source];
    const keys =
      pattern === undefined
        ? scanKeys(text, rule.prefixes)
        : matchedKey(text, pattern, rule.prefixes);
    if (keys.length > 0) return keys;
  }
  return [];
}
/** The task keys `rule` reads from a PR's title, head branch and closing references. */
export function prKeys(
  rule: KeyRule,
  title: string,
  branch: string,
  refs: readonly ClosingRef[],
): string[] {
  switch (rule.type) {
    case 'prefixes':
      return ticketKeys(title, branch, rule.prefixes);
    case 'issues':
      return issueKeys(title, branch, refs, rule);
    case 'jira':
      return jiraKeys(title, branch, rule);
    default:
      return assertNever(rule);
  }
}
// A Mannequin is GitHub's placeholder for an imported user.
function reviewer(wire: ReviewerWire): { kind: ReviewerKind; id: string } {
  switch (wire.__typename) {
    case 'User':
    case 'Mannequin':
      return { kind: 'user', id: wire.login };
    case 'Bot':
      return { kind: 'bot', id: wire.login };
    case 'Team':
    case 'EnterpriseTeam':
      return { kind: 'team', id: wire.slug };
    default:
      return assertNever(wire);
  }
}
/**
 * `feedbackComplete` says whether the comments in `value`, with the `held` comments an earlier
 * poll read, reach back to the cursor or start.
 */
export function normalizePr(
  repo: string,
  value: unknown,
  rule: KeyRule,
  feedbackComplete: boolean,
  held: readonly PrFeedback[] = [],
): PrFacts {
  const wire = parseWire(prWire, value, 'Malformed GitHub PR response');
  const checks = latestChecks(wire.statusCheckRollup?.contexts.nodes ?? []);
  const state = wire.state === 'MERGED' ? 'merged' : wire.state === 'CLOSED' ? 'closed' : 'open';
  const mergeable =
    wire.mergeable === 'MERGEABLE'
      ? 'mergeable'
      : wire.mergeable === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const rawMerge = wire.mergeStateStatus.toLowerCase();
  const mergeState = (
    ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unstable'].includes(rawMerge)
      ? rawMerge
      : 'unknown'
  ) as PrFacts['mergeState'];
  const title = wire.title;
  const headBranch = wire.headRefName;
  const facts = {
    repo,
    number: wire.number,
    url: wire.url,
    title,
    author: wire.author?.login,
    headSha: wire.headRefOid,
    headBranch,
    state,
    draft: wire.isDraft,
    mergeable,
    mergeState,
    ...checks,
    reviews: latestReviews(wire.reviews.nodes),
    reviewThreads: wire.reviewThreads.nodes.map((node) => ({ resolved: node.isResolved })),
    reviewRequests: wire.reviewRequests.nodes.flatMap(({ requestedReviewer, asCodeOwner }) =>
      requestedReviewer === null ? [] : [{ ...reviewer(requestedReviewer), asCodeOwner }],
    ),
    ticketKeys: prKeys(rule, title, headBranch, closingRefs(wire.closingIssuesReferences)),
    updatedAt: wire.updatedAt,
    ...(state === 'merged' && wire.mergedAt !== null ? { mergedAt: wire.mergedAt } : {}),
    feedback: feedbackOf(wire.reviews.nodes, wire.comments.nodes, held),
    feedbackComplete,
  };
  const parsed = prFactsSchema.safeParse(facts);
  if (!parsed.success)
    throw new AdapterError('transient', 'Malformed GitHub PR facts', { cause: parsed.error });
  return parsed.data;
}
