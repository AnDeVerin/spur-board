import { EVENT_KINDS, OPERATIONS, configSchema, sourceCursorSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApply,
  createObservationCore,
  createOperationRegistry,
  createQuery,
  getStatus,
  type Store,
} from '../../src/index.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { closeTurns, openTurn } from '../../src/app/turns.ts';
import { openTempStore } from '../support/store.ts';
import { refreshPrs } from '../../src/app/pr-refresh.ts';

const KEY = 'o/r#101';
const OTHER_KEY = 'x/y#202';
const AT = '2026-11-04T08:00:00.000Z';
const clock = { now: () => Date.parse(AT) };
const worker = 'agent:web/worker-1';
const orchestrator = 'agent:qa/qa-1';
const foreign = 'agent:other/worker-2';
const config = configSchema.parse({
  projects: [
    {
      id: 'board',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'web', role: 'worker' },
        { name: 'qa', role: 'orchestrator' },
      ],
      columns: [
        { id: 'todo', orchestrator: 'none' },
        { id: 'ready-for-dev', orchestrator: 'none' },
        { id: 'dev', orchestrator: 'qa' },
        { id: 'review', orchestrator: 'none' },
        { id: 'qa', orchestrator: 'none' },
        { id: 'ready-to-merge', orchestrator: 'none' },
        { id: 'done', orchestrator: 'none' },
      ],
    },
    {
      id: 'other',
      tracker: { type: 'github-issues', repo: 'x/y', milestone: 'M1' },
      repos: ['x/y'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'other', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const stores: Store[] = [];

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a registered operation');
  return value;
}

async function seeded() {
  const store = openTempStore('board-queries-').store;
  stores.push(store);
  await store.transaction(async (trx) => {
    for (const [id, project, key] of [
      [1, 'board', KEY],
      [2, 'other', OTHER_KEY],
    ] as const) {
      await trx
        .insertInto('task')
        .values({
          id,
          project,
          key,
          tracker_kind: 'github-issues',
          tracker_id: String(id),
          membership: 'active',
          archive_reason: null,
          column: 'dev',
          shadow_column: null,
          created_at: AT,
          last_change_at: AT,
          terminal_at: null,
          archive_slot_at: null,
        })
        .execute();
    }
    await trx
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: 'worker-1',
        role: 'worker',
        source: 'manual',
        created_at: AT,
      })
      .execute();
  });
  const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
  const query = createQuery({ store, config, clock });
  const apply = createApply({ store, config, clock });
  return { store, registry, query, apply };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('production query handlers', () => {
  it('reads the task view, all blocks and oldest-first untrusted comments', async () => {
    const { store, registry, query } = await seeded();
    await store.transaction(async (trx) => {
      for (const [id, state] of [
        [1, 'unblocked'],
        [2, 'open'],
      ] as const) {
        await trx
          .insertInto('block')
          .values({
            id,
            task_id: 1,
            type: 'needs_input',
            reason: `Question ${String(id)}`,
            author: worker,
            addressee_role: 'operator',
            target_column: null,
            state,
            outcome: state === 'open' ? null : 'done',
            outcome_reason: null,
            repeat_of: null,
            unblocked_by: state === 'open' ? null : 'operator',
            unblocked_at: state === 'open' ? null : AT,
            created_at: AT,
          })
          .execute();
        await trx
          .insertInto('comment')
          .values({
            id,
            task_id: 1,
            block_id: id,
            author: worker,
            text: `Text ${String(id)}`,
            revision: 1,
            conversation_ref: null,
            message_ref: null,
            acked_revision: null,
            created_at: AT,
            delivery_state: null,
          })
          .execute();
      }
      await trx
        .updateTable('task')
        .set({ membership: 'archived', archive_reason: 'manual' })
        .where('id', '=', 1)
        .execute();
    });
    const value = await query(required(registry['task.get']), { task: KEY }, worker);
    expect(value.task).toEqual({
      key: KEY,
      project: 'board',
      column: 'dev',
      membership: 'archived',
    });
    expect(value.blocks.map(({ id, state }) => [id, state])).toEqual([
      ['B1', 'unblocked'],
      ['B2', 'open'],
    ]);
    expect(value.comments.map(({ id, text, untrusted }) => [id, text, untrusted])).toEqual([
      ['C1', 'Text 1', true],
      ['C2', 'Text 2', true],
    ]);
    await expect(
      query(required(registry['task.get']), { task: 'o/r#999' }, worker),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      query(required(registry['task.history']), { task: 'o/r#999' }, worker),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      query(required(registry['task.get']), { task: 'B1' }, worker),
    ).rejects.toMatchObject({
      code: 'wrong_id_kind',
    });
    await expect(
      query(required(registry['task.history']), { task: 'B1' }, worker),
    ).rejects.toMatchObject({
      code: 'wrong_id_kind',
    });
  });

  it('reads a task added by its short GitHub issue key', async () => {
    const { registry, query, apply } = await seeded();
    const added = await apply(
      required(registry['task.add']),
      { task: 'r#303' },
      'operator',
      'add-short-key',
    );
    expect(added.task.key).toBe('o/r#303');
    const viewed = await query(required(registry['task.get']), { task: 'r#303' }, worker);
    expect(viewed.task).toEqual(added.task);
    const history = await query(required(registry['task.history']), { task: 'r#303' }, worker);
    expect(history.task).toEqual(added.task);
    expect(history.events.map(({ kind }) => kind)).toEqual(['task_added']);
  });

  it('returns every task event in journal order with an encoded actor and one-line summary', async () => {
    const { store, registry, query } = await seeded();
    await store.transaction(async (trx) => {
      for (const kind of EVENT_KINDS) {
        await trx
          .insertInto('event')
          .values({
            at: AT,
            project: 'board',
            task_id: 1,
            kind,
            actor: 'agent',
            actor_ref: JSON.stringify({ project: 'web', session: 'worker-1' }),
            payload: '{}',
            v: 1,
            request_id: null,
          })
          .execute();
      }
      await trx
        .insertInto('event')
        .values({
          at: AT,
          project: 'other',
          task_id: 2,
          kind: 'task_added',
          actor: 'system',
          actor_ref: null,
          payload: '{}',
          v: 1,
          request_id: null,
        })
        .execute();
    });
    const value = await query(required(registry['task.history']), { task: KEY }, worker);
    expect(value.events.map(({ kind }) => kind)).toEqual(EVENT_KINDS);
    expect(value.events).toHaveLength(EVENT_KINDS.length);
    for (const event of value.events) {
      expect(event.actor).toBe(worker);
      expect(event.summary.trim()).not.toBe('');
      expect(event.summary).not.toMatch(/[\r\n]/);
    }
  });

  it('shows the current answer revision, acknowledges it, and shows an edited clarification', async () => {
    const { store, registry, query, apply } = await seeded();
    const asked = await apply(
      required(registry['block.ask']),
      { task: KEY, text: 'Which version?' },
      worker,
      'ask-1',
    );
    const answered = await apply(
      required(registry['block.answer']),
      { block: asked.block.id, text: 'Use v2.' },
      orchestrator,
      'answer-1',
    );
    const commentId = answered.comment.id;
    const first = await query(required(registry['inbox.get']), {}, worker);
    expect(first.comments).toEqual([
      expect.objectContaining({ id: commentId, revision: 1, text: 'Use v2.', untrusted: true }),
    ]);
    await apply(
      required(registry['comment.edit']),
      { comment: commentId, text: 'Use v3.' },
      orchestrator,
      'edit-1',
    );
    const edited = await query(required(registry['inbox.get']), {}, worker);
    expect(edited.comments).toEqual([
      expect.objectContaining({ id: commentId, revision: 2, text: 'Use v3.' }),
    ]);
    await apply(
      required(registry['inbox.ack']),
      { entries: [{ id: commentId, revision: 2 }] },
      worker,
      'ack-1',
    );
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([]);
    await apply(
      required(registry['comment.edit']),
      { comment: commentId, text: 'Use v4.' },
      orchestrator,
      'edit-2',
    );
    await apply(
      required(registry['comment.edit']),
      { comment: commentId, text: 'Use v5.' },
      orchestrator,
      'edit-3',
    );
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([
      expect.objectContaining({ id: commentId, revision: 4, text: 'Use v5.' }),
    ]);
    const commentNumber = Number(commentId.slice(1));
    const notices = () =>
      store.db
        .selectFrom('notification')
        .select(['revision', 'acked_at'])
        .where('comment_id', '=', commentNumber)
        .orderBy('revision')
        .execute();
    expect(
      (await notices()).filter(({ acked_at }) => acked_at === null).map(({ revision }) => revision),
    ).toEqual([3, 4]);
    await apply(
      required(registry['inbox.ack']),
      { entries: [{ id: commentId, revision: 4 }] },
      worker,
      'ack-2',
    );
    expect((await notices()).every(({ acked_at }) => acked_at !== null)).toBe(true);
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([]);
  });

  it('lists a task comment without a block for its linked worker until acknowledged', async () => {
    const { store, registry, query, apply } = await seeded();
    const posted = await apply(
      required(registry['comment.add']),
      { task: KEY, text: 'Please also update the README.' },
      'operator',
      'operator-task-comment',
    );
    const commentId = posted.comment.id;
    await apply(
      required(registry['comment.add']),
      { task: KEY, text: 'My own note.' },
      worker,
      'worker-task-comment',
    );
    expect(await store.db.selectFrom('notification').select('id').execute()).toEqual([]);
    const inbox = await query(required(registry['inbox.get']), {}, worker);
    expect(inbox.comments).toEqual([
      expect.objectContaining({
        id: commentId,
        block: null,
        revision: 1,
        text: 'Please also update the README.',
        untrusted: true,
      }),
    ]);
    expect((await query(required(registry['inbox.get']), {}, orchestrator)).comments).toEqual([]);
    await apply(
      required(registry['inbox.ack']),
      { entries: [{ id: commentId, revision: 1 }] },
      worker,
      'ack-task-comment',
    );
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([]);
    await apply(
      required(registry['comment.edit']),
      { comment: commentId, text: 'Please update both docs.' },
      'operator',
      'edit-task-comment',
    );
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([
      expect.objectContaining({ id: commentId, block: null, revision: 2 }),
    ]);
  });

  it('filters blocks by role and projects before returning inbox data', async () => {
    const { store, registry, query, apply } = await seeded();
    const asked = await apply(
      required(registry['block.ask']),
      { task: KEY, text: 'Review this?' },
      worker,
      'ask-1',
    );
    await store.transaction(async (trx) => {
      await trx
        .insertInto('block')
        .values({
          task_id: 1,
          type: 'needs_input',
          reason: 'Operator only',
          author: worker,
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: AT,
        })
        .execute();
    });
    const inbox = await query(required(registry['inbox.get']), {}, orchestrator);
    expect(inbox.blocks.map(({ id }) => id)).toEqual([asked.block.id]);
    expect(inbox.blocks[0]?.addressee).toBe('orchestrator:dev');
    expect((await query(required(registry['inbox.get']), {}, worker)).blocks).toEqual([]);
    await expect(
      query(required(registry['inbox.get']), { project: 'other' }, worker),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      query(required(registry['task.get']), { task: OTHER_KEY }, worker),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      query(required(registry['task.history']), { task: OTHER_KEY }, worker),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      query(required(registry['task.get']), { task: KEY }, foreign),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      query(required(registry['task.history']), { task: KEY }, foreign),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      query(required(registry['inbox.get']), { project: 'board' }, foreign),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it("acks a block after an answer as already handled and the asker's answer by the block id", async () => {
    const { store, registry, query, apply } = await seeded();
    const ack = required(registry['inbox.ack']);
    const B1 = { entries: [{ id: 'B1' }] };
    const reads = async () =>
      (
        await store.db
          .selectFrom('event')
          .select('kind')
          .where('kind', '=', 'doorbell_read')
          .execute()
      ).length;
    const asked = await apply(
      required(registry['block.ask']),
      { task: KEY, text: 'Review this?' },
      worker,
      'ask',
    );
    expect(asked.block.id).toBe('B1');
    const answered = await apply(
      required(registry['block.answer']),
      { block: 'B1', text: 'Yes.' },
      orchestrator,
      'answer',
    );
    const before = await reads();

    await expect(apply(ack, B1, orchestrator, 'ack-addressee')).resolves.toEqual({
      acked: ['B1'],
      alreadyHandled: ['B1'],
    });
    expect(await reads()).toBe(before);

    await expect(apply(ack, B1, worker, 'ack-asker')).resolves.toEqual({ acked: ['B1'] });
    expect((await query(required(registry['inbox.get']), {}, worker)).comments).toEqual([]);
    const comment = await store.db
      .selectFrom('comment')
      .select('acked_revision')
      .where('id', '=', Number(answered.comment.id.slice(1)))
      .executeTakeFirstOrThrow();
    expect(comment.acked_revision).toBe(1);
    await expect(apply(ack, B1, worker, 'ack-asker-again')).resolves.toEqual({
      acked: ['B1'],
      alreadyHandled: ['B1'],
    });

    await store.transaction(async (trx) => {
      await trx
        .insertInto('block')
        .values({
          id: 2,
          task_id: 1,
          type: 'needs_input',
          reason: 'Operator only',
          author: worker,
          addressee_role: 'operator',
          target_column: null,
          state: 'open',
          outcome: null,
          outcome_reason: null,
          repeat_of: null,
          unblocked_by: null,
          unblocked_at: null,
          created_at: AT,
        })
        .execute();
    });
    await expect(
      apply(ack, { entries: [{ id: 'B2' }] }, worker, 'ack-operator-block'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it("acks the asker's answer by the id of an open block, then reports it already handled", async () => {
    const { store, registry, apply } = await seeded();
    const ack = required(registry['inbox.ack']);
    const B1 = { entries: [{ id: 'B1' }] };
    const blockRow = () =>
      store.db
        .selectFrom('notification')
        .select('acked_at')
        .where('block_id', '=', 1)
        .where('kind', '=', 'block')
        .executeTakeFirstOrThrow();
    await apply(
      required(registry['block.ask']),
      { task: KEY, text: 'Review this?' },
      worker,
      'ask',
    );
    const added = await apply(
      required(registry['comment.add']),
      { task: KEY, block: 'B1', text: 'Looking.' },
      orchestrator,
      'comment',
    );

    await expect(apply(ack, B1, worker, 'ack-asker')).resolves.toEqual({ acked: ['B1'] });
    expect((await blockRow()).acked_at).toBeNull();
    const comment = await store.db
      .selectFrom('comment')
      .select('acked_revision')
      .where('id', '=', Number(added.comment.id.slice(1)))
      .executeTakeFirstOrThrow();
    expect(comment.acked_revision).toBe(1);
    await expect(apply(ack, B1, worker, 'ack-asker-again')).resolves.toEqual({
      acked: ['B1'],
      alreadyHandled: ['B1'],
    });
    await expect(apply(ack, B1, 'agent:web/worker-2', 'ack-unlinked')).rejects.toMatchObject({
      code: 'forbidden',
    });

    await expect(apply(ack, B1, orchestrator, 'ack-addressee')).resolves.toEqual({
      acked: ['B1'],
    });
    expect((await blockRow()).acked_at).toBe(AT);
  });

  it('refuses a turn id that shares a block number', async () => {
    const { store, registry, query, apply } = await seeded();
    const asked = await apply(
      required(registry['block.ask']),
      { task: KEY, text: 'Review this?' },
      worker,
      'ask-1',
    );
    expect(asked.block.id).toBe('B1');
    for (const [entries, key] of [
      [[{ id: 'T1' }], 'ack-turn'],
      [[{ id: 'B1' }, { id: 'T1' }], 'ack-block-and-turn'],
    ] as const) {
      await expect(
        apply(required(registry['inbox.ack']), { entries: [...entries] }, orchestrator, key),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    const notices = await store.db
      .selectFrom('notification')
      .select('acked_at')
      .where('block_id', '=', 1)
      .execute();
    expect(notices).toEqual([{ acked_at: null }]);
    const events = await store.db.selectFrom('event').select('kind').execute();
    expect(events.filter(({ kind }) => kind === 'doorbell_read')).toEqual([]);

    const inbox = await query(required(registry['inbox.get']), {}, orchestrator);
    expect(inbox.turns).toEqual([]);
    const entry = OPERATIONS.find(({ id }) => id === 'inbox.get');
    expect(entry?.output.safeParse(inbox).success).toBe(true);
  });

  it('lists a turn to the role that may take it', async () => {
    const { store, registry, query, apply } = await seeded();
    const inboxGet = required(registry['inbox.get']);
    const output = OPERATIONS.find(({ id }) => id === 'inbox.get')?.output;
    const turnsFor = async (actor: Parameters<typeof query>[2]) => {
      const inbox = await query(inboxGet, {}, actor);
      expect(output?.safeParse(inbox).success).toBe(true);
      return inbox.turns;
    };
    const open = (taskId: number, reason: string) =>
      scanTransaction(store, config, async (trx) => {
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', taskId)
          .executeTakeFirstOrThrow();
        return openTurn(trx, { task, reason, handed: [], at: new Date(AT), config });
      });
    await open(1, 'Review the PR');

    expect(await turnsFor(orchestrator)).toEqual([
      {
        id: 'T1',
        task: KEY,
        column: 'dev',
        addressee: 'orchestrator:dev',
        reason: 'Review the PR',
        handed: [],
        head: null,
        at: AT,
        taken: null,
      },
    ]);
    expect(await turnsFor(worker)).toEqual([]);
    expect(await turnsFor('operator')).toEqual([]);

    await expect(
      apply(required(registry['inbox.ack']), { entries: [{ id: 'T1' }] }, orchestrator, 'ack'),
    ).resolves.toEqual({ acked: ['T1'] });
    for (const actor of [orchestrator, 'agent:qa/qa-2'] as const) {
      expect(await turnsFor(actor)).toEqual([
        expect.objectContaining({ id: 'T1', taken: { by: orchestrator, at: AT } }),
      ]);
    }
    expect(await turnsFor(worker)).toEqual([]);

    expect((await open(2, 'Merge it')).role).toBe('operator');
    expect(await turnsFor('operator')).toEqual([]);
    expect(await turnsFor(foreign)).toEqual([]);

    await scanTransaction(store, config, async (trx) => {
      for (const taskId of [1, 2]) {
        await closeTurns(trx, { taskId, reason: 'moved', at: new Date(AT) });
      }
    });
    for (const actor of [orchestrator, 'agent:qa/qa-2', worker, foreign, 'operator'] as const) {
      expect(await turnsFor(actor)).toEqual([]);
    }
  });
});

describe('authorized task PR refresh', () => {
  async function linked() {
    const ctx = await seeded();
    await ctx.store.db
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'pr',
        repo: 'o/r',
        number: 7,
        pr_state: 'active',
        pr_open: 0,
        session_id: null,
        role: null,
        source: 'manual',
        created_at: AT,
      })
      .execute();
    return ctx;
  }
  it('refreshes all linked refs outside the query transaction and reauthorizes after preparation', async () => {
    const { store, query } = await linked();
    let calls = 0;
    const registry = createOperationRegistry({
      config,
      clock,
      completeSince: new Map(),
      prPoller: () => async (_source, ref) => {
        calls++;
        expect(ref.number).toBe(7);
        // This transaction would deadlock if prepare held the query's transaction.
        await store.transaction(async (trx) => {
          await trx.deleteFrom('link').where('entity', '=', 'session').execute();
        });
        return { ok: false, error: { kind: 'timeout', message: 'Timeout' } };
      },
    });
    await expect(
      query(registry['task.get'], { task: KEY, refresh: true }, foreign),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toBe(0);
    await expect(
      query(registry['task.get'], { task: 'o/r#999', refresh: true }, 'operator'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toBe(0);
    await expect(
      query(registry['task.get'], { task: KEY, refresh: true }, worker),
    ).rejects.toMatchObject({ code: 'github_unavailable' });
    expect(calls).toBe(1);
    const success = createOperationRegistry({
      config,
      clock,
      completeSince: new Map(),
      prPoller: () => async () => {
        await store.transaction(async (trx) => {
          await trx.updateTable('task').set({ project: 'other' }).where('id', '=', 1).execute();
        });
        // A successful result is sufficient for this authorization boundary test.
        return { ok: true, value: { status: 'ok', facts: refreshFact, observedAt: AT } };
      },
    });
    await store.db
      .insertInto('link')
      .values({
        task_id: 1,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: 'worker-1',
        role: 'worker',
        source: 'manual',
        created_at: AT,
      })
      .execute();
    await expect(
      query(success['task.get'], { task: KEY, refresh: true }, worker),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('clears only recovered PR miss evidence after an explicit refresh finds merged facts', async () => {
    const { store, query } = await linked();
    const core = createObservationCore({ store, config, clock });
    const source = 'github:board:o/r';
    const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
    const unrelated = { kind: 'pr' as const, repo: 'o/r', number: 8 };
    await core.observe(source, {
      batch: {
        source,
        observedAt: AT,
        complete: true,
        cursor: sourceCursorSchema.parse('saved-cursor'),
        items: [],
        entities: [
          { ref, status: 'not_found' },
          { ref: unrelated, status: 'no_access' },
        ],
      },
      effectiveComplete: true,
      state: { lastCompleteAt: AT, gone: [ref, unrelated] },
      outcomes: [
        { ref, misses: 3, gone: true },
        { ref: unrelated, misses: 4, gone: true },
      ],
    });
    await core.reportSourceState('github:other:x/y', { gone: [] });
    await store.db
      .insertInto('source_miss')
      .values({
        source: 'github:other:x/y',
        ref_key: 'pr:x/y#7',
        ref: JSON.stringify({ kind: 'pr', repo: 'x/y', number: 7 }),
        misses: 5,
        gone: 1,
        outcome: 'not_found',
      })
      .execute();
    await core.reportSourceState('github-issues:board:o/r', { gone: [] });
    await store.db
      .insertInto('source_miss')
      .values({
        source: 'github-issues:board:o/r',
        ref_key: `ticket:github-issues:board:o/r:${KEY}`,
        ref: JSON.stringify({ kind: 'ticket', trackerId: 'github-issues:board:o/r', key: KEY }),
        misses: 6,
        gone: 1,
        outcome: 'no_access',
      })
      .execute();
    const otherMisses = await store.db
      .selectFrom('source_miss')
      .selectAll()
      .where('ref_key', '!=', 'pr:o/r#7')
      .orderBy('source')
      .execute();
    const sourceState = await store.db
      .selectFrom('source_state')
      .selectAll()
      .where('source', '=', source)
      .executeTakeFirstOrThrow();
    const status = () => getStatus({ store, config, clock, completeSince: core.completeSince });
    expect(
      (await status()).items.some(
        (item) => item.summary === `${KEY}: linked pull request not_found`,
      ),
    ).toBe(true);
    let calls = 0;
    const registry = createOperationRegistry({
      config,
      clock,
      completeSince: core.completeSince,
      prPoller: () => async (requestedSource, requestedRef) => {
        calls++;
        expect(requestedSource).toBe(source);
        expect(requestedRef).toEqual(ref);
        // The runner commits successful demand facts without absence outcomes or poll progress.
        await core.observe(source, {
          batch: {
            source,
            observedAt: AT,
            complete: false,
            items: [{ kind: 'pr', facts: refreshFact }],
            entities: [{ ref, status: 'ok' }],
          },
          effectiveComplete: false,
          state: { lastCompleteAt: AT, gone: [ref, unrelated] },
          outcomes: [],
        });
        return { ok: true, value: { status: 'ok', facts: refreshFact, observedAt: AT } };
      },
    });
    await query(registry['task.get'], { task: KEY, refresh: true }, 'operator');
    expect(calls).toBe(1);
    expect(
      (await status()).items.some(
        (item) => item.summary === `${KEY}: linked pull request not_found`,
      ),
    ).toBe(false);
    expect(
      await store.db.selectFrom('source_miss').selectAll().orderBy('source').execute(),
    ).toEqual(otherMisses);
    expect(
      await store.db
        .selectFrom('source_state')
        .selectAll()
        .where('source', '=', source)
        .executeTakeFirstOrThrow(),
    ).toEqual(sourceState);
    expect(core.completeSince.get(source)).toBe(AT);
    const ordinary = await core.context(source);
    expect(ordinary.observe.prs).toEqual([]);
    expect(ordinary.terminalPrs).toEqual([{ ref, state: 'merged' }]);
    expect(ordinary.prRechecks).toEqual([]);
    // Even an identical PR ref reported by a different source retains its own evidence.
    const foreignMiss = {
      source: 'github:other:x/y',
      ref_key: 'pr:o/r#7',
      ref: JSON.stringify(ref),
      misses: 3,
      gone: 1 as const,
      outcome: 'not_found' as const,
    };
    await store.db.insertInto('source_miss').values(foreignMiss).execute();
    await query(registry['task.get'], { task: KEY, refresh: true }, 'operator');
    expect(calls).toBe(2);
    expect(
      await store.db
        .selectFrom('source_miss')
        .selectAll()
        .where('source', '=', foreignMiss.source)
        .where('ref_key', '=', foreignMiss.ref_key)
        .executeTakeFirst(),
    ).toEqual(foreignMiss);
    expect(
      await store.db
        .selectFrom('source_miss')
        .selectAll()
        .where('source', '=', source)
        .where('ref_key', '=', foreignMiss.ref_key)
        .execute(),
    ).toEqual([]);
  });
  it('fails visibly when the poller is missing rather than returning cached facts', async () => {
    const { query, registry } = await linked();
    await expect(
      query(registry['task.get'], { task: KEY, refresh: true }, 'operator'),
    ).rejects.toMatchObject({ code: 'github_unavailable' });
    await expect(query(registry['task.get'], { task: KEY }, 'operator')).resolves.toHaveProperty(
      'task.key',
      KEY,
    );
  });
});

const refreshFact = {
  repo: 'o/r',
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  title: 'Work',
  author: 'worker',
  headSha: 'a'.repeat(40),
  headBranch: 'work',
  state: 'merged' as const,
  draft: false,
  mergeable: 'unknown' as const,
  mergeState: 'unknown' as const,
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: [],
  updatedAt: AT,
};

it('shares one ten-second deadline across distinct PR refreshes and deduplicates refs', async () => {
  vi.useFakeTimers();
  try {
    const ref = { kind: 'pr' as const, repo: 'o/r', number: 7 };
    const calls: number[] = [];
    const pending = refreshPrs(
      config,
      'board',
      [ref, ref, { ...ref, number: 8 }],
      async (_source, _ref, options) => {
        calls.push(options.timeoutMs);
        if (calls.length === 1) {
          vi.setSystemTime(Date.now() + 7_000);
          return { ok: true, value: { status: 'ok', facts: refreshFact, observedAt: AT } };
        }
        return new Promise(() => {});
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'github_unavailable' });
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(calls).toEqual([10_000, 3_000]);
  } finally {
    vi.useRealTimers();
  }
});

it('task.get and detailed status expose known reset facts and clear them only on observed recovery', async () => {
  const { store, registry, query } = await seeded();
  const core = createObservationCore({ store, config, clock });
  const reset = '2026-11-04T07:00:00.000Z';
  const base = {
    id: 'worker-1',
    spurProject: 'web',
    branch: null,
    pr: null,
    links: {},
    lifecycle: 'running' as const,
    healthSince: AT,
    lastActivityAt: null,
    endedAt: null,
    endReason: null,
  };
  async function observe(health: 'rate_limited' | 'working', rateLimitResetAt?: string) {
    await core.observe('spur', {
      batch: {
        source: 'spur',
        complete: true,
        observedAt: AT,
        sessionTransitions: [],
        items: [
          {
            kind: 'session',
            facts: {
              ...base,
              health,
              ...(rateLimitResetAt === undefined ? {} : { rateLimitResetAt }),
            },
          },
        ],
        entities: [],
      },
      effectiveComplete: true,
      outcomes: [],
      state: { lastCompleteAt: AT, gone: [] },
    });
  }
  const taskGet = required(registry['task.get']);
  await observe('rate_limited', reset);
  const known = await query(taskGet, { task: KEY }, 'operator');
  expect(known.sessions).toEqual([
    { ...base, health: 'rate_limited', rateLimitResetAt: reset, links: [] },
  ]);
  expect(OPERATIONS.find(({ id }) => id === 'task.get')?.output.safeParse(known).success).toBe(
    true,
  );
  const detail = await getStatus(
    { store, config, clock, completeSince: core.completeSince },
    { detail: true },
  );
  expect(detail.tasks.find(({ key }) => key === KEY)?.sessions).toContainEqual(
    expect.objectContaining({ rateLimitResetAt: reset, health: 'rate_limited' }),
  );
  await observe('rate_limited');
  expect((await query(taskGet, { task: KEY }, 'operator')).sessions?.[0]).not.toHaveProperty(
    'rateLimitResetAt',
  );
  await observe('working');
  expect((await query(taskGet, { task: KEY }, 'operator')).sessions?.[0]).toMatchObject({
    health: 'working',
  });
  expect((await query(taskGet, { task: KEY }, 'operator')).sessions?.[0]).not.toHaveProperty(
    'rateLimitResetAt',
  );
  await store.transaction((trx) =>
    trx.updateTable('link').set({ banned: 1 }).where('entity', '=', 'session').execute(),
  );
  expect((await query(taskGet, { task: KEY }, 'operator')).sessions).toEqual([]);
});
