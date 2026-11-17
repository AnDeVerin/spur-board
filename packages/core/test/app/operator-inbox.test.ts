import Database from 'better-sqlite3';
import type { ActorId, Config } from '@spur-board/contracts';
import { Kysely, SqliteDialect } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { createApply, createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { withVia } from '../../src/app/board-utils.ts';
import type { Tables } from '../../src/store/schema.ts';
import {
  ago,
  block,
  clock,
  failedPost,
  HOUR,
  item,
  legacy,
  mixed,
  notification,
  seedEveryKind,
  sourceState,
  task,
  turn,
} from '../support/operator-inbox.ts';
import { openTempStore } from '../support/store.ts';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup(config: Config = mixed) {
  const { store, file } = openTempStore('board-operator-inbox-');
  stores.push(store);
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const query = createQuery({ store, config, clock });
  const apply = createApply({ store, config, clock });
  const inbox = (actor: ActorId = 'operator') => query(registry['inbox.operator'], {}, actor);
  return { store, file, registry, apply, inbox };
}

describe('inbox.operator', () => {
  it('lists operator items, blocks and turns across projects with project labels', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const second = await task(trx, { project: 'second', key: 'o/second#2' });
      const firstItem = await item(trx, {
        key: 'inbound:failure:1',
        kind: 'inbound_failure',
        taskId: first,
        raisedAt: ago(10),
      });
      const secondItem = await item(trx, {
        key: 'token:7',
        kind: 'token_request',
        taskId: second,
        raisedAt: ago(20),
      });
      const boardItem = await item(trx, {
        key: 'token:8',
        kind: 'token_request',
        raisedAt: ago(30),
      });
      const operatorBlock = await block(trx, { taskId: first, createdAt: ago(40) });
      await block(trx, { taskId: second, addressee: 'worker', createdAt: ago(45) });
      const projectBlock = await block(trx, { project: 'second', createdAt: ago(50) });
      const operatorTurn = await turn(trx, { taskId: first, createdAt: ago(60) });
      await turn(trx, { taskId: second, role: 'worker', createdAt: ago(65) });
      const payloadDelivery = await failedPost(trx, {
        kind: 'conversation.open',
        payload: { taskId: second },
        raisedAt: ago(70),
      });
      const ring = await notification(trx, first, operatorBlock);
      const doorbellDelivery = await failedPost(trx, {
        kind: 'doorbell',
        payload: { notificationId: ring },
        raisedAt: ago(80),
      });
      const feedDelivery = await failedPost(trx, {
        kind: 'feed.line',
        payload: {},
        raisedAt: ago(90),
      });
      return {
        firstItem,
        secondItem,
        boardItem,
        operatorBlock: `B${String(operatorBlock)}`,
        projectBlock: `B${String(projectBlock)}`,
        operatorTurn,
        payloadDelivery,
        doorbellDelivery,
        feedDelivery,
      };
    });

    const result = await inbox();

    expect(
      result.items.map((entry) => [entry.id, entry.project, entry.kind, entry.severity]),
    ).toEqual([
      [ids.firstItem, 'first', 'inbound_failure', 'failure'],
      [ids.secondItem, 'second', 'token_request', 'attention'],
      [ids.boardItem, '_board', 'token_request', 'attention'],
      [ids.operatorBlock, 'first', 'block', 'attention'],
      [ids.projectBlock, 'second', 'block', 'attention'],
      [ids.operatorTurn, 'first', 'turn', 'attention'],
      [ids.payloadDelivery, 'second', 'post_failed', 'failure'],
      [ids.doorbellDelivery, 'first', 'post_failed', 'failure'],
      [ids.feedDelivery, '_board', 'post_failed', 'failure'],
    ]);
    expect(result.handled).toEqual([]);
    for (const entry of result.items) {
      expect(Object.keys(entry)).toEqual(
        expect.arrayContaining(['id', 'project', 'kind', 'severity', 'text', 'at', 'task']),
      );
    }
    const byId = new Map(result.items.map((entry) => [entry.id, entry]));
    expect(byId.get(ids.operatorTurn)).toMatchObject({
      task: 'o/first#1',
      column: 'ready-to-merge',
    });
    expect(byId.get(ids.operatorBlock)).toMatchObject({ task: 'o/first#1', answeredVia: null });
    expect(byId.get(ids.projectBlock)).toMatchObject({ task: null });
    expect(byId.get(ids.payloadDelivery)).toMatchObject({ task: 'o/second#2' });
    expect(byId.get(ids.feedDelivery)).toMatchObject({ task: null });
  });

  it('lists a block or turn once, not its mirror items', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const second = await task(trx, { project: 'second', key: 'o/second#2' });
      const operatorBlock = await block(trx, { taskId: first });
      const ledgerBlock = await block(trx, { taskId: second, author: 'system' });
      const agentBlock = await block(trx, { taskId: second, addressee: 'worker' });
      const operatorTurn = await turn(trx, { taskId: first });
      await item(trx, {
        key: `operator-block:${String(operatorBlock)}`,
        kind: 'board_observation',
        taskId: first,
      });
      await item(trx, {
        key: `block:${String(operatorBlock)}`,
        kind: 'board_observation',
        taskId: first,
      });
      await item(trx, {
        key: `anomaly:${String(second)}`,
        kind: 'anomaly',
        taskId: second,
        blockId: ledgerBlock,
      });
      await item(trx, { key: `turn:${operatorTurn.slice(1)}`, kind: 'turn', taskId: first });
      const agentBlockItem = await item(trx, {
        key: `block:${String(agentBlock)}`,
        kind: 'board_observation',
        taskId: second,
      });
      return {
        blocks: [`B${String(operatorBlock)}`, `B${String(ledgerBlock)}`],
        operatorTurn,
        agentBlockItem,
      };
    });

    const { items } = await inbox();

    expect(items.map((entry) => entry.id).sort()).toEqual(
      [...ids.blocks, ids.operatorTurn, ids.agentBlockItem].sort(),
    );
  });

  it('marks system failures and says what to check', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const kinds = [
        'post_failed',
        'transport_health',
        'answer_undelivered',
        'worker_not_reading',
        'inbound_failure',
        'inbound_gap',
        'token_request',
        'post_blocked',
        'answer_author_unavailable',
      ];
      const byKind: Record<string, string> = {};
      for (const kind of kinds) {
        byKind[kind] = await item(trx, {
          key:
            kind === 'transport_health'
              ? 'transport:slack'
              : kind === 'post_failed'
                ? 'delivery:999'
                : `${kind}:1`,
          kind,
          text: kind === 'transport_health' ? 'slack delivery down since x (down)' : `${kind} text`,
        });
      }
      await sourceState(trx, 'spur', { reason: 'stale', message: 'connection refused' });
      await sourceState(trx, 'github:first:o/first', { reason: 'auth', message: null });
      await sourceState(trx, 'jira:second', { reason: 'config', message: 'bad JQL' });
      await sourceState(trx, 'github-issues:second:o/second', null);
      const spur = await item(trx, {
        key: 'source:spur',
        kind: 'board_observation',
        text: 'spur: connection refused',
      });
      const github = await item(trx, {
        key: 'source:github:first:o/first',
        kind: 'board_observation',
        text: 'github:first:o/first: auth',
      });
      const jira = await item(trx, {
        key: 'source:jira:second',
        kind: 'board_observation',
        text: 'jira:second: bad JQL',
      });
      const recovered = await item(trx, {
        key: 'source:github-issues:second:o/second',
        kind: 'board_observation',
        text: 'github-issues:second:o/second: stale',
        raisedAt: ago(3 * HOUR),
        clearedAt: ago(HOUR),
      });
      const operatorTurn = await turn(trx, { taskId: first, reason: 'Merge it.' });
      return { byKind, spur, github, jira, recovered, operatorTurn };
    });

    const { items, handled } = await inbox();
    const byId = new Map([...items, ...handled].map((entry) => [entry.id, entry]));
    const entry = (id: string) => byId.get(id);

    for (const kind of [
      'post_failed',
      'transport_health',
      'answer_undelivered',
      'worker_not_reading',
      'inbound_failure',
      'inbound_gap',
    ]) {
      expect(entry(ids.byKind[kind] ?? ''), kind).toMatchObject({
        severity: 'failure',
        project: '_board',
      });
      expect(entry(ids.byKind[kind] ?? '')?.text, kind).toMatch(/: check \S/);
    }
    for (const [kind, action] of [
      ['token_request', 'approve or deny it in Slack within 15 minutes of the request'],
      ['post_blocked', 'close the item once you have read it'],
      [
        'answer_author_unavailable',
        'pass the answer to the asking session yourself, then close the item',
      ],
    ] as const) {
      expect(entry(ids.byKind[kind] ?? ''), kind).toMatchObject({
        severity: 'attention',
        action,
        text: `${kind} text: ${action}`,
      });
    }
    expect(entry(ids.byKind['transport_health'] ?? '')).toMatchObject({
      action: 'check the Slack app tokens',
    });
    expect(entry(ids.byKind['transport_health'] ?? '')?.text).toBe(
      'slack delivery down since x (down): check the Slack app tokens',
    );
    expect(entry(ids.spur)).toMatchObject({
      severity: 'failure',
      project: '_board',
      text: 'Spur unreachable (connection refused): check the Spur daemon',
      action: 'check the Spur daemon',
    });
    expect(entry(ids.github)?.text).toBe('GitHub auth failed: check the GitHub token');
    expect(entry(ids.jira)?.text).toBe(
      'Jira config rejected (bad JQL): check the jira:second settings in the board config',
    );
    expect(handled.map((handledEntry) => handledEntry.id)).toEqual([ids.recovered]);
    expect(entry(ids.recovered)).toMatchObject({
      severity: 'failure',
      text: 'github-issues:second:o/second: stale: check the github-issues:second:o/second source',
    });
    expect(entry(ids.operatorTurn)).toMatchObject({
      severity: 'attention',
      text: `Your turn ${ids.operatorTurn}: Merge it.`,
    });
    for (const listed of [...items, ...handled]) {
      expect(listed.text).not.toMatch(/\(null\)|\(\)/);
    }
  });

  it('shows where each handled block was answered', async () => {
    const { store, registry, apply, inbox } = setup();
    const blocks = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      return [
        await block(trx, { taskId: first }),
        await block(trx, { taskId: first }),
        await block(trx, { taskId: first }),
      ].map((id) => `B${String(id)}`);
    });
    const [slack = '', web = '', plain = ''] = blocks;
    const answer = (id: string) =>
      apply(registry['block.answer'], { block: id, text: 'Use v2.' }, 'operator', `answer-${id}`);
    await withVia('slack', () => answer(slack));
    await withVia('web', () => answer(web));
    await answer(plain);

    const { items, handled } = await inbox();

    expect(items).toEqual([]);
    expect(handled.map((entry) => [entry.id, entry.answeredVia, entry.handledAt]).sort()).toEqual(
      [
        [slack, 'slack', ago(0)],
        [web, 'web', ago(0)],
        [plain, null, ago(0)],
      ].sort(),
    );
    const view = await createQuery({ store, config: mixed, clock })(
      registry['task.get'],
      { task: 'o/first#1' },
      'operator',
    );
    expect(view.blocks.map((entry) => [entry.id, entry.answeredVia])).toEqual([
      [slack, 'slack'],
      [web, 'web'],
      [plain, null],
    ]);
  });

  it('keeps the last 24 h of handled entries', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const second = await task(trx, { project: 'first', key: 'o/first#2' });
      return {
        recentItem: await item(trx, {
          key: 'inbound:1',
          kind: 'inbound_failure',
          taskId: first,
          raisedAt: ago(30 * HOUR),
          clearedAt: ago(HOUR),
        }),
        oldItem: await item(trx, {
          key: 'inbound:2',
          kind: 'inbound_failure',
          taskId: first,
          raisedAt: ago(30 * HOUR),
          clearedAt: ago(25 * HOUR),
        }),
        recentTurn: await turn(trx, {
          taskId: first,
          createdAt: ago(30 * HOUR),
          closedAt: ago(HOUR + 1),
        }),
        oldTurn: await turn(trx, {
          taskId: second,
          createdAt: ago(30 * HOUR),
          closedAt: ago(25 * HOUR),
        }),
      };
    });

    const { items, handled } = await inbox();

    expect(items).toEqual([]);
    expect(handled.map((entry) => [entry.id, entry.handledAt])).toEqual([
      [ids.recentItem, ago(HOUR)],
      [ids.recentTurn, ago(HOUR + 1)],
    ]);
  });

  it('keeps only the 20 newest handled entries', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const cleared: string[] = [];
      for (let n = 1; n <= 25; n += 1) {
        cleared.push(
          await item(trx, {
            key: `inbound:${String(n)}`,
            kind: 'inbound_failure',
            taskId: first,
            clearedAt: ago(100 - n),
          }),
        );
      }
      return cleared;
    });

    const { handled } = await inbox();

    expect(handled.map((entry) => entry.id)).toEqual(ids.slice(5).reverse());
  });

  it('lists an item key once across raises', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const raised = { kind: 'inbound_failure', taskId: first };
      await item(trx, { ...raised, key: 'inbound:x', clearedAt: ago(2 * HOUR) });
      const reopened = await item(trx, { ...raised, key: 'inbound:x', raiseNo: 2 });
      await item(trx, { ...raised, key: 'inbound:y', clearedAt: ago(3 * HOUR) });
      const newer = await item(trx, {
        ...raised,
        key: 'inbound:y',
        raiseNo: 2,
        clearedAt: ago(HOUR),
      });
      return { reopened, newer };
    });

    const { items, handled } = await inbox();

    expect(items.map((entry) => entry.id)).toEqual([ids.reopened]);
    expect(handled.map((entry) => entry.id)).toEqual([ids.newer]);
  });

  it('leaves out archived tasks', async () => {
    const { store, registry, apply, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const kept = await task(trx, { project: 'first', key: 'o/first#2' });
      return {
        own: await item(trx, { key: 'inbound:1', kind: 'inbound_failure', taskId: first }),
        block: `B${String(await block(trx, { taskId: first }))}`,
        turn: await turn(trx, { taskId: first }),
        delivery: await failedPost(trx, { kind: 'conversation.open', payload: { taskId: first } }),
        kept: await item(trx, { key: 'inbound:2', kind: 'inbound_failure', taskId: kept }),
      };
    });
    await apply(registry['task.archive'], { task: 'o/first#1' }, 'operator', 'archive-1');

    const { items, handled } = await inbox();

    const listed = [...items, ...handled].map((entry) => entry.id);
    for (const id of [ids.own, ids.block, ids.turn, ids.delivery]) expect(listed).not.toContain(id);
    expect(listed).toEqual([ids.kept]);
  });

  /** One open and one handled entry in each of `first`, `second` and `_board`, plus a source. */
  async function scoped(store: Store) {
    await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const second = await task(trx, { project: 'second', key: 'o/second#2' });
      for (const [taskId, name] of [
        [first, 'first'],
        [second, 'second'],
        [null, 'board'],
      ] as const) {
        await item(trx, { key: `inbound:${name}`, kind: 'inbound_failure', taskId });
        await item(trx, {
          key: `inbound:${name}:old`,
          kind: 'inbound_failure',
          taskId,
          clearedAt: ago(HOUR),
        });
      }
      await sourceState(trx, 'spur', { reason: 'stale', message: null });
      await item(trx, { key: 'source:spur', kind: 'board_observation', text: 'spur: stale' });
    });
  }

  it.each([
    ['the token', mixed, 'operator', ['_board', 'first', 'second']],
    ['the board-wide operator', mixed, 'agent:hq/s1', ['_board', 'second']],
    ['a project operator', mixed, 'agent:first-ops/s1', ['first']],
    ['a legacy project operator', legacy, 'agent:first-ops/s1', ['_board', 'first', 'second']],
  ] as const)('scopes the operator inbox: %s', async (_name, config, actor, projects) => {
    const { store, inbox } = setup(config);
    await scoped(store);

    const { items, handled } = await inbox(actor);

    const labels = (entries: readonly { project: string }[]) =>
      [...new Set(entries.map((entry) => entry.project))].sort();
    expect(labels(items)).toEqual(projects);
    expect(labels(handled)).toEqual(projects);
    expect(items.some((entry) => entry.text.startsWith('Spur'))).toBe(
      (projects as readonly string[]).includes('_board'),
    );
  });

  it.each([
    ['a worker', 'agent:first-worker/s1'],
    ['an orchestrator', 'agent:first-orch/s1'],
    ['a curator', 'agent:first-curator/s1'],
  ] as const)('refuses %s', async (_name, actor) => {
    const { store, inbox } = setup();
    await scoped(store);
    await expect(inbox(actor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(inbox('agent:first-ops/s1')).resolves.toBeDefined();
  });

  it('issues a fixed number of statements', async () => {
    const { store, file, registry } = setup();
    const statements: string[] = [];
    const db = new Kysely<Tables>({
      dialect: new SqliteDialect({
        database: new Database(file, { readonly: true, fileMustExist: true }),
      }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql);
      },
    });
    try {
      const read = () => registry['inbox.operator'].run(db, {}, 'operator');
      await seedEveryKind(store, 1, 1);
      const one = await read();
      const few = statements.splice(0);
      await seedEveryKind(store, 2, 30);
      const many = await read();
      const more = statements.splice(0);
      expect(one.items.length).toBeGreaterThan(0);
      expect(many.items.length).toBeGreaterThan(one.items.length * 20);
      expect(many.handled).toHaveLength(20);
      expect(more).toHaveLength(few.length);
    } finally {
      await db.destroy();
    }
  });
});
