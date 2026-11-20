import { configSchema, type PrApprovalPair, type PrFacts } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createObservationCore,
  createOperationRegistry,
  createQuery,
  type Store,
} from '../../src/index.ts';
import { dispatchOperation } from '../../src/app/operations.ts';
import { openTempStore } from '../support/store.ts';

const at = '2026-11-20T00:00:00.000Z';
const clock = { now: () => Date.parse(at) };
const task = 'o/r#9';
const source = 'github:board:o/r';
const head = 'a'.repeat(40);
const older = 'b'.repeat(40);
const oldest = 'c'.repeat(40);
const stores: Store[] = [];

const configWith = (approvalWatch?: string[]) =>
  configSchema.parse({
    projects: [
      {
        id: 'board',
        tracker: { type: 'github-issues', repo: 'o/r', label: 'board' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'worker', role: 'worker' }],
        ...(approvalWatch === undefined ? {} : { approvalWatch }),
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
  });

const approval = (reviewer: string, commitSha: string): PrFacts['reviews'][number] => ({
  reviewer,
  state: 'approved',
  commitSha,
  submittedAt: at,
});

function prFact(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    repo: 'o/r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: `${task} work`,
    author: 'worker',
    headSha: head,
    headBranch: `${task}-work`,
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [],
    checks: [],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: [task],
    updatedAt: at,
    ...overrides,
  };
}

const counted = (approvedSha: string, commitsAfter: number, changed: string[]): PrApprovalPair => ({
  approvedSha,
  headSha: head,
  commitsAfter,
  changed,
});

async function setup(approvalWatch?: string[]) {
  const config = configWith(approvalWatch);
  const store = openTempStore('board-approval-watch-').store;
  stores.push(store);
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const core = createObservationCore({ store, config, clock });
  const query = createQuery({ store, config, clock });
  await dispatchOperation(
    { store, config, clock, registry },
    'task.add',
    { task },
    'operator',
    'add-9',
  );
  const observe = (facts: PrFacts, approvalPairs?: PrApprovalPair[]) =>
    core.observe(source, {
      batch: {
        source,
        observedAt: at,
        complete: true,
        items: [{ kind: 'pr', facts, ...(approvalPairs === undefined ? {} : { approvalPairs }) }],
        entities: [],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: at, gone: [] },
      outcomes: [],
    });
  const statusApprovals = async () => {
    const result = await query(registry['status.get'], {}, 'operator');
    return result.tasks.find((row) => row.key === task)?.prSummary?.[0]?.approvals;
  };
  const taskApprovals = async () => {
    const result = await query(registry['task.get'], { task }, 'operator');
    return result.links.find((link) => link.kind === 'pr')?.approvals;
  };
  const rows = () =>
    store.db
      .selectFrom('meta')
      .select(['key', 'value'])
      .where('key', 'like', 'approval-watch:%')
      .orderBy('key')
      .execute();
  return { store, observe, statusApprovals, taskApprovals, rows };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('approval watch', () => {
  it('shows onHead with no changes', async () => {
    const { observe, statusApprovals } = await setup(['back/']);
    await observe(prFact({ reviews: [approval('alice', head)] }));
    expect(await statusApprovals()).toEqual([
      {
        author: 'alice',
        sha: head,
        onHead: true,
        commitsAfter: 0,
        changedAfter: [],
        watchedAfter: [],
      },
    ]);
  });

  it('lists watchedAfter by approvalWatch', async () => {
    const { observe, statusApprovals } = await setup(['back/', 'front/']);
    await observe(prFact({ reviews: [approval('alice', older)] }), [
      counted(older, 2, ['back/', 'docs/']),
    ]);
    expect(await statusApprovals()).toEqual([
      {
        author: 'alice',
        sha: older,
        onHead: false,
        commitsAfter: 2,
        changedAfter: ['back/', 'docs/'],
        watchedAfter: ['back/'],
      },
    ]);
  });

  it('only unwatched entries changed', async () => {
    const { observe, statusApprovals } = await setup(['back/', 'front/']);
    await observe(prFact({ reviews: [approval('alice', older)] }), [counted(older, 1, ['docs/'])]);
    expect(await statusApprovals()).toEqual([
      {
        author: 'alice',
        sha: older,
        onHead: false,
        commitsAfter: 1,
        changedAfter: ['docs/'],
        watchedAfter: [],
      },
    ]);
  });

  it('matches approvalWatch with or without a slash against either kind', async () => {
    const { observe, statusApprovals } = await setup(['back', 'package.json/']);
    await observe(prFact({ reviews: [approval('alice', older)] }), [
      counted(older, 1, ['README.md', 'back/', 'package.json']),
    ]);
    expect((await statusApprovals())?.[0]).toMatchObject({
      changedAfter: ['README.md', 'back/', 'package.json'],
      watchedAfter: ['back/', 'package.json'],
    });
  });

  it('counts every changed entry as watched without approvalWatch', async () => {
    const { observe, statusApprovals } = await setup();
    await observe(prFact({ reviews: [approval('alice', older)] }), [
      counted(older, 3, ['back/', 'docs/', 'package.json']),
    ]);
    const [view] = (await statusApprovals()) ?? [];
    expect(view?.changedAfter).toEqual(['back/', 'docs/', 'package.json']);
    expect(view?.watchedAfter).toEqual(view?.changedAfter);
  });

  it('keeps one row per approved and head pair', async () => {
    const { observe, statusApprovals, rows } = await setup(['back/']);
    const facts = prFact({
      reviews: [approval('alice', older), approval('bob', oldest), approval('carol', head)],
    });
    await observe(facts, [
      counted(older, 1, ['back/']),
      { approvedSha: oldest, headSha: head, notCounted: 'history_rewritten' },
    ]);
    expect(await rows()).toEqual([
      {
        key: `approval-watch:o/r#7:${older}:${head}`,
        value: JSON.stringify({ commitsAfter: 1, changed: ['back/'] }),
      },
      {
        key: `approval-watch:o/r#7:${oldest}:${head}`,
        value: JSON.stringify({ notCounted: 'history_rewritten' }),
      },
    ]);
    expect(await statusApprovals()).toEqual([
      {
        author: 'alice',
        sha: older,
        onHead: false,
        commitsAfter: 1,
        changedAfter: ['back/'],
        watchedAfter: ['back/'],
      },
      { author: 'bob', sha: oldest, onHead: false, notCounted: 'history_rewritten' },
      {
        author: 'carol',
        sha: head,
        onHead: true,
        commitsAfter: 0,
        changedAfter: [],
        watchedAfter: [],
      },
    ]);
  });

  it('ignores a pair for another head and shows the approval as not read yet', async () => {
    const { observe, statusApprovals, rows } = await setup();
    await observe(prFact({ reviews: [approval('alice', older)] }), [
      { approvedSha: older, headSha: oldest, commitsAfter: 1, changed: ['back/'] },
    ]);
    expect(await rows()).toEqual([]);
    expect(await statusApprovals()).toEqual([{ author: 'alice', sha: older, onHead: false }]);
  });

  it('a rate_limit pair never replaces a stored row', async () => {
    const { observe, statusApprovals, rows } = await setup();
    const facts = prFact({ reviews: [approval('alice', older), approval('bob', oldest)] });
    await observe(facts, [
      counted(older, 1, ['back/']),
      { approvedSha: oldest, headSha: head, notCounted: 'pr_too_large' },
    ]);
    const before = await rows();
    await observe(facts, [
      { approvedSha: older, headSha: head, notCounted: 'rate_limit' },
      { approvedSha: oldest, headSha: head, notCounted: 'rate_limit' },
    ]);
    expect(await rows()).toEqual(before);
    // Without a stored row a rate_limit pair is kept, and a later counted read replaces it.
    const fresh = prFact({ reviews: [approval('carol', 'd'.repeat(40))] });
    await observe(fresh, [
      { approvedSha: 'd'.repeat(40), headSha: head, notCounted: 'rate_limit' },
    ]);
    expect(await statusApprovals()).toEqual([
      { author: 'carol', sha: 'd'.repeat(40), onHead: false, notCounted: 'rate_limit' },
    ]);
    await observe(fresh, [counted('d'.repeat(40), 4, ['front/'])]);
    expect((await statusApprovals())?.[0]).toMatchObject({ commitsAfter: 4 });
  });

  it('changes no event, move or turn: a hint only', async () => {
    const { store, observe, rows } = await setup(['back/']);
    const facts = prFact({ reviews: [approval('alice', older)] });
    await observe(facts);
    const state = async () => ({
      events: await store.db.selectFrom('event').selectAll().orderBy('id').execute(),
      tasks: await store.db.selectFrom('task').selectAll().orderBy('id').execute(),
      turns: await store.db.selectFrom('turn').selectAll().orderBy('id').execute(),
    });
    const before = await state();
    await observe(facts, [counted(older, 1, ['back/'])]);
    await observe(facts, [counted(older, 2, ['back/', 'front/'])]);
    expect(await state()).toEqual(before);
    expect(await rows()).toHaveLength(1);
  });

  it('task.get links carry the same approvals as status.get', async () => {
    const { observe, statusApprovals, taskApprovals } = await setup(['back/']);
    await observe(prFact({ reviews: [approval('alice', older), approval('bob', head)] }), [
      counted(older, 1, ['back/', 'docs/']),
    ]);
    const status = await statusApprovals();
    expect(status).toHaveLength(2);
    expect(await taskApprovals()).toEqual(status);
  });

  it('leaves approvals out for a PR with no approval', async () => {
    const { observe, statusApprovals, taskApprovals } = await setup();
    await observe(prFact({ reviews: [{ ...approval('alice', older), state: 'commented' }] }));
    expect(await statusApprovals()).toBeUndefined();
    expect(await taskApprovals()).toBeUndefined();
  });

  it('status.get and task.get read an unreadable approval-watch row as not read yet', async () => {
    const { store, observe, statusApprovals, taskApprovals } = await setup();
    await observe(prFact({ reviews: [approval('alice', older)] }));
    for (const value of ['not json', JSON.stringify({ commitsAfter: -1, changed: [] })]) {
      await store.db
        .insertInto('meta')
        .values({ key: `approval-watch:o/r#7:${older}:${head}`, value })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
        .execute();
      const expected = [{ author: 'alice', sha: older, onHead: false }];
      expect(await statusApprovals()).toEqual(expected);
      expect(await taskApprovals()).toEqual(expected);
    }
  });

  it("drops every pair of a PR that is no longer open and keeps PR #10's and another repo's rows", async () => {
    const { store, observe, rows } = await setup();
    const keys = [
      `approval-watch:acme/my_repo#1:${older}:${head}`,
      `approval-watch:acme/my_repo#1:${oldest}:${older}`,
      `approval-watch:acme/my_repo#10:${older}:${head}`,
      `approval-watch:acme/myXrepo#1:${older}:${head}`,
    ];
    const value = JSON.stringify({ commitsAfter: 1, changed: ['back/'] });
    await store.db
      .insertInto('meta')
      .values(keys.map((key) => ({ key, value })))
      .execute();
    await observe(
      prFact({
        repo: 'Acme/my_repo',
        number: 1,
        url: 'https://github.com/Acme/my_repo/pull/1',
        state: 'closed',
      }),
    );
    expect((await rows()).map((row) => row.key).sort()).toEqual([keys[2], keys[3]].sort());
  });
});
