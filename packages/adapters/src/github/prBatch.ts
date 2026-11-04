import { AdapterError, prFactsSchema, type PrFacts } from '@spur-board/contracts';
import { connectionNodes, record, string, type Json, type RecordValue } from './client.ts';

function lower(value: Json | undefined): string {
  return string(value).toLowerCase();
}
function optionalLogin(value: Json | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const login = record(value).login;
  return typeof login === 'string' ? login : undefined;
}
function checkState(node: RecordValue): PrFacts['checks'][number]['state'] {
  if (node.__typename === 'StatusContext') {
    const state = lower(node.state);
    return state === 'success'
      ? 'success'
      : state === 'pending'
        ? 'pending'
        : state === 'expected'
          ? 'expected'
          : 'failure';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  const value = lower(node.conclusion);
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
function latestChecks(nodes: RecordValue[]): {
  checks: PrFacts['checks'];
  requiredChecks: PrFacts['requiredChecks'];
} {
  const latest = new Map<
    string,
    { check: PrFacts['checks'][number]; required: boolean; at: string }
  >();
  for (const node of nodes) {
    const name = string(node.__typename === 'StatusContext' ? node.context : node.name);
    const completedAt =
      node.__typename === 'StatusContext'
        ? null
        : node.completedAt === null
          ? null
          : string(node.completedAt);
    const startedAt = node.startedAt;
    const suite = node.checkSuite;
    const at =
      node.__typename === 'StatusContext'
        ? string(node.createdAt)
        : typeof startedAt === 'string'
          ? startedAt
          : suite === null || suite === undefined
            ? (completedAt ?? '')
            : string(record(suite).createdAt);
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
function latestReviews(nodes: RecordValue[]): PrFacts['reviews'] {
  const latest = new Map<string, PrFacts['reviews'][number]>();
  for (const node of nodes) {
    const reviewer = optionalLogin(node.author);
    if (!reviewer || node.submittedAt === null || node.submittedAt === undefined) continue;
    const state = lower(node.state);
    if (!['approved', 'changes_requested', 'dismissed'].includes(state)) continue;
    const review = {
      reviewer,
      state,
      commitSha: string(record(node.commit).oid),
      submittedAt: string(node.submittedAt),
    } as PrFacts['reviews'][number];
    const old = latest.get(reviewer);
    if (old === undefined || old.submittedAt <= review.submittedAt) latest.set(reviewer, review);
  }
  return [...latest.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}
export function ticketKeys(title: string, branch: string, prefixes: readonly string[]): string[] {
  const keys = new Set<string>();
  const allowed = new Set(prefixes);
  for (const match of `${title} ${branch}`.matchAll(
    /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)-([1-9][0-9]*)(?![A-Za-z0-9_])/gi,
  )) {
    const prefix = match[1]?.toUpperCase();
    const number = match[2];
    if (prefix !== undefined && number !== undefined && allowed.has(prefix))
      keys.add(`${prefix}-${number}`);
  }
  return [...keys];
}
export function normalizePr(repo: string, wire: RecordValue, prefixes: readonly string[]): PrFacts {
  const rollupValue = wire.statusCheckRollup;
  const rollup = rollupValue === null || rollupValue === undefined ? null : record(rollupValue);
  const checks = latestChecks(rollup === null ? [] : connectionNodes(record(rollup).contexts));
  const state = wire.state === 'MERGED' ? 'merged' : wire.state === 'CLOSED' ? 'closed' : 'open';
  const mergeable =
    wire.mergeable === 'MERGEABLE'
      ? 'mergeable'
      : wire.mergeable === 'CONFLICTING'
        ? 'conflicting'
        : 'unknown';
  const rawMerge = lower(wire.mergeStateStatus);
  const mergeState = (
    ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unstable'].includes(rawMerge)
      ? rawMerge
      : 'unknown'
  ) as PrFacts['mergeState'];
  const title = string(wire.title);
  const headBranch = string(wire.headRefName);
  const facts = {
    repo,
    number: wire.number,
    url: wire.url,
    title,
    author: optionalLogin(wire.author),
    headSha: wire.headRefOid,
    headBranch,
    state,
    draft: wire.isDraft,
    mergeable,
    mergeState,
    ...checks,
    reviews: latestReviews(connectionNodes(wire.reviews)),
    reviewThreads: connectionNodes(wire.reviewThreads).map((node) => ({
      resolved: node.isResolved,
    })),
    reviewRequests: connectionNodes(wire.reviewRequests).map((node) => {
      const reviewer = record(node.requestedReviewer);
      return { reviewer: reviewer.login ?? reviewer.name, asCodeOwner: node.asCodeOwner };
    }),
    ticketKeys: ticketKeys(title, headBranch, prefixes),
    updatedAt: wire.updatedAt,
  };
  const parsed = prFactsSchema.safeParse(facts);
  if (!parsed.success)
    throw new AdapterError('transient', 'Malformed GitHub PR facts', { cause: parsed.error });
  return parsed.data;
}
