// Check runs and commit statuses on a commit, and which run of each check counts.
import type { PrFacts } from '@spur-board/contracts';
import { z } from 'zod';

// `event` is optional only so the committed live recordings, which never select it, still replay.
const workflowRunWire = z.object({
  event: z.string().nullish(),
  workflow: z.object({ id: z.string().min(1) }),
});
const checkRunWire = z
  .object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullish(),
    completedAt: z.string().nullable(),
    // `databaseId`, `workflowRun` and `app` are optional only so the committed live recordings
    // still replay.
    checkSuite: z
      .object({
        databaseId: z.number().int().nullish(),
        createdAt: z.string(),
        workflowRun: workflowRunWire.nullish(),
        app: z.object({ id: z.string().min(1) }).nullish(),
      })
      .nullish(),
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
export const contextWire = z.discriminatedUnion('__typename', [checkRunWire, statusContextWire]);
export type ContextWire = z.output<typeof contextWire>;

/** The contracts check state of a check run or commit status. */
export function checkState(node: ContextWire): PrFacts['checks'][number]['state'] {
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
/** When a context ran, to keep the latest of each check; an empty string sorts first. */
function contextAt(node: ContextWire): string {
  return node.__typename === 'StatusContext'
    ? node.createdAt
    : (node.startedAt ?? node.checkSuite?.createdAt ?? node.completedAt ?? '');
}
/** The display name of a check run or commit status. */
export function contextName(node: ContextWire): string {
  return node.__typename === 'StatusContext' ? node.context : node.name;
}
/**
 * Only reruns of one check replace each other: a commit status by its context, an Actions check
 * run by its workflow and job name, another check run by its app and name. A check run with
 * neither, as in the older recordings, falls back to its name.
 */
function checkKey(node: ContextWire): string {
  if (node.__typename === 'StatusContext') return `status:${node.context}`;
  const workflow = node.checkSuite?.workflowRun?.workflow.id;
  if (workflow !== undefined) return `check:${workflow}:${node.name}`;
  const app = node.checkSuite?.app?.id;
  return app === undefined ? `name:${node.name}` : `app:${app}:${node.name}`;
}
/**
 * The latest node of each check (see `checkKey`), sorted by display name, then key. Of two runs
 * with one time the later node wins.
 */
export function latestContexts<T extends ContextWire>(nodes: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const node of nodes) {
    const key = checkKey(node);
    const old = latest.get(key);
    if (old !== undefined && contextAt(old) > contextAt(node)) continue;
    latest.set(key, node);
  }
  return [...latest.entries()]
    .sort(([a, x], [b, y]) => contextName(x).localeCompare(contextName(y)) || a.localeCompare(b))
    .map(([, node]) => node);
}

/**
 * The head commit's check suites, read in the PR detail query. Actions creates a suite for each
 * workflow run when the run starts, before its jobs create check runs. A denied suite arrives as
 * a null node; a denied list or commit, or a list without nodes, arrives as null.
 */
export const suiteListWire = z
  .object({
    checkSuites: z
      .object({
        nodes: z
          .array(
            z
              .object({
                databaseId: z.number().int().nullish(),
                status: z.string(),
                createdAt: z.string(),
                workflowRun: workflowRunWire.nullable(),
              })
              .nullable(),
          )
          .nullable(),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      })
      .nullable(),
  })
  .nullish();
export type SuiteListWire = z.output<typeof suiteListWire>;
// A suite of one workflow and event; `status` is known only from the suite list.
interface Suite {
  at: number;
  id: number | null;
  status: string | undefined;
}
/**
 * What decides a required check run that reads skipped, as `latestContexts` keeps it. Of the
 * head's suites of its workflow and trigger event, from the suite list and the check runs, only
 * the newest decides, by creation time, then `databaseId`: its run of the same check (see
 * `checkKey`) counts, finished or not; without one the check is `pending` until that suite
 * completes, then the skip stands. Older suites never decide, and a run of another event, such as
 * a manual dispatch, is not one of them. A missing, denied or truncated suite list, a missing
 * event, a time that does not parse, or a newest place `databaseId` cannot break, decides nothing.
 */
export function skipDecision(
  node: ContextWire,
  nodes: readonly ContextWire[],
  commit: SuiteListWire,
): ContextWire | 'pending' | undefined {
  if (node.__typename !== 'CheckRun' || node.isRequired !== true) return undefined;
  if (checkState(node) !== 'skipped') return undefined;
  const run = node.checkSuite?.workflowRun;
  const event = run?.event;
  const list = commit?.checkSuites;
  if (!run || !event || !list?.nodes || list.pageInfo.hasNextPage) return undefined;
  const ofRun = (wire: z.output<typeof workflowRunWire> | null | undefined): boolean =>
    wire?.workflow.id === run.workflow.id && wire.event === event;
  // One entry per suite id; a suite without an id may be listed twice and then ties.
  const suites: Suite[] = [];
  const byId = new Map<number, Suite>();
  const add = (createdAt: string, id: number | null | undefined, status?: string): void => {
    const known = id == null ? undefined : byId.get(id);
    if (known !== undefined) {
      known.status ??= status;
      return;
    }
    const suite = { at: Date.parse(createdAt), id: id ?? null, status };
    suites.push(suite);
    if (suite.id !== null) byId.set(suite.id, suite);
  };
  for (const suite of list.nodes)
    if (suite !== null && ofRun(suite.workflowRun))
      add(suite.createdAt, suite.databaseId, suite.status);
  for (const other of nodes)
    if (other.__typename === 'CheckRun' && other.checkSuite && ofRun(other.checkSuite.workflowRun))
      add(other.checkSuite.createdAt, other.checkSuite.databaseId);
  if (suites.some((suite) => Number.isNaN(suite.at))) return undefined;
  suites.sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));
  const newest = suites.at(-1);
  if (newest === undefined) return undefined;
  const tied = suites.filter((suite) => suite.at === newest.at);
  if (tied.length > 1 && tied.some((suite) => suite.id === null)) return undefined;
  const key = checkKey(node);
  const [decider] = latestContexts(
    nodes.filter(
      (other) =>
        other.__typename === 'CheckRun' &&
        newest.id !== null &&
        other.checkSuite?.databaseId === newest.id &&
        checkKey(other) === key,
    ),
  );
  if (decider !== undefined) return decider;
  if (newest.status === undefined || newest.status === 'COMPLETED') return undefined;
  return 'pending';
}
