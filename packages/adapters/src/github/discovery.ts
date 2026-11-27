import {
  defaultBranchFactSchema,
  sourceCursorSchema,
  type Batch,
  type SourceCursor,
} from '@spur-board/contracts';
import { z } from 'zod';
import { checkState, contextName, latestContexts } from './checks.ts';
import { DEFAULT_BRANCH_READS, type GraphError } from './client.ts';

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)));
// GitHub returns a null author for a deleted account.
export const discoveryNodeWire = z.object({
  number: z.int().positive(),
  state: z.string().optional(),
  updatedAt: timestamp,
  author: z.object({ login: z.string() }).nullable(),
});
export const baselineNodeWire = z.object({ updatedAt: timestamp });
type DiscoveryNode = z.output<typeof discoveryNodeWire>;
type BaselineNode = z.output<typeof baselineNodeWire>;

export interface Discovery {
  numbers: number[];
  states: Map<number, string | undefined>;
  cursor?: SourceCursor;
}
export function latestUpdatedAt(
  nodes: readonly BaselineNode[],
  previous: SourceCursor | undefined,
): SourceCursor | undefined {
  let high = previous;
  for (const node of nodes) {
    const updated = sourceCursorSchema.parse(node.updatedAt);
    if (high === undefined || Date.parse(updated) > Date.parse(high)) high = updated;
  }
  return high;
}
/** The high-water cursor is an ISO timestamp. Equal timestamps are revisited. */
export function discover(
  nodes: readonly DiscoveryNode[],
  previous: SourceCursor | undefined,
  login: string,
): Discovery {
  let high = previous;
  const numbers = new Set<number>();
  const states = new Map<number, string | undefined>();
  for (const node of nodes) {
    const updated = sourceCursorSchema.parse(node.updatedAt);
    const updatedMs = Date.parse(updated);
    if (high === undefined || updatedMs > Date.parse(high)) high = updated;
    if (previous !== undefined && updatedMs < Date.parse(previous)) continue;
    states.set(node.number, node.state);
    if (node.author?.login.toLowerCase() !== login.toLowerCase()) continue;
    numbers.add(node.number);
  }
  return { numbers: [...numbers], states, ...(high === undefined ? {} : { cursor: high }) };
}
/** Pages are sorted newest first; older nodes end the scan, while ties must be revisited. */
export function pastCursor(
  nodes: readonly Pick<DiscoveryNode, 'updatedAt'>[],
  previous: SourceCursor | undefined,
): boolean {
  const oldest = nodes.at(-1);
  if (previous === undefined || oldest === undefined) return false;
  return Date.parse(oldest.updatedAt) < Date.parse(previous);
}
export function nextPage(connection: {
  nodes: readonly unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}): string | undefined {
  const { hasNextPage, endCursor } = connection.pageInfo;
  if (!hasNextPage) return undefined;
  if (!endCursor) throw new Error('Malformed GitHub pagination');
  return endCursor;
}

const branchCheckRunWire = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullable(),
  detailsUrl: z.string().nullish(),
  checkSuite: z
    .object({
      createdAt: z.string(),
      workflowRun: z
        .object({ event: z.string(), workflow: z.object({ id: z.string().min(1) }) })
        .nullish(),
    })
    .nullish(),
});
const branchStatusWire = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  createdAt: z.string(),
  targetUrl: z.string().nullish(),
});
const branchContextWire = z.discriminatedUnion('__typename', [
  branchCheckRunWire,
  branchStatusWire,
]);
type BranchContext = z.output<typeof branchContextWire>;
const branchCommitWire = z.object({
  oid: z.string(),
  statusCheckRollup: z
    .object({
      contexts: z.object({
        nodes: z.array(branchContextWire),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .nullable(),
});
const branchParentsWire = z.object({ parents: z.object({ nodes: z.tuple([z.unknown()]) }) });
const parentRefWire = z.object({ target: z.looseObject({ oid: z.string() }) });
const defaultBranchWire = z.looseObject({
  defaultBranchRef: z.object({
    name: z.string(),
    target: branchCommitWire.extend({ __typename: z.literal('Commit') }),
  }),
});
// A commit status, or a check run of a push-triggered workflow.
function counted(node: BranchContext): boolean {
  return node.__typename === 'StatusContext' || node.checkSuite?.workflowRun?.event === 'push';
}
const PASSED = new Set(['success', 'neutral', 'skipped']);
const RUNNING = new Set(['pending', 'expected']);

export function branchScoped(error: GraphError): boolean {
  return (
    error.path?.[0] === 'repository' &&
    DEFAULT_BRANCH_READS.some((alias) => error.path?.[1] === alias)
  );
}

function readBranchParent(reference: unknown, tip: string, depth: number): unknown {
  const parsed = parentRefWire.safeParse(reference);
  if (!parsed.success || parsed.data.target.oid !== tip) return undefined;
  let commit: unknown = parsed.data.target;
  for (let hop = 0; hop < depth; hop += 1)
    commit = branchParentsWire.safeParse(commit).data?.parents.nodes[0];
  return commit;
}

/**
 * The colour of the newest checked commit in the default branch's first-parent window. Walk
 * past a commit only when it has no counted checks. Without a visible failure, a running or
 * incompletely read commit leaves the colour unknown.
 */
export function defaultBranchFact(
  repository: unknown,
  errors: readonly GraphError[],
): Batch['defaultBranch'] {
  const parsed = defaultBranchWire.safeParse(repository);
  if (!parsed.success) return undefined;
  const { name: branch, target } = parsed.data.defaultBranchRef;
  for (const [depth, alias] of DEFAULT_BRANCH_READS.entries()) {
    if (errors.some((error) => error.path?.[1] === alias)) return undefined;
    const commit = depth === 0 ? target : readBranchParent(parsed.data[alias], target.oid, depth);
    const result = branchCommitWire.safeParse(commit);
    if (!result.success) return undefined;
    const { oid, statusCheckRollup } = result.data;
    const contexts = statusCheckRollup?.contexts;
    const kept = contexts?.nodes.filter(counted) ?? [];
    const truncated = contexts?.pageInfo.hasNextPage ?? false;
    if (kept.length > 0 || truncated) return branchColour(branch, oid, kept, truncated);
  }
  return undefined;
}

function branchColour(
  branch: string,
  sha: string,
  nodes: BranchContext[],
  truncated: boolean,
): Batch['defaultBranch'] {
  const kept = latestContexts(nodes).map((node) => ({
    check: contextName(node),
    node,
    state: checkState(node),
  }));
  const failing = kept.find(({ state }) => !PASSED.has(state) && !RUNNING.has(state));
  if (failing !== undefined) {
    const { check, node } = failing;
    const url = (node.__typename === 'StatusContext' ? node.targetUrl : node.detailsUrl) ?? null;
    const red = { state: 'red', branch, sha, check, url };
    const fact = defaultBranchFactSchema.safeParse(red);
    if (fact.success) return fact.data;
    return url === null ? undefined : defaultBranchFactSchema.safeParse({ ...red, url: null }).data;
  }
  if (truncated || kept.some(({ state }) => !PASSED.has(state))) return undefined;
  return defaultBranchFactSchema.safeParse({ state: 'green', branch, sha }).data;
}
