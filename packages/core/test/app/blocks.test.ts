import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  createApply,
  createBlockMutations,
  openStore,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const KEY = 'o/r#101';
const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const clock = { now: () => NOW };
const author = 'agent:web/worker-1';
const secondWorker = 'agent:web/worker-2';
const orchestrator = 'agent:qa/qa-1';
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
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
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const ops = createBlockMutations(config);
const stores: Store[] = [];

async function seeded(file = join(mkdtempSync(join(tmpdir(), 'core-blocks-')), 'board.db')) {
  const store = openStore(file);
  stores.push(store);
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        key: KEY,
        membership: 'active',
        archive_reason: null,
        column: 'dev',
      })
      .execute();
    await trx
      .insertInto('link')
      .values(
        [
          { id: 1, session_id: 'worker-1' },
          { id: 2, session_id: 'worker-2' },
        ].map(({ id, session_id }) => ({
          ...sampleRows.link,
          id,
          entity: 'session' as const,
          repo: null,
          number: null,
          pr_state: null,
          session_id,
          role: 'worker' as const,
        })),
      )
      .execute();
  });
  return { store, file, apply: createApply({ store, clock, config }) };
}

async function codeBlock(store: Store) {
  return store.transaction(async (trx) => {
    const row = await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: 'code',
        reason: 'Fix failing checks',
        author: orchestrator,
        addressee_role: 'worker',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: new Date(NOW).toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return `B${String(row.id)}`;
  });
}

async function events(store: Store) {
  const rows = await store.db.selectFrom('event').selectAll().orderBy('id').execute();
  return rows.map((row) => {
    const payload: unknown = JSON.parse(row.payload);
    return {
      kind: row.kind,
      actor: row.actor,
      project: row.project,
      task: row.task_id,
      payload,
    };
  });
}

async function counts(store: Store) {
  const [blocks, comments, journal, commands] = await Promise.all([
    store.db.selectFrom('block').select('id').execute(),
    store.db.selectFrom('comment').select('id').execute(),
    store.db.selectFrom('event').select('id').execute(),
    store.db.selectFrom('command').select('key').execute(),
  ]);
  return {
    blocks: blocks.length,
    comments: comments.length,
    journal: journal.length,
    commands: commands.length,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('block and comment mutations', () => {
  it('asks, answers, and clarifies on one block with linked untrusted comments and ordered events', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Which version?' }, author, 'ask-1');
    expect(asked.block).toMatchObject({ addressee: 'orchestrator:dev', state: 'open' });
    const answered = await apply(
      ops.answer,
      { block: asked.block.id, text: 'Use v2.' },
      orchestrator,
      'answer-1',
    );
    expect(answered.block).toMatchObject({ outcome: 'done', unblockedBy: orchestrator });
    expect(answered.comment).toMatchObject({ block: asked.block.id, revision: 1, untrusted: true });
    const rejected = await apply(
      ops.answer,
      { block: asked.block.id, text: 'Again.' },
      orchestrator,
      'answer-2',
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(CommandError);
    if (!(rejected instanceof CommandError)) throw new Error('Expected a command error');
    expect(rejected.code).toBe('block_not_open');
    expect(rejected.hint).toContain('done by');
    const clarification = await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'One clarification.' },
      author,
      'comment-1',
    );
    expect(clarification.comment).toMatchObject({ block: asked.block.id, untrusted: true });
    expect(await counts(store)).toMatchObject({ blocks: 1, comments: 3 });
    expect((await events(store)).map((event) => event.kind)).toEqual([
      'block_opened',
      'comment_added',
      'comment_added',
      'block_unblocked',
      'comment_added',
    ]);
    for (const event of await events(store)) {
      expect(event.project).toBe('proj');
      expect(event.task).toBe(1);
      expect(event.payload).toBeTypeOf('object');
    }
  });

  it('escalates once and creates dependency or external blocks addressed to the author role', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
    const escalated = await apply(ops.escalate, { block: asked.block.id }, orchestrator, 'esc-1');
    expect(escalated.block.addressee).toBe('operator');
    await apply(ops.escalate, { block: asked.block.id }, 'operator', 'esc-2');
    const dependency = await apply(
      ops.create,
      { task: KEY, type: 'dependency', reason: 'Wait for upstream.' },
      orchestrator,
      'create-1',
    );
    const external = await apply(
      ops.create,
      { task: KEY, type: 'external', reason: 'Wait for an answer.' },
      'operator',
      'create-2',
    );
    expect(dependency.block.addressee).toBe('orchestrator:dev');
    expect(external.block.addressee).toBe('operator');
    expect((await events(store)).map((event) => event.kind)).toEqual([
      'block_opened',
      'comment_added',
      'block_escalated',
      'block_opened',
      'block_opened',
    ]);
  });

  it('accepts done from a later linked worker and records that session', async () => {
    const { store, apply } = await seeded();
    const id = await codeBlock(store);
    await expect(
      apply(ops.answer, { block: id, text: 'No.' }, secondWorker, 'wrong'),
    ).rejects.toMatchObject({ code: 'wrong_block_type' });
    const done = await apply(
      ops.unblock,
      { mode: 'done', block: id, ref: 'commit-1' },
      secondWorker,
      'done-1',
    );
    expect(done.block).toMatchObject({
      outcome: 'done',
      outcomeReason: 'commit-1',
      unblockedBy: secondWorker,
    });
    await expect(
      apply(ops.unblock, { mode: 'done', block: id }, author, 'done-2'),
    ).rejects.toMatchObject({ code: 'block_not_open' });
    await expect(
      apply(
        ops.unblock,
        { mode: 'reason', block: id, reason: 'Already done.' },
        orchestrator,
        'reason-2',
      ),
    ).rejects.toMatchObject({ code: 'block_not_open' });
    expect(await events(store)).toMatchObject([
      {
        kind: 'block_unblocked',
        actor: 'agent',
        payload: { block: id, outcome: 'done', reason: 'commit-1' },
      },
    ]);
  });

  it('withdraws only the author question and stores its outside answer on the block', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
    await expect(
      apply(
        ops.unblock,
        { mode: 'withdraw', block: asked.block.id, answer: 'Elsewhere.' },
        secondWorker,
        'withdraw-foreign',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const result = await apply(
      ops.unblock,
      { mode: 'withdraw', block: asked.block.id, answer: 'Elsewhere.' },
      author,
      'withdraw-own',
    );
    expect(result.block).toMatchObject({ outcome: 'withdrawn', unblockedBy: author });
    const comments = await store.db
      .selectFrom('comment')
      .select(['block_id', 'text'])
      .orderBy('id')
      .execute();
    expect(comments).toEqual([
      { block_id: 1, text: 'Question?' },
      { block_id: 1, text: 'Elsewhere.' },
    ]);
    expect((await events(store)).map((event) => event.kind)).toContain('block_unblocked');
  });

  it('edits after acknowledgement as an observable clarification and rejects a stale revision', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
    const comment = await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'Original.' },
      author,
      'comment-1',
    );
    await apply(
      ops.ack,
      { entries: [{ id: comment.comment.id, revision: 1 }] },
      secondWorker,
      'ack-1',
    );
    const edited = await apply(
      ops.edit,
      { comment: comment.comment.id, text: 'Correction.' },
      author,
      'edit-1',
    );
    expect(edited.comment).toMatchObject({
      revision: 2,
      ackedRevision: 1,
      block: asked.block.id,
      untrusted: true,
    });
    await expect(
      apply(
        ops.edit,
        { comment: comment.comment.id, text: 'Foreign edit.' },
        secondWorker,
        'edit-foreign',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      apply(
        ops.ack,
        { entries: [{ id: comment.comment.id, revision: 1 }] },
        secondWorker,
        'ack-stale',
      ),
    ).rejects.toMatchObject({ code: 'stale_comment_revision' });
    expect((await events(store)).filter((event) => event.kind === 'comment_edited')).toMatchObject([
      { payload: { comment: comment.comment.id, revision: 2, clarification: true } },
    ]);
    expect((await events(store)).map((event) => event.kind)).toEqual([
      'block_opened',
      'comment_added',
      'comment_added',
      'comment_acked',
      'comment_edited',
    ]);
  });

  it.each(['answer', 'withdraw'] as const)(
    'rolls back %s after its comment insert when block update fails',
    async (mode) => {
      const { store, apply } = await seeded();
      const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
      const before = await counts(store);
      await sql
        .raw(
          "CREATE TEMP TRIGGER fail_block_update BEFORE UPDATE ON block BEGIN SELECT RAISE(FAIL, 'injected'); END",
        )
        .execute(store.db);
      const action =
        mode === 'answer'
          ? apply(
              ops.answer,
              { block: asked.block.id, text: 'Answer.' },
              orchestrator,
              'answer-fail',
            )
          : apply(
              ops.unblock,
              { mode: 'withdraw', block: asked.block.id, answer: 'Answer.' },
              author,
              'withdraw-fail',
            );
      await expect(action).rejects.toThrow('injected');
      expect(await counts(store)).toEqual(before);
      expect(
        (
          await store.db
            .selectFrom('block')
            .select('state')
            .where('id', '=', 1)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('open');
    },
  );

  it('replays a real ask after reopening the database without another block or comment', async () => {
    const { store, file, apply } = await seeded();
    const first = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'same-key');
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openStore(file);
    stores.push(reopened);
    const replay = await createApply({ store: reopened, clock, config })(
      ops.ask,
      { task: KEY, text: 'Question?' },
      author,
      'same-key',
    );
    expect(replay).toEqual(first);
    expect(await counts(reopened)).toMatchObject({
      blocks: 1,
      comments: 1,
      journal: 2,
      commands: 1,
    });
  });
});
