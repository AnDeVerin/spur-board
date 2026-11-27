import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { expect, it } from 'vitest';
import { githubSources } from '../../adapters/src/github/index.ts';
import {
  createObservationCore,
  createOperationRegistry,
  openStore,
  type getStatus,
} from '../../core/src/index.ts';
import { dispatchOperation } from '../../core/src/app/operations.ts';
import fixture from './fixtures/default-branch.json' with { type: 'json' };

const repo = 'demo/widgets';
const source = `github:demo:${repo}`;
const key = `default-branch:${source}`;
const config = configSchema.parse({
  projects: [
    {
      id: 'demo',
      tracker: { type: 'github-issues', repo, label: 'demo' },
      repos: [repo],
      operatorGithubLogin: 'operator',
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

// Issue #926: GitHub's ci-ok and release-only analysis responses, projected to the
// target repository's aggregate check with repository names and IDs replaced.
type Sample = typeof fixture.red;
const runUrl = ({ job }: Sample) => `https://github.example.test/${repo}/actions/runs/${job}`;
function commit(sample: Sample) {
  const { oid, name, event, conclusion, createdAt, startedAt, completedAt } = sample;
  return {
    __typename: 'Commit',
    oid,
    checkSuites: { nodes: [{ workflowRun: { event } }], pageInfo: { hasNextPage: false } },
    statusCheckRollup: {
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name,
            conclusion,
            status: 'COMPLETED',
            startedAt,
            completedAt,
            detailsUrl: runUrl(sample),
            checkSuite: { createdAt, workflowRun: { event, workflow: { id: event } } },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  };
}

function branchResponse(sample: Sample, parent?: Sample) {
  return {
    defaultBranchRef: { name: 'main', target: commit(sample) },
    defaultBranchParent1: {
      target: { oid: sample.oid, parents: { nodes: parent === undefined ? [] : [commit(parent)] } },
    },
  };
}

it.each([true, false])(
  'replays default-branch CI from red through a rerun and a later failure (read rerun on head: %s)',
  async (readRerunOnHead) => {
    const { red, rerun, release, nextRed, green, finalRelease } = fixture;
    let branch = branchResponse(red);
    let at = Date.parse(red.completedAt);
    const clock = { now: () => at };
    const gh = githubSources(config, {
      token: 'test',
      now: clock.now,
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: {
              rateLimit: { remaining: 90, resetAt: '2026-11-28T00:00:00Z' },
              repository: {
                pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                mergedBaseline: { nodes: [] },
                ...branch,
              },
            },
          }),
        ),
    })[0];
    if (gh === undefined) throw new Error('Missing GitHub adapter');

    const dir = mkdtempSync(join(tmpdir(), 'board-default-branch-'));
    const store = openStore(join(dir, 'board.db'));
    try {
      const core = createObservationCore({ store, config, clock });
      const registry = createOperationRegistry({
        config,
        clock,
        completeSince: core.completeSince,
      });
      const dispatch = { store, config, clock, registry };
      const signal = new AbortController().signal;
      const poll = async (after: Sample, parent?: Sample) => {
        branch = branchResponse(after, parent);
        at = Date.parse(after.completedAt) + 1000;
        const batch = await gh.adapter.poll({ ...(await core.context(source)), signal });
        expect(batch.complete).toBe(true);
        await core.observe(source, {
          batch,
          effectiveComplete: true,
          state: { lastCompleteAt: batch.observedAt, gone: [] },
          outcomes: [],
        });
        return batch.observedAt;
      };
      const views = async (state: 'red' | 'green', sample: Sample, confirmedAt: string) => {
        const status = (await dispatchOperation(dispatch, 'status.get', {}, 'operator')) as Awaited<
          ReturnType<typeof getStatus>
        >;
        expect(status.sources.find((row) => row.source === source)?.defaultBranch).toMatchObject({
          state,
          sha: sample.oid,
          confirmedAt,
          check: state === 'red' ? sample.name : null,
          url: state === 'red' ? runUrl(sample) : null,
        });
        const inbox = (await dispatchOperation(dispatch, 'inbox.operator', {}, 'operator')) as {
          items: { text: string; url?: string }[];
        };
        const open = inbox.items.filter(({ text }) => text.startsWith(`${repo}: main`));
        expect(status.items.some((item) => item.key === key)).toBe(state === 'red');
        expect(open).toHaveLength(state === 'red' ? 1 : 0);
        if (state === 'green') return;
        expect(open[0]?.text).toContain(`red since ${sample.oid.slice(0, 7)} (ci-ok)`);
        expect(open[0]?.url).toBe(runUrl(sample));
      };

      await views('red', red, await poll(red));
      if (readRerunOnHead) await views('green', rerun, await poll(rerun));
      await views('green', rerun, await poll(release, rerun));
      await views('red', nextRed, await poll(nextRed));
      await views('green', green, await poll(green));
      await views('green', green, await poll(finalRelease, green));
    } finally {
      await store.close();
      rmSync(dir, { recursive: true });
    }
  },
);
