import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  sessionFactsSchema,
  trackerSourceId,
  type Adapter,
} from '@spur-board/contracts';
import { expect, it } from 'vitest';
import { githubSources } from '../../adapters/src/github/index.ts';
import { createGithubIssuesAdapter } from '../../adapters/src/github/issues.ts';
import { startRunner, type AdapterRunner } from '../../adapters/src/runner/runner.ts';
import { createSpurAdapter } from '../../adapters/src/spur/spur.ts';
import { dispatchOperation } from '../../core/src/app/operations.ts';
import {
  createObservationCore,
  createOperationRegistry,
  createQuery,
  openStore,
} from '../../core/src/index.ts';
import { createFakeSpur, requestUrl } from '../src/fake-spur.ts';
import { createFakes } from '../src/fakes/fetch.ts';
import { createGithubIssuesFake } from '../src/fakes/github-issues.ts';
import { createGithubPrFake } from '../src/fakes/github-pr.ts';
import { ISSUE, REPO } from '../src/scenarios/dispatcher.ts';
import { STAND_SPUR_PROJECTS } from '../src/scenarios/helpers.ts';

const tracker = { type: 'github-issues', repo: REPO } as const;
const config = configSchema.parse({
  projects: [
    {
      id: 'stand',
      tracker,
      repos: [REPO],
      operatorGithubLogin: 'stand-agent',
      spurProjects: STAND_SPUR_PROJECTS,
      columns: [
        { id: 'todo' },
        { id: 'dev' },
        { id: 'review', orchestrator: 'stand-qa' },
        { id: 'done' },
      ],
      dispatcher: { mode: 'on' },
    },
  ],
  adapters: {
    githubIssues: { intervalMs: 60_000 },
    spur: { baseUrl: 'http://spur.stand.invalid' },
  },
  health: { idleInDevAfterMs: 60_000 },
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const interval = config.adapters.githubIssues.intervalMs;
const head = 'a'.repeat(40);
const worker = 'agent:stand-worker/worker';
const reviewer = 'agent:stand-qa/reviewer';
const issue = { repo: REPO, number: 1 };

it.each(['closed', 'open'] as const)(
  'reconciles an idle worker after a PR merges and the next issue read is %s',
  async (nextRead) => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = { now: () => now };
    const home = mkdtempSync(join(tmpdir(), 'board-worker-idle-'));
    const store = openStore(join(home, 'board.db'));
    const core = createObservationCore({ store, config, clock });
    let prPoller: AdapterRunner['pollPr'];
    const registry = createOperationRegistry({
      config,
      clock,
      completeSince: core.completeSince,
      prPoller: () => prPoller,
    });
    const dispatch = { store, config, clock, registry };
    const query = createQuery(dispatch);
    const fakes = createFakes({
      now: clock.now,
      modules: [
        (now) => createGithubPrFake({ now, repos: [REPO] }),
        (now) => createGithubIssuesFake({ now, repos: [REPO] }),
      ],
    });
    const github = (verb: string, args: unknown = issue) => {
      expect(fakes.control({ system: 'github', verb, args })).toMatchObject({ status: 200 });
    };
    const githubFetch = fakes.wrap((input) =>
      Promise.reject(new Error(`Unexpected GitHub request: ${requestUrl(input).href}`)),
    );
    const githubOptions = { token: 'fake', now: clock.now, fetch: githubFetch };
    const [prSource] = githubSources(config, githubOptions);
    if (prSource === undefined) throw new Error('Missing PR adapter');
    const issueAdapter = createGithubIssuesAdapter({
      ...githubOptions,
      id: trackerSourceId({ id: 'stand', tracker }),
      tracker,
      intervalMs: interval,
    });
    const spur = createFakeSpur({
      baseUrl: config.adapters.spur.baseUrl,
      now: clock.now,
      log: (message) => {
        throw new Error(message);
      },
    });
    const spurAdapter = createSpurAdapter({
      baseUrl: config.adapters.spur.baseUrl,
      intervalMs: config.adapters.spur.intervalMs,
      flipSmoothingMs: config.health.flipSmoothingMs,
      now: clock.now,
      fetch: spur.fetch,
    });
    const poll = async (adapter: Adapter, then?: () => Promise<void>) => {
      const runner = startRunner({
        entries: [{ adapter }],
        core,
        config,
        now: clock.now,
        oneShot: true,
      });
      try {
        expect(await runner.firstAttempts).toMatchObject([
          { source: adapter.id, outcome: { kind: 'delivered' } },
        ]);
        expect(fakes.violations().items).toEqual([]);
        expect(
          await store.db
            .selectFrom('source_state')
            .select(['last_complete_at', 'blind_reason'])
            .where('source', '=', adapter.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          last_complete_at: new Date(now).toISOString(),
          blind_reason: null,
        });
        prPoller = runner.pollPr;
        await then?.();
      } finally {
        prPoller = undefined;
        await runner.stop();
      }
    };
    const get = () => query(registry['task.get'], { task: ISSUE, why: true }, 'operator');
    const idle = () =>
      store.db
        .selectFrom('operator_item')
        .selectAll()
        .where('item_key', 'like', 'health:%:worker_idle')
        .execute();
    const submit = async (actor: typeof worker | typeof reviewer) => {
      const turn = (await get()).turn;
      if (turn === null) throw new Error('Missing turn');
      await dispatchOperation(
        dispatch,
        'inbox.ack',
        { entries: [{ id: turn.id }] },
        actor,
        `ack-${actor}`,
      );
      await dispatchOperation(
        dispatch,
        'task.submit',
        { turn: turn.id, sha: head },
        actor,
        `submit-${actor}`,
      );
    };
    const assertWaiting = async () => {
      const session = await store.db
        .selectFrom('session_snapshot')
        .select('detail')
        .where('id', '=', 'worker')
        .executeTakeFirstOrThrow();
      const facts = sessionFactsSchema.parse(JSON.parse(session.detail));
      expect(facts).toMatchObject({
        lifecycle: 'running',
        endedAt: null,
        health: 'waiting',
      });
      const pr = await store.db
        .selectFrom('source_state')
        .select('last_complete_at')
        .where('source', '=', prSource.adapter.id)
        .executeTakeFirstOrThrow();
      const since = Date.parse(facts.healthSince);
      expect(now - since).toBeGreaterThanOrEqual(config.health.idleInDevAfterMs);
      expect(Date.parse(pr.last_complete_at ?? '')).toBeGreaterThanOrEqual(since);
    };

    try {
      expect(
        spur.control('session', { id: 'worker', project: 'stand-worker', state: 'waiting' }),
      ).toMatchObject({ status: 200 });
      expect(spur.control('session', { id: 'reviewer', project: 'stand-qa' })).toMatchObject({
        status: 200,
      });
      github('issue-open');
      await poll(issueAdapter);
      await poll(spurAdapter);
      await dispatchOperation(
        dispatch,
        'link.add',
        {
          mode: 'session',
          task: ISSUE,
          session: 'worker',
          reason: 'Stand regression',
        },
        'operator',
        'link-worker',
      );
      await poll(spurAdapter);
      github('create', {
        ...issue,
        seed: {
          headRefOid: head,
          closingIssuesReferences: [{ number: 1, repository: { nameWithOwner: REPO } }],
        },
      });
      github('ci-green');
      await poll(prSource.adapter, async () => {
        await submit(worker);
        await submit(reviewer);
      });
      expect((await get()).task.column).toBe('review');

      now += interval;
      await poll(issueAdapter);
      await poll(spurAdapter);
      expect(await idle()).toEqual([]);
      github('merge');
      await poll(prSource.adapter);
      expect((await get()).task.column).toBe('review');
      expect((await get()).why?.holds).toContain('ticket_unconfirmed');
      await assertWaiting();
      expect(await idle()).toEqual([]);

      now += interval;
      let openIdleId: number | undefined;
      if (nextRead === 'open') {
        await poll(issueAdapter);
        await assertWaiting();
        const openIdle = await idle();
        expect(openIdle).toMatchObject([{ cleared_at: null }]);
        openIdleId = openIdle[0]?.id;
        now += 1;
      }
      github('issue-close');
      await poll(issueAdapter);
      const done = await get();
      expect(done.why?.moves.at(-1)).toMatchObject({
        from: 'review',
        to: 'done',
        reason: 'merged',
      });
      const inbox = await query(registry['inbox.get'], {}, worker);
      expect(inbox.turns).toMatchObject([{ task: ISSUE, column: 'done', reason: 'done: wrap up' }]);
      expect(
        await store.db.selectFrom('turn').select('id').where('column', '=', 'done').execute(),
      ).toHaveLength(1);
      await assertWaiting();
      await poll(spurAdapter);
      const items = await query(registry['status.get'], { project: 'stand' }, 'operator');
      expect(items.items.filter(({ key }) => key.endsWith(':worker_idle'))).toEqual([]);
      if (nextRead === 'closed') expect(await idle()).toEqual([]);
      else
        expect(await idle()).toMatchObject([
          { id: openIdleId, cleared_at: new Date(now).toISOString() },
        ]);
    } finally {
      spur.close();
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
