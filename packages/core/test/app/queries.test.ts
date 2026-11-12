import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_KINDS, OPERATIONS, configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApply,
  createOperationRegistry,
  createQuery,
  openStore,
  type Store,
} from '../../src/index.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { closeTurns, openTurn } from '../../src/app/turns.ts';

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
        { name: 'qa', role: 'worker' },
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
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'board-queries-')), 'board.db'));
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
