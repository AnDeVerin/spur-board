import {
  defaultBranchFactSchema,
  sourceCursorSchema,
  type Batch,
  type SourceCursor,
} from '@spur-board/contracts';
import { z } from 'zod';
import { checkState, contextAt } from './prBatch.ts';

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
// A null ref, a target that is not a commit or a null rollup fails this parse: no fact.
const defaultBranchWire = z.object({
  defaultBranchRef: z.object({
    name: z.string(),
    target: z.object({
      __typename: z.literal('Commit'),
      oid: z.string(),
      statusCheckRollup: z.object({
        contexts: z.object({
          nodes: z.array(branchContextWire),
          pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      }),
    }),
  }),
});
/**
 * Only reruns of one check replace each other: a commit status by its context, a check run by
 * its workflow and job name. A check run outside a push-triggered workflow has no key.
 */
function checkKey(node: BranchContext): string | undefined {
  if (node.__typename === 'StatusContext') return `status:${node.context}`;
  const run = node.checkSuite?.workflowRun;
  if (run?.event !== 'push') return undefined;
  return `check:${run.workflow.id}:${node.name}`;
}
const PASSED = new Set(['success', 'neutral', 'skipped']);
const RUNNING = new Set(['pending', 'expected']);

/**
 * The colour of the default-branch head in a discovery response's `repository`, or undefined
 * when it is unknown: an unexpected shape, a running head, no counted check, or a truncated page
 * with no failure in it. Only check runs of push-triggered workflows and commit statuses count;
 * the latest run of each check decides (see `checkKey`). A run URL that is not http(s) becomes null.
 */
export function defaultBranchFact(repository: unknown): Batch['defaultBranch'] {
  const parsed = defaultBranchWire.safeParse(repository);
  if (!parsed.success) return undefined;
  const { name: branch, target } = parsed.data.defaultBranchRef;
  const { nodes, pageInfo } = target.statusCheckRollup.contexts;
  const latest = new Map<string, { check: string; node: BranchContext }>();
  for (const node of nodes) {
    const key = checkKey(node);
    if (key === undefined) continue;
    const old = latest.get(key);
    if (old !== undefined && contextAt(old.node) > contextAt(node)) continue;
    latest.set(key, {
      check: node.__typename === 'StatusContext' ? node.context : node.name,
      node,
    });
  }
  const kept = [...latest.entries()]
    .sort(([a, x], [b, y]) => x.check.localeCompare(y.check) || a.localeCompare(b))
    .map(([, { check, node }]) => ({ check, node, state: checkState(node) }));
  const failing = kept.find(({ state }) => !PASSED.has(state) && !RUNNING.has(state));
  if (failing !== undefined) {
    const { check, node } = failing;
    const url = (node.__typename === 'StatusContext' ? node.targetUrl : node.detailsUrl) ?? null;
    const red = { state: 'red', branch, sha: target.oid, check, url };
    const fact = defaultBranchFactSchema.safeParse(red);
    if (fact.success) return fact.data;
    return url === null ? undefined : defaultBranchFactSchema.safeParse({ ...red, url: null }).data;
  }
  if (kept.length === 0 || pageInfo.hasNextPage || kept.some(({ state }) => !PASSED.has(state)))
    return undefined;
  return defaultBranchFactSchema.safeParse({ state: 'green', branch, sha: target.oid }).data;
}
