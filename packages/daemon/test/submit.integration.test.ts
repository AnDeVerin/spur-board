import { err, ok, type PrFacts, type PrPoller } from '@spur-board/contracts';
import { afterEach, expect, it } from 'vitest';
import { createE2eHarness } from './e2e-harness.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SOURCE = 'github:proj:example/repo';
const AT = '2026-11-04T08:00:00.000Z';

type Harness = Awaited<ReturnType<typeof createE2eHarness>>;
const active: Harness[] = [];
afterEach(async () => {
  for (const harness of active.splice(0)) await harness.dispose();
});

function prFact(headSha: string): PrFacts {
  return {
    repo: 'example/repo',
    number: 7,
    url: 'https://github.com/example/repo/pull/7',
    title: 'Work',
    author: 'worker',
    headSha,
    headBranch: 'work',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: [],
    updatedAt: AT,
  };
}

it('submits through the daemon after the injected pollPr confirms the head', async () => {
  let answer: 'commit-b' | 'timeout' = 'commit-b';
  const calls: Parameters<PrPoller['pollPr']>[] = [];
  const harness = await createE2eHarness({
    startAdapters: (_config, core) => ({
      stop: () => Promise.resolve(),
      async pollPr(...args) {
        calls.push(args);
        if (answer === 'timeout') return err({ kind: 'timeout', message: 'GitHub timed out' });
        await core.observe(SOURCE, {
          batch: {
            source: SOURCE,
            observedAt: AT,
            complete: false,
            items: [{ kind: 'pr', facts: prFact(B) }],
            entities: [],
          },
          effectiveComplete: false,
          state: { gone: [] },
          outcomes: [],
        });
        return ok({ status: 'ok', facts: prFact(B), observedAt: AT });
      },
    }),
  });
  active.push(harness);
  await harness.start();
  const actor = `agent:worker/${harness.session}` as const;
  await harness.store.transaction(async (trx) => {
    await trx
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'pr',
        repo: 'example/repo',
        number: 7,
        pr_state: 'active',
        session_id: null,
        role: null,
        source: 'manual',
        created_at: AT,
        ticket_key: null,
        pr_open: 1,
      })
      .execute();
    await trx
      .insertInto('pr_snapshot')
      .values({
        repo: 'example/repo',
        number: 7,
        head_sha: A,
        head_branch: 'work',
        state: 'open',
        draft: 0,
        mergeable: 'mergeable',
        merge_state: 'clean',
        detail: JSON.stringify(prFact(A)),
        source: SOURCE,
        observed_at: AT,
      })
      .execute();
    await trx
      .insertInto('turn')
      .values({
        task_id: 1,
        column: 'dev',
        epoch: 0,
        seq: 1,
        role: 'worker',
        reason: 'Build it',
        handed: '[]',
        acked_by: actor,
        acked_at: AT,
        closed_at: null,
        closed_reason: null,
        created_at: AT,
      })
      .execute();
  });
  const turn = () => harness.store.db.selectFrom('turn').selectAll().executeTakeFirstOrThrow();

  const stale = await harness.cli(['submit', 'T1', A, '--key', 'submit-stale']);
  expect(stale.code, stale.stderr).toBe(1);
  expect(stale.stderr).toContain('head_mismatch');
  expect((await turn()).closed_at).toBeNull();

  answer = 'timeout';
  const timedOut = await harness.cli(['submit', 'T1', B, '--key', 'submit-timeout']);
  expect(timedOut.code, timedOut.stderr).toBe(3);
  expect(timedOut.stderr).toContain('github_unavailable');
  expect((await turn()).closed_at).toBeNull();

  answer = 'commit-b';
  const fresh = await harness.cli(['submit', 'T1', B, '--key', 'submit-fresh']);
  expect(fresh.code, fresh.stderr).toBe(0);
  expect(
    await harness.store.db.selectFrom('submission').select(['commit_sha', 'author']).execute(),
  ).toEqual([{ commit_sha: B, author: actor }]);
  expect((await turn()).closed_reason).toBe('submitted');
  expect(calls).toEqual(
    [1, 2, 3].map(() => [
      SOURCE,
      { kind: 'pr', repo: 'example/repo', number: 7 },
      { timeoutMs: 10_000 },
    ]),
  );
});
