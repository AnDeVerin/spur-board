// Approval freshness on the Ready to Merge card: the dispatcher flow whose PR #1 carries seeded
// approvals on older commits, so `status.get` lists `prSummary[].approvals` in each state.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { check, entities, flow, ISSUE, PR, STEP_MS, toReadyToMerge } from './dispatcher.ts';
import { settledUnless } from './helpers.ts';
import type { Board, Scenario } from './index.ts';

const A = 'a'.repeat(40);
const WATCH = ['back/', 'front/'];
const REVIEWER = 'stand-reviewer';
const SECOND = 'stand-reviewer-2';

/** A commit oid of the seeded history, never A. */
const oid = (name: string) => createHash('sha1').update(`approval-${name}`).digest('hex');
/** The base-branch commit the PR history starts on; never listed. */
const BASE = oid('base');
/** The approved commit, listed first unless the history was rewritten. */
const APPROVED = oid('approved');

type Commit = { oid: string; parents: string[]; changed: string[] };
/** APPROVED on BASE, then one commit per `changed` entry list, the last one at A. */
function history(changes: string[][], start = APPROVED): Commit[] {
  const oids = changes.map((_, i) => (i === changes.length - 1 ? A : oid(`c${String(i)}`)));
  return [
    { oid: start, parents: [BASE], changed: [] },
    ...changes.map((changed, i) => ({
      oid: oids[i] ?? A,
      parents: [i === 0 ? start : (oids[i - 1] ?? start)],
      changed,
    })),
  ];
}

const counted = (commitsAfter: number, changedAfter: string[], watchedAfter: string[]) => ({
  onHead: false,
  commitsAfter,
  changedAfter,
  watchedAfter,
});

interface Case {
  name: string;
  summary: string;
  watch: boolean;
  commits: Commit[];
  /** Approvals besides the reviewer's on APPROVED, each `[login, sha]`. */
  approvals?: [string, string][];
  approved?: string;
  expected: Record<string, unknown>[];
}

/** The approvals of PR #1 that `status.get` lists for the flow task. */
async function approvalsOf(board: Board): Promise<unknown> {
  const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
  return tasks
    .find(({ key }) => key === ISSUE)
    ?.prSummary?.find(({ repo, number }) => `${repo}#${String(number)}` === PR)?.approvals;
}

function approvalScenario(spec: Case): Scenario {
  const { stand } = flow();
  return {
    name: spec.name,
    summary: `${ISSUE} waits in Ready to Merge on head A; ${spec.summary}`,
    config: {
      stand: { ...stand, ...(spec.watch ? { approvalWatch: WATCH } : {}) },
    },
    async seed(board, fakes, clock) {
      const at = new Date(clock.now()).toISOString();
      const review = ([login, sha]: [string, string]) => ({
        author: { __typename: 'User', login },
        state: 'APPROVED',
        commit: { oid: sha },
        submittedAt: at,
      });
      const approvals: [string, string][] = [
        [REVIEWER, spec.approved ?? APPROVED],
        ...(spec.approvals ?? []),
      ];
      const turn = await toReadyToMerge(board, fakes, {
        commits: spec.commits,
        reviews: approvals.map(review),
      });
      // PR commits are read only once core asks for them: poll until the facts arrive.
      let polls = 0;
      await board.until(`approvals of ${PR}`, STEP_MS * 2, async () => {
        await board.poll();
        polls++;
        return polls >= 2 && isDeepStrictEqual(await approvalsOf(board), spec.expected);
      });
      return entities(board, { items: { turn } });
    },
    async settled({ board }) {
      const problems = await check(board, { column: 'ready-to-merge' });
      const approvals = await approvalsOf(board);
      if (!isDeepStrictEqual(approvals, spec.expected))
        problems.push(
          `approvals ${JSON.stringify(approvals)}, not ${JSON.stringify(spec.expected)}`,
        );
      return settledUnless(problems);
    },
  };
}

export const approvalStale = approvalScenario({
  name: 'approval-stale',
  summary: `${REVIEWER} approved a commit before 3 that change back/, docs/ and front/ (watched: back/, front/).`,
  watch: true,
  commits: history([['back/'], ['docs/'], ['front/']]),
  expected: [
    {
      author: REVIEWER,
      sha: APPROVED,
      ...counted(3, ['back/', 'docs/', 'front/'], ['back/', 'front/']),
    },
  ],
});

export const approvalStaleQuiet = approvalScenario({
  name: 'approval-stale-quiet',
  summary: `${REVIEWER} approved a commit before 2 that change docs/ only (watched: back/, front/).`,
  watch: true,
  commits: history([['docs/'], ['docs/']]),
  expected: [{ author: REVIEWER, sha: APPROVED, ...counted(2, ['docs/'], []) }],
});

export const approvalMulti = approvalScenario({
  name: 'approval-multi',
  summary: `${REVIEWER} approved a commit before 4 that change back/, and ${SECOND} approved A.`,
  watch: true,
  commits: history([['back/'], ['back/'], ['back/'], ['back/']]),
  approvals: [[SECOND, A]],
  expected: [
    { author: REVIEWER, sha: APPROVED, ...counted(4, ['back/'], ['back/']) },
    { author: SECOND, sha: A, onHead: true, commitsAfter: 0, changedAfter: [], watchedAfter: [] },
  ],
});

// The approved commit is neither listed nor a parent of a listed one: a rewritten history.
const REWRITTEN = oid('rewritten');
export const approvalRewritten = approvalScenario({
  name: 'approval-rewritten',
  summary: `${REVIEWER} approved a commit that the head history no longer holds.`,
  watch: true,
  commits: history([['back/']], oid('new-start')),
  approved: REWRITTEN,
  expected: [{ author: REVIEWER, sha: REWRITTEN, onHead: false, notCounted: 'history_rewritten' }],
});

export const approvalUncounted = approvalScenario({
  name: 'approval-uncounted',
  summary: `${REVIEWER} approved a commit of a PR with 101 commits, too large to compare.`,
  watch: true,
  commits: history(Array.from({ length: 100 }, () => ['docs/'])),
  expected: [{ author: REVIEWER, sha: APPROVED, onHead: false, notCounted: 'pr_too_large' }],
});

const SIX = ['api/', 'back/', 'docs/', 'front/', 'infra/', 'web/'];
export const approvalStaleNoWatch = approvalScenario({
  name: 'approval-stale-no-watch',
  summary: `${REVIEWER} approved a commit before 1 that changes six root entries, with no approvalWatch.`,
  watch: false,
  commits: history([SIX]),
  expected: [{ author: REVIEWER, sha: APPROVED, ...counted(1, SIX, SIX) }],
});
