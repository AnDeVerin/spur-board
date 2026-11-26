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
    // `workflowRun` and `app` are optional only so the committed live recordings still replay.
    checkSuite: z
      .object({
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
 * a null node; a denied list or commit arrives as null.
 */
export const suiteListWire = z
  .object({
    checkSuites: z
      .object({
        nodes: z.array(
          z
            .object({
              status: z.string(),
              createdAt: z.string(),
              workflowRun: workflowRunWire.nullable(),
            })
            .nullable(),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      })
      .nullable(),
  })
  .nullish();
export type SuiteListWire = z.output<typeof suiteListWire>;
/**
 * Whether a required check run skipped in one run of its workflow may still run: the head has a
 * suite of the same workflow and trigger event created after the skipped run's suite and not yet
 * completed. A run of another event, such as a manual dispatch of a workflow whose skipped job
 * runs only on pull requests, cannot produce the check. A missing or truncated suite list, a
 * missing event, or a time that does not parse, says no.
 */
export function awaitsNewerRun(node: ContextWire, commit: SuiteListWire): boolean {
  if (node.__typename !== 'CheckRun' || node.isRequired !== true) return false;
  if (checkState(node) !== 'skipped') return false;
  const run = node.checkSuite?.workflowRun;
  const event = run?.event;
  const suites = commit?.checkSuites;
  if (!node.checkSuite || !run || !event || !suites || suites.pageInfo.hasNextPage) return false;
  const skippedAt = Date.parse(node.checkSuite.createdAt);
  if (Number.isNaN(skippedAt)) return false;
  return suites.nodes.some(
    (suite) =>
      suite !== null &&
      suite.workflowRun?.workflow.id === run.workflow.id &&
      suite.workflowRun.event === event &&
      suite.status !== 'COMPLETED' &&
      Date.parse(suite.createdAt) > skippedAt,
  );
}
