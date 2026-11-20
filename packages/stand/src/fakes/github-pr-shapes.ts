// The GraphQL request shapes the stand's GitHub PR fake answers.
import { canonicalizeQuery } from './graphql.ts';

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
  'id isResolved isOutdated comments(last: 100) { nodes { id url lastEditedAt pullRequestReview { id } } }';
const CLOSING_FIELDS = `nodes { number repository { nameWithOwner } } ${PAGE_INFO}`;
const DISCOVERY_FIELDS = `nodes { number updatedAt author { login } state } ${PAGE_INFO}`;
const RATE_LIMIT = 'rateLimit { cost limit remaining resetAt }';
const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}';
// The workflow or app of a PR check run; the committed recordings select neither.
const SUITE_SOURCE = ' workflowRun { workflow { id } } app { id }';
const contextNodes = (number: string): string =>
  `nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt checkSuite { createdAt${SUITE_SOURCE} } isRequired(pullRequestNumber: ${number}) } ... on StatusContext { __typename context state createdAt isRequired(pullRequestNumber: ${number}) } }`;
const prAlias = (closing: boolean): string =>
  `pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { id number url title updatedAt mergedAt closedAt state isDraft mergeable mergeStateStatus author { login } headRefName headRefOid statusCheckRollup { contexts(first: 100) { ${contextNodes('1')} ${PAGE_INFO} } } reviews(first: 100) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} } comments(last: 100) { ${COMMENT_FIELDS} } reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} } reviewRequests(first: 100) { nodes { ${REVIEWER_FIELDS} } ${PAGE_INFO} }${closing ? ` closingIssuesReferences(first: 100) { ${CLOSING_FIELDS} }` : ''} } }`;
const DEFAULT_BRANCH = `defaultBranchRef { name target { __typename ... on Commit { oid statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { __typename name status conclusion startedAt completedAt detailsUrl checkSuite { createdAt workflowRun { event workflow { id } } } } ... on StatusContext { __typename context state createdAt targetUrl } } pageInfo { hasNextPage } } } } } }`;
const prBatch = (states: string, baseline: string): string =>
  `query PrBatch($owner: String!, $repo: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} }${baseline} ${DEFAULT_BRANCH} } }`;
const PR_INDEX = `query PrIndex($owner: String!, $repo: String!) { ${RATE_LIMIT} pr0: repository(owner: $owner, name: $repo) { pullRequest(number: 1) { number updatedAt state isDraft mergeable mergeStateStatus headRefOid statusCheckRollup { state contexts(first: 100) { totalCount nodes { ... on CheckRun { __typename name status conclusion completedAt } ... on StatusContext { __typename context state } } } } reviews(first: 100) { totalCount nodes { id state lastEditedAt } } reviewThreads(first: 100) { totalCount nodes { isResolved } } reviewRequests(first: 100) { totalCount nodes { ${REVIEWER_FIELDS} } } comments(last: 1) { totalCount nodes { id } } edited: comments(first: 1, ${ORDER}) { nodes { id updatedAt } } } } }`;
const prDetails = (closing: boolean): string =>
  `query PrDetails($owner: String!, $repo: String!) { ${RATE_LIMIT} ${prAlias(closing)} }`;
const prPage = (field: string, cursor = 'after'): string =>
  `query PrPage($owner: String!, $repo: String!, $number: Int!, $${cursor}: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${field} } } }`;
const discoveryPage = (states: string): string =>
  `query DiscoveryPage($owner: String!, $repo: String!, $after: String!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequests(first: 100, after: $after, states: [${states}], ${ORDER}) { ${DISCOVERY_FIELDS} } } }`;
const TREE = 'tree { entries { name type mode oid } }';
const PR_COMMITS = `query PrCommits($owner: String!, $repo: String!, $number: Int!) { ${RATE_LIMIT} repository(owner: $owner, name: $repo) { pullRequest(number: $number) { commits(last: 100) { totalCount pageInfo { hasPreviousPage } nodes { commit { oid ${TREE} parents(first: 100) { totalCount nodes { oid ${TREE} } } } } } } } }`;
// The ready-for-dev mirror's read of a Project's Status and the Project items of open issues.
const PROJECT_MIRROR = `query ProjectMirror($owner: String!, $repo: String!, $projectOwner: String!, $number: Int!, $field: String!) { ${RATE_LIMIT} repositoryOwner(login: $projectOwner) { ... on ProjectV2Owner { projectV2(number: $number) { id title field(name: $field) { __typename ... on ProjectV2SingleSelectField { id options { id name } } } } } } repository(owner: $owner, name: $repo) { issues(first: 100, states: [OPEN]) { pageInfo { hasNextPage } nodes { number projectItems(first: 20, includeArchived: true) { pageInfo { hasNextPage } nodes { isArchived project { id } fieldValueByName(name: $field) { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId } } } } } } } }`;
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
  PR_COMMITS,
  PROJECT_MIRROR,
];
// Keep exact legacy shapes for the committed live recordings, which select neither the cost and
// limit, a comment body, links and edits, a thread's id, outdated flag and inline comments, a
// check run's workflow or app, nor the default branch; none is inferred.
const legacy = (query: string): string =>
  query
    .replace(` ${DEFAULT_BRANCH}`, '')
    .replaceAll(SUITE_SOURCE, '')
    .replace('cost limit remaining', 'remaining')
    .replaceAll('createdAt body url lastEditedAt }', 'createdAt }')
    .replaceAll('submittedAt url lastEditedAt', 'submittedAt')
    .replaceAll(THREAD_FIELDS, 'isResolved')
    .replace('nodes { id state lastEditedAt }', 'nodes { id state }')
    .replace(` edited: comments(first: 1, ${ORDER}) { nodes { id updatedAt } }`, '');
export const KNOWN_SHAPES = new Set(
  KNOWN_DOCUMENTS.flatMap((query) => [canonicalizeQuery(query), canonicalizeQuery(legacy(query))]),
);

/** Whether a query text is one of the shapes this fake answers. */
export function isKnownShape(query: string): boolean {
  return KNOWN_SHAPES.has(canonicalizeQuery(query));
}
