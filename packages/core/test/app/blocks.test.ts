import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ActorId, type ColumnId, type Config } from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  createApply,
  createBlockMutations,
  createQuery,
  createSender,
  openStore,
  type Store,
} from '../../src/index.ts';
import {
  closeOpenBlock,
  editInboundComment,
  openSystemBlock,
  recordInboundBlockMessage,
} from '../../src/app/blocks.ts';
import { personaFor } from '../../src/app/block-thread.ts';
import { withVia } from '../../src/app/board-utils.ts';
import { raiseItem } from '../../src/app/feed.ts';
import { reconcileItems } from '../../src/app/fromYou.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { projectSubject, taskSubject } from '../../src/app/subject.ts';
import { createTaskQueries } from '../../src/app/task-queries.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { observeGateway } from '../support/observe.ts';
import {
  conversationConfig,
  conversationStore,
  startConversation,
} from '../support/conversation.ts';

const KEY = 'o/r#101';
const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const clock = { now: () => NOW };
const author = 'agent:web/worker-1';
const secondWorker = 'agent:web/worker-2';
const orchestrator = 'agent:qa/qa-1';
const operatorAgent = 'agent:ops/ops-1';
const remoteOperator = 'agent:remote-ops/ops-2';
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'web', role: 'worker' },
        { name: 'qa', role: 'orchestrator' },
        { name: 'ops', role: 'operator' },
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
      spurProjects: [{ name: 'remote-ops', role: 'operator' }],
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
  const [blocks, comments, journal, commands, outbox] = await Promise.all([
    store.db.selectFrom('block').select('id').execute(),
    store.db.selectFrom('comment').select('id').execute(),
    store.db.selectFrom('event').select('id').execute(),
    store.db.selectFrom('command').select('key').execute(),
    store.db.selectFrom('outbox').select('id').execute(),
  ]);
  return {
    blocks: blocks.length,
    comments: comments.length,
    journal: journal.length,
    commands: commands.length,
    outbox: outbox.length,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('block and comment mutations', () => {
  it('enqueues one operator conversation open and one linked clarification reply', async () => {
    const { store, apply } = await seeded();
    await store.transaction((trx) =>
      trx.updateTable('task').set({ column: 'qa' }).where('id', '=', 1).execute(),
    );
    const asked = await apply(ops.ask, { task: KEY, text: 'Which version?' }, author, 'ask-1');
    expect(asked.block.addressee).toBe('operator');
    const first = await store.db.selectFrom('outbox').selectAll().execute();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'conversation.open', state: 'pending' });
    const open = first[0];
    if (open === undefined) throw new Error('Expected a conversation.open row');
    expect(JSON.parse(open.payload)).toMatchObject({
      blockId: 1,
      commentId: 1,
      persona: { name: 'web', role: 'worker' },
    });
    expect(
      await store.db
        .selectFrom('comment')
        .select('delivery_state')
        .where('id', '=', 1)
        .executeTakeFirst(),
    ).toEqual({ delivery_state: 'pending' });

    await apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, 'operator', 'answer-1');
    const beforeClarification = await store.db
      .selectFrom('outbox')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(beforeClarification.map((row) => row.kind)).toEqual([
      'conversation.open',
      'conversation.reply',
      'conversation.close',
    ]);
    expect(JSON.parse(beforeClarification[2]?.payload ?? '{}')).toMatchObject({
      blockId: 1,
      text: 'resolved: done (operator)',
    });

    await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'One clarification.' },
      author,
      'comment-1',
    );
    const rows = await store.db.selectFrom('outbox').selectAll().orderBy('id').execute();
    expect(rows).toHaveLength(4);
    const answer = rows[1];
    const clarification = rows[3];
    if (answer === undefined || clarification === undefined) {
      throw new Error('Expected answer and clarification reply rows');
    }
    expect(clarification).toMatchObject({
      kind: 'conversation.reply',
      state: 'pending',
      parent_outbox_id: rows[2]?.id,
    });
    expect(JSON.parse(clarification.payload)).toMatchObject({ blockId: 1, commentId: 3 });
  });

  it('queues earlier linked comments with their authors when a dependency escalates', async () => {
    const { store, apply } = await seeded();
    const created = await apply(
      ops.create,
      { task: KEY, type: 'dependency', reason: 'Needs outside work.' },
      orchestrator,
      'create-1',
    );
    await apply(
      ops.add,
      { task: KEY, block: created.block.id, text: 'Question?' },
      author,
      'comment-1',
    );
    await apply(
      ops.add,
      { task: KEY, block: created.block.id, text: 'My note.' },
      orchestrator,
      'comment-2',
    );
    await apply(
      ops.add,
      { task: KEY, block: created.block.id, text: 'More context.' },
      author,
      'comment-3',
    );
    expect(await counts(store)).toMatchObject({ outbox: 0 });

    await apply(ops.escalate, { block: created.block.id }, orchestrator, 'escalate-1');
    const rows = await store.db.selectFrom('outbox').selectAll().orderBy('id').execute();
    expect(rows.map((row) => row.kind)).toEqual([
      'conversation.open',
      'conversation.reply',
      'conversation.reply',
    ]);
    expect(rows.map((row) => row.parent_outbox_id)).toEqual([null, rows[0]?.id, rows[1]?.id]);
    const payloads = rows.map((row) => {
      const payload: unknown = JSON.parse(row.payload);
      return payload;
    });
    expect(payloads).toMatchObject([
      { commentId: 1, text: 'Question?', persona: { name: 'web', role: 'worker' } },
      { commentId: 2, persona: { name: 'qa', role: 'orchestrator' } },
      { commentId: 3, persona: { name: 'web', role: 'worker' } },
    ]);
    expect(
      await store.db
        .selectFrom('comment')
        .select('delivery_state')
        .where('block_id', '=', 1)
        .orderBy('id')
        .execute(),
    ).toEqual(Array.from({ length: 3 }, () => ({ delivery_state: 'pending' })));
    await apply(ops.escalate, { block: created.block.id }, orchestrator, 'escalate-repeat');
    expect(await counts(store)).toMatchObject({ outbox: 3 });
  });

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
    expect(await counts(store)).toMatchObject({ outbox: 1 });
    const beforeRepeat = await events(store);
    await apply(ops.escalate, { block: asked.block.id }, orchestrator, 'esc-original-repeat');
    expect(await events(store)).toEqual(beforeRepeat);
    await apply(ops.escalate, { block: asked.block.id }, 'operator', 'esc-2');
    expect(await counts(store)).toMatchObject({ outbox: 1 });
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
    await expect(
      apply(ops.escalate, { block: asked.block.id }, author, 'esc-unrelated'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await events(store)).filter((event) => event.kind === 'block_escalated')).toHaveLength(
      1,
    );
  });

  it('addresses linked clarification comments to the other participant in both directions', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
    await apply(ops.answer, { block: asked.block.id, text: 'Answer.' }, orchestrator, 'answer-1');
    await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'More detail.' },
      orchestrator,
      'clarify-answerer',
    );
    await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'Thanks.' },
      author,
      'clarify-asker',
    );
    const comments = (await events(store)).filter((event) => event.kind === 'comment_added');
    expect(comments.at(-2)?.payload).toMatchObject({ addressee: 'worker' });
    expect(comments.at(-1)?.payload).toMatchObject({ addressee: 'orchestrator:dev' });
  });

  it('routes an author clarification to the operator who answered without escalation', async () => {
    const { store, apply } = await seeded();
    const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, author, 'ask-1');
    expect(asked.block.addressee).toBe('orchestrator:dev');
    const answer = await apply(
      ops.answer,
      { block: asked.block.id, text: 'Answer.' },
      'operator',
      'answer-1',
    );
    expect(answer.block.unblockedBy).toBe('operator');
    await apply(
      ops.add,
      { task: KEY, block: asked.block.id, text: 'One follow-up.' },
      author,
      'clarify-1',
    );
    expect((await events(store)).at(-1)?.payload).toMatchObject({ addressee: 'operator' });
  });

  it("addresses dependency and external blocks from the project's operator agent to operator", async () => {
    const { store, apply } = await seeded();
    for (const type of ['dependency', 'external'] as const) {
      const created = await apply(
        ops.create,
        { task: KEY, type, reason: 'Waiting for a decision.' },
        operatorAgent,
        `operator-${type}`,
      );
      expect(created.block).toMatchObject({ author: operatorAgent, addressee: 'operator' });
    }
    expect(await counts(store)).toMatchObject({ outbox: 0 });
  });

  it("refuses a block from another project's operator agent", async () => {
    const { apply } = await seeded();
    await expect(
      apply(
        ops.create,
        { task: KEY, type: 'external', reason: 'Waiting for a decision.' },
        remoteOperator,
        'remote-external',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it("addresses a comment on an open block another project's operator wrote to worker", async () => {
    const { store, apply } = await seeded();
    const id = await seedBlock(store, {
      type: 'needs_input',
      author: remoteOperator,
      addressee: 'operator',
    });
    await apply(ops.add, { task: KEY, block: id, text: 'A comment.' }, 'operator', 'remote-1');
    expect((await events(store)).at(-1)?.payload).toMatchObject({ addressee: 'worker' });
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

  it.each(['answer', 'done', 'reason', 'withdraw'] as const)(
    'closes a registered conversation through %s',
    async (mode) => {
      const { store, apply } = await seeded();
      const id =
        mode === 'done' || mode === 'reason'
          ? await codeBlock(store)
          : (await apply(ops.ask, { task: KEY, text: 'Question?' }, author, `ask-${mode}`)).block
              .id;
      const blockId = Number(id.slice(1));
      await store.transaction((trx) =>
        trx
          .insertInto('conversation')
          .values({
            gateway: 'fake-slack-like',
            ref: 'thread-1',
            space: 'orchestrators',
            task_id: 1,
            block_id: blockId,
            purpose: 'block',
            state: 'open',
            root_message_ref: 'root-1',
            after_message_ref: null,
            created_at: new Date(NOW).toISOString(),
            closed_at: null,
          })
          .execute(),
      );
      if (mode === 'answer') {
        await apply(ops.answer, { block: id, text: 'Yes.' }, 'operator', `close-${mode}`);
      } else if (mode === 'done') {
        await apply(ops.unblock, { mode: 'done', block: id }, secondWorker, `close-${mode}`);
      } else if (mode === 'reason') {
        await apply(
          ops.unblock,
          { mode: 'reason', block: id, reason: 'No longer needed.' },
          'operator',
          `close-${mode}`,
        );
      } else {
        await apply(
          ops.unblock,
          { mode: 'withdraw', block: id, answer: 'Elsewhere.' },
          author,
          `close-${mode}`,
        );
      }
      const block = await store.db
        .selectFrom('block')
        .select(['state', 'outcome', 'unblocked_by'])
        .where('id', '=', blockId)
        .executeTakeFirstOrThrow();
      expect(block.state).toBe('unblocked');
      expect(
        await store.db
          .selectFrom('conversation')
          .select(['state', 'closed_at'])
          .where('ref', '=', 'thread-1')
          .executeTakeFirst(),
      ).toMatchObject({ state: 'closed', closed_at: new Date(NOW).toISOString() });
      const closes = await store.db
        .selectFrom('outbox')
        .select(['payload', 'dedupe_key'])
        .where('kind', '=', 'conversation.close')
        .execute();
      const explicit = closes.filter(
        (row) =>
          (JSON.parse(row.payload) as { targetConversation?: string }).targetConversation ===
          'thread-1',
      );
      expect(explicit).toHaveLength(1);
      expect(JSON.parse(explicit[0]?.payload ?? '{}')).toMatchObject({
        blockId,
        text: `resolved: ${String(block.outcome)} (${String(block.unblocked_by)})`,
        targetConversation: 'thread-1',
      });
    },
  );

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
    expect(result.block).toMatchObject({
      outcome: 'withdrawn',
      outcomeReason: 'Elsewhere.',
      unblockedBy: author,
    });
    const comments = await store.db
      .selectFrom('comment')
      .select(['block_id', 'text'])
      .orderBy('id')
      .execute();
    expect(comments).toEqual([
      { block_id: 1, text: 'Question?' },
      { block_id: 1, text: 'Elsewhere.' },
    ]);
    expect((await events(store)).at(-1)).toMatchObject({
      kind: 'block_unblocked',
      payload: { block: asked.block.id, outcome: 'withdrawn', reason: 'Elsewhere.' },
    });
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
      const asked = await apply(ops.ask, { task: KEY, text: 'Question?' }, orchestrator, 'ask-1');
      const before = await counts(store);
      await sql
        .raw(
          "CREATE TEMP TRIGGER fail_block_update BEFORE UPDATE ON block BEGIN SELECT RAISE(FAIL, 'injected'); END",
        )
        .execute(store.db);
      const action =
        mode === 'answer'
          ? apply(ops.answer, { block: asked.block.id, text: 'Answer.' }, 'operator', 'answer-fail')
          : apply(
              ops.unblock,
              { mode: 'withdraw', block: asked.block.id, answer: 'Answer.' },
              orchestrator,
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
    const first = await apply(ops.ask, { task: KEY, text: 'Question?' }, orchestrator, 'same-key');
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = openStore(file);
    stores.push(reopened);
    const replay = await createApply({ store: reopened, clock, config })(
      ops.ask,
      { task: KEY, text: 'Question?' },
      orchestrator,
      'same-key',
    );
    expect(replay).toEqual(first);
    expect(await counts(reopened)).toMatchObject({
      blocks: 1,
      comments: 1,
      journal: 2,
      commands: 1,
      outbox: 1,
    });
  });
});

const curator = 'agent:cur/cur-1';

function withCurator(orchestrators: Partial<Record<ColumnId, string>> = {}): Config {
  return configSchema.parse({
    ...config,
    projects: config.projects.map((project) =>
      project.id === 'proj'
        ? {
            ...project,
            spurProjects: [...project.spurProjects, { name: 'cur', role: 'curator' }],
            columns: project.columns.map((column) => ({
              ...column,
              orchestrator: orchestrators[column.id] ?? column.orchestrator,
            })),
          }
        : project,
    ),
  });
}

const reviewer = 'agent:rev/rev-1';

/** Adds `rev` as the `review` column's orchestrator, with or without the `cur` curator. */
function withReviewer(curated: boolean): Config {
  const base = curated ? withCurator() : config;
  return configSchema.parse({
    ...base,
    projects: base.projects.map((project) =>
      project.id === 'proj'
        ? {
            ...project,
            spurProjects: [...project.spurProjects, { name: 'rev', role: 'orchestrator' }],
            columns: project.columns.map((column) =>
              column.id === 'review' ? { ...column, orchestrator: 'rev' } : column,
            ),
          }
        : project,
    ),
  });
}

/** A board on the shared seed whose task sits in `column`; `dev` is orchestrated by `qa`. */
async function curatorBoard(column: ColumnId = 'dev', used: Config = withCurator()) {
  const { store, file } = await seeded();
  await store.transaction((trx) =>
    trx.updateTable('task').set({ column }).where('id', '=', 1).execute(),
  );
  return {
    store,
    file,
    apply: createApply({ store, clock, config: used }),
    ops: createBlockMutations(used),
  };
}

async function seedBlock(
  store: Store,
  values: {
    type: 'code' | 'needs_input';
    author: ActorId;
    addressee: 'worker' | `orchestrator:dev` | 'operator';
  },
) {
  return store.transaction(async (trx) => {
    const row = await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: values.type,
        reason: 'Seeded block',
        author: values.author,
        addressee_role: values.addressee,
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

async function escalations(store: Store) {
  return (await events(store))
    .filter((event) => event.kind === 'block_escalated')
    .map((event) => event.payload);
}

describe('curator routing', () => {
  it('leaves a question with the column orchestrator when one is set', async () => {
    const { apply, ops: curated } = await curatorBoard();
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(asked.block.addressee).toBe('orchestrator:dev');
  });

  it('sends an orchestrator question to the curator, or the operator without one', async () => {
    const { apply, ops: curated } = await curatorBoard();
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    expect(asked.block.addressee).toBe('curator');
    const plain = await seeded();
    const without = await plain.apply(ops.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    expect(without.block.addressee).toBe('operator');
  });

  it('sends a question in an unorchestrated column to the curator, or the operator', async () => {
    const { apply, ops: curated } = await curatorBoard('qa');
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(asked.block.addressee).toBe('curator');
    const plain = await curatorBoard('qa', config);
    const without = await plain.apply(plain.ops.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(without.block.addressee).toBe('operator');
  });

  it('keeps a column assigned to the operator at the operator', async () => {
    const { apply, ops: curated } = await curatorBoard(
      'review',
      withCurator({ review: 'operator' }),
    );
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(asked.block.addressee).toBe('operator');
  });

  it.each(['dev', 'qa'] as const)(
    'sends the curator own question to the operator in %s',
    async (column) => {
      const { apply, ops: curated } = await curatorBoard(column);
      const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'ask');
      expect(asked.block.addressee).toBe('operator');
    },
  );

  it('routes an operator-role agent to the curator when the column has no orchestrator', async () => {
    const { apply, ops: curated } = await curatorBoard('qa');
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, operatorAgent, 'ask');
    expect(asked.block.addressee).toBe('curator');
  });

  it('treats a dual-role project as the orchestrator for its dependency blocks', async () => {
    const used = withCurator({ dev: 'cur' });
    const { store, apply, ops: curated } = await curatorBoard('dev', used);
    const created = await apply(
      curated.create,
      { task: KEY, type: 'dependency', reason: 'Waiting.' },
      curator,
      'create',
    );
    expect(created.block.addressee).toBe('orchestrator:dev');
    expect(await store.db.selectFrom('notification').select('id').execute()).toEqual([]);
    const own = await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'own');
    expect(own.block.addressee).toBe('operator');
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(asked.block.addressee).toBe('orchestrator:dev');
    const hop = await apply(curated.escalate, { block: asked.block.id }, curator, 'hop-1');
    expect(hop.block.addressee).toBe('operator');
    expect(await escalations(store)).toEqual([
      { block: asked.block.id, from: 'orchestrator:dev', to: 'operator' },
    ]);
    expect(
      await store.db
        .selectFrom('notification')
        .select('id')
        .where('role', '=', 'curator')
        .execute(),
    ).toEqual([]);
    const top = await apply(curated.escalate, { block: asked.block.id }, curator, 'hop-2');
    expect(top.block.addressee).toBe('operator');
    expect(await escalations(store)).toHaveLength(1);
  });

  it("routes a column orchestrator's own question up the chain and another orchestrator's question to it", async () => {
    for (const [used, expected] of [
      [withReviewer(true), 'curator'],
      [withReviewer(false), 'operator'],
    ] as const) {
      const { apply, ops: curated } = await curatorBoard('review', used);
      const own = await apply(curated.ask, { task: KEY, text: 'Q?' }, reviewer, 'own');
      expect(own.block.addressee).toBe(expected);
      const other = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'other');
      expect(other.block.addressee).toBe('orchestrator:review');
    }
  });
});

describe('curator escalation', () => {
  it('keeps a question at its stored addressee after a column move and escalates it past its author', async () => {
    const used = withReviewer(true);
    const { store, apply, ops: curated } = await curatorBoard('review', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    expect(block.addressee).toBe('orchestrator:review');
    await store.transaction((trx) =>
      trx.updateTable('task').set({ column: 'dev' }).where('id', '=', 1).execute(),
    );
    const get = () =>
      createQuery({ store, clock, config: used })(
        createTaskQueries({ config: used, clock, completeSince: new Map() }).get,
        { task: KEY },
        'operator',
      );
    expect((await get()).blocks.map((entry) => entry.addressee)).toEqual(['orchestrator:review']);
    await expect(
      apply(curated.escalate, { block: block.id }, orchestrator, 'author'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const toCurator = await apply(curated.escalate, { block: block.id }, reviewer, 'esc-1');
    expect(toCurator.block.addressee).toBe('curator');
    const toOperator = await apply(curated.escalate, { block: block.id }, curator, 'esc-2');
    expect(toOperator.block.addressee).toBe('operator');
    expect(await escalations(store)).toEqual([
      { block: block.id, from: 'orchestrator:review', to: 'curator' },
      { block: block.id, from: 'curator', to: 'operator' },
    ]);
    expect((await get()).blocks.map((entry) => entry.addressee)).toEqual(['operator']);
  });

  it("escalates a column orchestrator's own question from the curator to the operator, never back to its column", async () => {
    const { store, apply, ops: curated } = await curatorBoard('review', withReviewer(true));
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, reviewer, 'ask');
    expect(block.addressee).toBe('curator');
    await expect(
      apply(curated.escalate, { block: block.id }, reviewer, 'author'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const moved = await apply(curated.escalate, { block: block.id }, curator, 'esc');
    expect(moved.block.addressee).toBe('operator');
    expect(await escalations(store)).toEqual([
      { block: block.id, from: 'curator', to: 'operator' },
    ]);
  });

  it('walks a question up the chain and treats each retry as a no-op', async () => {
    const { store, apply, ops: curated } = await curatorBoard();
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const id = block.id;

    const toCurator = await apply(curated.escalate, { block: id }, orchestrator, 'esc-1');
    expect(toCurator.block.addressee).toBe('curator');
    expect(await escalations(store)).toEqual([
      { block: id, from: 'orchestrator:dev', to: 'curator' },
    ]);

    const before = await events(store);
    const retry = await apply(curated.escalate, { block: id }, orchestrator, 'retry-curator');
    expect(retry.block.addressee).toBe('curator');
    expect(await events(store)).toEqual(before);
    await expect(
      apply(curated.escalate, { block: id }, secondWorker, 'worker-at-curator'),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const toOperator = await apply(curated.escalate, { block: id }, curator, 'esc-2');
    expect(toOperator.block.addressee).toBe('operator');
    expect(await escalations(store)).toEqual([
      { block: id, from: 'orchestrator:dev', to: 'curator' },
      { block: id, from: 'curator', to: 'operator' },
    ]);

    const settled = await events(store);
    for (const [actor, key] of [
      [orchestrator, 'retry-orchestrator'],
      [curator, 'retry-curator-top'],
      ['operator', 'retry-operator'],
    ] as const) {
      const again = await apply(curated.escalate, { block: id }, actor, key);
      expect(again.block.addressee).toBe('operator');
    }
    expect(await events(store)).toEqual(settled);
    await expect(
      apply(curated.escalate, { block: id }, secondWorker, 'worker-at-operator'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await escalations(store)).toHaveLength(2);
  });

  it('walks a curator-addressed question straight to the operator', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa');
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.escalate, { block: block.id }, curator, 'esc');
    expect(await escalations(store)).toEqual([
      { block: block.id, from: 'curator', to: 'operator' },
    ]);
    const retry = await apply(curated.escalate, { block: block.id }, curator, 'retry');
    expect(retry.block.addressee).toBe('operator');
    expect(await escalations(store)).toHaveLength(1);
  });

  it('still reports a closed block to an earlier addressee', async () => {
    const { apply, ops: curated } = await curatorBoard();
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.escalate, { block: block.id }, orchestrator, 'esc');
    await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'answer');
    await expect(
      apply(curated.escalate, { block: block.id }, orchestrator, 'late'),
    ).rejects.toMatchObject({ code: 'block_not_open' });
  });

  it('escalates a system code block past the curator and refuses the curator a retry', async () => {
    const { store, apply, ops: curated } = await curatorBoard();
    const id = await seedBlock(store, {
      type: 'code',
      author: 'system',
      addressee: 'orchestrator:dev',
    });
    const moved = await apply(curated.escalate, { block: id }, orchestrator, 'esc');
    expect(moved.block.addressee).toBe('operator');
    expect(await escalations(store)).toEqual([
      { block: id, from: 'orchestrator:dev', to: 'operator' },
    ]);
    await expect(apply(curated.escalate, { block: id }, curator, 'retry')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await escalations(store)).toHaveLength(1);
  });

  it.each(['dependency', 'external'] as const)(
    'escalates a %s block past the curator and refuses the curator a retry',
    async (type) => {
      const { store, apply, ops: curated } = await curatorBoard();
      const { block } = await apply(
        curated.create,
        { task: KEY, type, reason: 'Waiting.' },
        orchestrator,
        'create',
      );
      expect(block.addressee).toBe('orchestrator:dev');
      await apply(curated.escalate, { block: block.id }, orchestrator, 'esc');
      expect(await escalations(store)).toEqual([
        { block: block.id, from: 'orchestrator:dev', to: 'operator' },
      ]);
      await expect(
        apply(curated.escalate, { block: block.id }, curator, 'retry'),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(await escalations(store)).toHaveLength(1);
    },
  );
});

describe('curator limits', () => {
  it('refuses a curator on an operator-addressed question', async () => {
    const { store, apply, ops: curated } = await curatorBoard();
    const id = await seedBlock(store, {
      type: 'needs_input',
      author,
      addressee: 'operator',
    });
    await expect(
      apply(curated.answer, { block: id, text: 'A.' }, curator, 'answer'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      apply(curated.unblock, { mode: 'reason', block: id, reason: 'R.' }, curator, 'reason'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(['worker', 'orchestrator:dev'] as const)(
    'refuses a curator on a code block at %s',
    async (addressee) => {
      const { store, apply, ops: curated } = await curatorBoard();
      const id = await seedBlock(store, { type: 'code', author: orchestrator, addressee });
      for (const [key, action] of [
        ['answer', () => apply(curated.answer, { block: id, text: 'A.' }, curator, 'answer')],
        [
          'reason',
          () =>
            apply(curated.unblock, { mode: 'reason', block: id, reason: 'R.' }, curator, 'reason'),
        ],
        ['done', () => apply(curated.unblock, { mode: 'done', block: id }, curator, 'done')],
      ] as const) {
        await expect(action(), key).rejects.toMatchObject({ code: 'forbidden' });
      }
    },
  );

  it('lets the curator unblock its question with a reason', async () => {
    const { apply, ops: curated } = await curatorBoard('qa');
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const closed = await apply(
      curated.unblock,
      { mode: 'reason', block: block.id, reason: 'Not needed.' },
      curator,
      'reason',
    );
    expect(closed.block).toMatchObject({ state: 'unblocked', outcome: 'reason' });
  });

  it('keeps the operator answer on a curator-addressed question', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa');
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(block.addressee).toBe('curator');
    const answered = await apply(
      curated.answer,
      { block: block.id, text: 'A.' },
      'operator',
      'answer',
    );
    expect(answered.block).toMatchObject({ state: 'unblocked', outcome: 'done' });
    const lines = await store.db
      .selectFrom('outbox')
      .select('id')
      .where('kind', '=', 'feed.line')
      .execute();
    expect(lines).toEqual([]);
  });

  it('keeps the operator reason on a curator-addressed question', async () => {
    const { apply, ops: curated } = await curatorBoard('qa');
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const closed = await apply(
      curated.unblock,
      { mode: 'reason', block: block.id, reason: 'Moot.' },
      'operator',
      'reason',
    );
    expect(closed.block).toMatchObject({ state: 'unblocked', outcome: 'reason' });
  });
});

describe('curator delivery', () => {
  const used = withCurator();
  const reconcile = (store: Store) =>
    scanTransaction(store, used, (trx) => reconcileItems(trx, used, NOW, true));
  const operatorItems = async (store: Store) =>
    (await store.db.selectFrom('operator_item').select('item_key').execute())
      .map((row) => row.item_key)
      .filter((key) => key.startsWith('operator-block:'));

  it('registers a curator doorbell and opens the thread once at the operator', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(block.addressee).toBe('curator');
    const notices = () =>
      store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'acked_at'])
        .orderBy('id')
        .execute();
    expect(await notices()).toEqual([{ kind: 'block', role: 'curator', acked_at: null }]);
    expect(await store.db.selectFrom('outbox').select('id').execute()).toEqual([]);
    await reconcile(store);
    expect(await operatorItems(store)).toEqual([]);

    await apply(curated.escalate, { block: block.id }, curator, 'esc');
    expect(await notices()).toEqual([
      { kind: 'block', role: 'curator', acked_at: new Date(NOW).toISOString() },
    ]);
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'conversation.open' },
    ]);
    await reconcile(store);
    expect(await operatorItems(store)).toEqual([`operator-block:${block.id.slice(1)}`]);
  });

  const feedLines = async (store: Store) =>
    (
      await store.db
        .selectFrom('outbox')
        .select(['dedupe_key', 'payload'])
        .where('kind', '=', 'feed.line')
        .orderBy('id')
        .execute()
    ).map((row) => ({
      dedupeKey: row.dedupe_key,
      payload: JSON.parse(row.payload) as {
        text: string;
        exchange?: { question: string; answer: string };
      },
    }));

  /** Delivers every due row through the slack-like fake and returns what it was asked. */
  const deliver = async (store: Store, file: string, board: Config) => {
    const observed = observeGateway(createFakeGateway({ profile: 'slack-like' }), file);
    const sender = createSender({
      config: board,
      store,
      gateway: observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => new Date(NOW),
      spaceIntervalMs: 0,
    });
    await sender.tick();
    return observed;
  };
  const taskLink = {
    kind: 'paragraph',
    children: [{ kind: 'link', url: 'https://github.com/o/r/issues/101', text: KEY }],
  } as const;
  const exchangeParagraphs = [
    {
      kind: 'paragraph',
      children: [
        { kind: 'emphasis', text: 'Q:' },
        { kind: 'text', text: ' Q?' },
      ],
    },
    {
      kind: 'paragraph',
      children: [
        { kind: 'emphasis', text: 'A:' },
        { kind: 'text', text: ' A.' },
      ],
    },
  ] as const;
  const exchangeContext = {
    kind: 'context',
    children: [
      { kind: 'text', text: 'B1 · asked by web/worker-1 · answered by cur/cur-1 · unblocked' },
    ],
  } as const;

  it('answers at the curator with one feed line and no thread reply or close', async () => {
    const { store, file, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'answer');
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'feed.line' },
    ]);
    expect(await store.db.selectFrom('operator_item').select('id').execute()).toEqual([]);

    const observed = await deliver(store, file, used);
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]).toMatchObject({ target: { kind: 'open', space: 'feed' } });
    expect(observed.requests[0]?.persona).toEqual({ name: 'cur', role: 'curator' });
    expect(observed.requests[0]?.body).toEqual([taskLink, ...exchangeParagraphs, exchangeContext]);
    expect(observed.requests[0]?.actions).toBeUndefined();
    expect(observed.violations).toEqual([]);
  });

  it("keeps the asker's answer ring unacked after the answer closes the block", async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const answered = await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'a');
    expect(answered.block.state).toBe('unblocked');
    expect(
      await store.db
        .selectFrom('notification')
        .select(['kind', 'role', 'acked_at'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { kind: 'block', role: 'curator', acked_at: new Date(NOW).toISOString() },
      { kind: 'answer', role: 'worker', acked_at: null },
    ]);
  });

  it('names the line after the configured curator display name and icon', async () => {
    const named = configSchema.parse({
      ...used,
      projects: used.projects.map((project) => ({
        ...project,
        spurProjects: project.spurProjects.map((spur) =>
          spur.role === 'curator' ? { ...spur, displayName: 'Cur Bot', icon: ':owl:' } : spur,
        ),
      })),
    });
    const { store, file, apply, ops: curated } = await curatorBoard('qa', named);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'answer');
    const observed = await deliver(store, file, named);
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]?.persona).toEqual({
      name: 'Cur Bot',
      role: 'curator',
      icon: ':owl:',
    });
    expect(observed.violations).toEqual([]);
  });

  it('shows the note apart from the answer and keeps it as a comment that rings nobody', async () => {
    const { store, file, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(
      curated.answer,
      { block: block.id, text: 'A.', note: 'Checked.' },
      curator,
      'answer',
    );
    expect(await store.db.selectFrom('comment').select('text').orderBy('id').execute()).toEqual([
      { text: 'Q?' },
      { text: 'A.' },
      { text: 'Checked.' },
    ]);
    expect(
      await store.db.selectFrom('notification').select('id').where('kind', '=', 'answer').execute(),
    ).toHaveLength(1);
    expect(
      (await events(store)).filter((event) => event.kind === 'comment_added').at(-1),
    ).toMatchObject({ payload: { comment: 'C3' } });

    const observed = await deliver(store, file, used);
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]?.body).toEqual([
      taskLink,
      ...exchangeParagraphs,
      { kind: 'paragraph', children: [{ kind: 'italic', text: 'Checked.' }] },
      exchangeContext,
    ]);
    expect(observed.violations).toEqual([]);
  });

  const ticketFacts = {
    trackerId: 'github-issues:o/r',
    id: 'I_101',
    key: KEY,
    title: 'Fix login',
    status: 'open',
    assignee: null,
    sprint: null,
    labels: [],
    inFilter: true,
    url: 'https://github.com/o/r/issues/101',
    updatedAt: '2026-11-03T09:00:00.000Z',
  };

  it.each([
    ['valid ticket facts', JSON.stringify(ticketFacts), [{ kind: 'text', text: ' Fix login' }]],
    ['no snapshot', null, []],
    ['empty detail', '{}', []],
    ['a detail that is not JSON', 'not json', []],
  ] as const)(
    'shows the task title when the ticket snapshot has one (%s)',
    async (_case, detail, title) => {
      const { store, file, apply, ops: curated } = await curatorBoard('qa', used);
      if (detail !== null) {
        await store.transaction((trx) =>
          trx
            .insertInto('ticket_snapshot')
            .values({ ...sampleRows.ticket_snapshot, detail })
            .execute(),
        );
      }
      const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
      const answered = await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'a');
      expect(answered.block).toMatchObject({ state: 'unblocked', outcome: 'done' });
      const observed = await deliver(store, file, used);
      expect(observed.requests).toHaveLength(1);
      expect(observed.requests[0]?.body[0]).toEqual({
        ...taskLink,
        children: [...taskLink.children, ...title],
      });
    },
  );

  it('writes no second curator line on a replay', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const input = { block: block.id, text: 'A.' };
    const first = await apply(curated.answer, input, curator, 'answer');
    const before = await counts(store);
    const again = await apply(curated.answer, input, curator, 'answer');
    expect(again).toEqual(first);
    expect(await counts(store)).toEqual(before);
    expect((await feedLines(store)).map((line) => line.dedupeKey)).toEqual([
      `feed.line:curator-answer:comment:${first.comment.id.slice(1)}`,
    ]);
  });

  it('shortens the question and answer in the line and keeps the full answer', async () => {
    const { store, file, apply, ops: curated } = await curatorBoard('qa', used);
    const question = `Why\n  ${'q'.repeat(150)}`;
    const answer = 'a'.repeat(300);
    const { block } = await apply(curated.ask, { task: KEY, text: question }, author, 'ask');
    const answered = await apply(curated.answer, { block: block.id, text: answer }, curator, 'a');
    const [line] = await feedLines(store);
    expect(line?.payload.text).toBe(
      `B1 · web/worker-1 asked: Why ${'q'.repeat(122)}… → curator answered: ${'a'.repeat(204)}…`,
    );
    expect(line?.payload.exchange).toMatchObject({
      question: `Why ${'q'.repeat(122)}…`,
      answer: `${'a'.repeat(204)}…`,
    });
    const comment = await store.db
      .selectFrom('comment')
      .select(['text', 'delivery_state'])
      .where('id', '=', Number(answered.comment.id.slice(1)))
      .executeTakeFirstOrThrow();
    expect(comment).toEqual({ text: answer, delivery_state: null });

    const observed = await deliver(store, file, used);
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]?.body).toMatchInlineSnapshot(`
      [
        {
          "children": [
            {
              "kind": "link",
              "text": "o/r#101",
              "url": "https://github.com/o/r/issues/101",
            },
          ],
          "kind": "paragraph",
        },
        {
          "children": [
            {
              "kind": "emphasis",
              "text": "Q:",
            },
            {
              "kind": "text",
              "text": " Why qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq…",
            },
          ],
          "kind": "paragraph",
        },
        {
          "children": [
            {
              "kind": "emphasis",
              "text": "A:",
            },
            {
              "kind": "text",
              "text": " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…",
            },
          ],
          "kind": "paragraph",
        },
        {
          "children": [
            {
              "kind": "text",
              "text": "B1 · asked by web/worker-1 · answered by cur/cur-1 · unblocked",
            },
          ],
          "kind": "context",
        },
      ]
    `);
    expect(observed.violations).toEqual([]);
  });

  it.each([
    ['the operator', 'qa', 'operator'],
    ['an operator-role agent', 'qa', operatorAgent],
    ['the column orchestrator', 'dev', orchestrator],
  ] as const)('writes no curator line when %s answers', async (_who, column, actor) => {
    const { store, apply, ops: curated } = await curatorBoard(column, used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(block.addressee).toBe(column === 'dev' ? 'orchestrator:dev' : 'curator');
    await apply(curated.answer, { block: block.id, text: 'A.' }, actor, 'answer');
    expect(await feedLines(store)).toEqual([]);
  });

  it('writes the line when the curator also orchestrates the task column', async () => {
    const dual = withCurator({ qa: 'cur' });
    const { store, apply, ops: curated } = await curatorBoard('dev', dual);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    expect(block.addressee).toBe('curator');
    await store.transaction((trx) =>
      trx.updateTable('task').set({ column: 'qa' }).where('id', '=', 1).execute(),
    );
    await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'answer');
    expect((await feedLines(store)).map((line) => line.payload.text)).toEqual([
      'B1 · qa/qa-1 asked: Q? → curator answered: A.',
    ]);
  });

  it('opens the thread of a curator question under the curator persona', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'ask');
    const rows = await store.db.selectFrom('outbox').select(['kind', 'payload']).execute();
    expect(rows.map((row) => row.kind)).toEqual(['conversation.open']);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({
      persona: { name: 'cur', role: 'curator' },
    });
  });
});

describe('withdrawal by the author role', () => {
  const used = withCurator();
  const notifications = (store: Store) =>
    store.db.selectFrom('notification').select(['kind', 'role']).orderBy('id').execute();

  it('withdraws a question of the previous curator session', async () => {
    const { apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'ask');
    const closed = await apply(
      curated.unblock,
      { mode: 'withdraw', block: block.id, answer: 'Settled.' },
      'agent:cur/cur-2',
      'withdraw',
    );
    expect(closed.block).toMatchObject({
      outcome: 'withdrawn',
      outcomeReason: 'Settled.',
      unblockedBy: 'agent:cur/cur-2',
    });
  });

  it('refuses a linked worker of an orchestrator project', async () => {
    const { store, apply, ops: curated } = await curatorBoard('dev', used);
    await store.transaction((trx) =>
      trx
        .insertInto('link')
        .values({
          ...sampleRows.link,
          id: 3,
          entity: 'session',
          repo: null,
          number: null,
          pr_state: null,
          session_id: 'qa-1',
          role: 'worker',
        })
        .execute(),
    );
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    await expect(
      apply(
        curated.unblock,
        { mode: 'withdraw', block: block.id, answer: 'Mine now.' },
        'agent:qa/qa-2',
        'withdraw',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('withdraws an orchestrator question after a column move', async () => {
    const { store, apply, ops: curated } = await curatorBoard('dev', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, orchestrator, 'ask');
    await store.transaction((trx) =>
      trx.updateTable('task').set({ column: 'qa' }).where('id', '=', 1).execute(),
    );
    const closed = await apply(
      curated.unblock,
      { mode: 'withdraw', block: block.id, answer: 'Settled.' },
      'agent:qa/qa-2',
      'withdraw',
    );
    expect(closed.block).toMatchObject({ outcome: 'withdrawn', unblockedBy: 'agent:qa/qa-2' });
    // The curator it waited on hears of the removal once; the author gets no answer ring.
    expect(await notifications(store)).toEqual([
      { kind: 'block', role: 'curator' },
      { kind: 'removed', role: 'curator' },
    ]);
  });

  it('posts the reason to the operator thread when a new curator session withdraws', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'ask');
    expect(block.addressee).toBe('operator');
    await apply(
      curated.unblock,
      { mode: 'withdraw', block: block.id, answer: 'Settled.' },
      'agent:cur/cur-2',
      'withdraw',
    );
    const rows = await store.db.selectFrom('outbox').selectAll().orderBy('id').execute();
    expect(rows.map((row) => row.kind)).toEqual([
      'conversation.open',
      'conversation.reply',
      'conversation.close',
    ]);
    expect(rows.map((row) => row.parent_outbox_id)).toEqual([null, rows[0]?.id, rows[1]?.id]);
    expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({ text: 'Settled.' });
    expect(await notifications(store)).toEqual([]);
  });
});

describe('escalation note', () => {
  const used = withCurator();
  const outbox = (store: Store) =>
    store.db.selectFrom('outbox').selectAll().orderBy('id').execute();
  const comments = (store: Store) =>
    store.db.selectFrom('comment').select('text').orderBy('id').execute();
  const answerRows = (store: Store) =>
    store.db.selectFrom('notification').select('id').where('kind', '=', 'answer').execute();

  it('opens the thread with the question and replies with the note', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.escalate, { block: block.id, note: 'Owner away.' }, curator, 'esc');
    const rows = await outbox(store);
    expect(rows.map((row) => row.kind)).toEqual(['conversation.open', 'conversation.reply']);
    expect(rows[1]?.parent_outbox_id).toBe(rows[0]?.id);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ text: 'Q?', commentId: 1 });
    expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({
      text: 'Owner away.',
      commentId: 2,
      persona: { name: 'cur', role: 'curator' },
    });
    expect((await events(store)).at(-1)).toMatchObject({
      kind: 'comment_added',
      payload: { comment: 'C2', addressee: 'operator' },
    });
  });

  it('posts an answer note as a second thread reply before the close', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.escalate, { block: block.id }, curator, 'esc');
    await apply(
      curated.answer,
      { block: block.id, text: 'A.', note: 'Checked.' },
      'operator',
      'answer',
    );
    const rows = await outbox(store);
    expect(rows.map((row) => row.kind)).toEqual([
      'conversation.open',
      'conversation.reply',
      'conversation.reply',
      'conversation.close',
    ]);
    expect(rows.map((row) => row.parent_outbox_id)).toEqual([
      null,
      rows[0]?.id,
      rows[1]?.id,
      rows[2]?.id,
    ]);
    expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({ text: 'A.', commentId: 2 });
    expect(JSON.parse(rows[2]?.payload ?? '{}')).toMatchObject({ text: 'Checked.', commentId: 3 });
    expect(await answerRows(store)).toHaveLength(1);
  });

  it('keeps the reason at the head of a thread', async () => {
    const { store, apply, ops: curated } = await curatorBoard('dev', used);
    const { block } = await apply(
      curated.create,
      { task: KEY, type: 'dependency', reason: 'Needs outside work.' },
      orchestrator,
      'create',
    );
    await apply(curated.escalate, { block: block.id, note: 'Still waiting.' }, orchestrator, 'esc');
    const rows = await outbox(store);
    expect(rows.map((row) => row.kind)).toEqual(['conversation.open', 'conversation.reply']);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({
      text: 'Needs outside work.',
      commentId: null,
    });
    expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({
      text: 'Still waiting.',
      persona: { name: 'qa', role: 'orchestrator' },
    });
  });

  it('replays a note left at the curator when the block reaches the operator', async () => {
    const { store, apply, ops: curated } = await curatorBoard('dev', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.escalate, { block: block.id, note: 'First.' }, orchestrator, 'esc-1');
    expect(await outbox(store)).toEqual([]);
    await apply(curated.escalate, { block: block.id, note: 'Second.' }, curator, 'esc-2');
    const texts = (await outbox(store)).map(
      (row) => (JSON.parse(row.payload) as { text: string }).text,
    );
    expect(texts).toEqual(['Q?', 'First.', 'Second.']);
  });

  it('rolls back an escalation note', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    const before = await counts(store);
    await sql
      .raw(
        "CREATE TEMP TRIGGER fail_reply BEFORE INSERT ON outbox WHEN NEW.kind = 'conversation.reply' BEGIN SELECT RAISE(FAIL, 'injected'); END",
      )
      .execute(store.db);
    await expect(
      apply(curated.escalate, { block: block.id, note: 'Owner away.' }, curator, 'esc'),
    ).rejects.toThrow('injected');
    expect(await counts(store)).toEqual(before);
    expect(
      await store.db.selectFrom('block').select('addressee_role').executeTakeFirstOrThrow(),
    ).toEqual({ addressee_role: 'curator' });
  });

  it.each([
    { by: 'worker', column: 'qa', asker: author, escalator: curator },
    { by: 'orchestrator', column: 'dev', asker: orchestrator, escalator: curator },
    { by: 'curator', column: 'qa', asker: curator, escalator: 'operator' },
  ] as const)(
    'does not ring the question author for a note ($by author)',
    async ({ column, asker, escalator }) => {
      const { store, apply, ops: curated } = await curatorBoard(column, used);
      const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, asker, 'ask');
      await apply(curated.escalate, { block: block.id, note: 'Owner away.' }, escalator, 'esc');
      expect(await comments(store)).toEqual([{ text: 'Q?' }, { text: 'Owner away.' }]);
      expect(await answerRows(store)).toEqual([]);
    },
  );

  describe('on a no-op escalation', () => {
    const replies = async (store: Store) =>
      (await outbox(store)).filter((row) => row.kind === 'conversation.reply');
    const operatorThread = async () => {
      const board = await curatorBoard('dev', used);
      const { apply, ops: curated } = board;
      const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
      await apply(curated.escalate, { block: block.id }, orchestrator, 'esc-1');
      await apply(curated.escalate, { block: block.id, note: 'First.' }, curator, 'esc-2');
      return { ...board, id: block.id };
    };

    it('adds an earlier addressee note to the current thread', async () => {
      const { store, apply, ops: curated, id } = await operatorThread();
      const before = await events(store);
      const notices = await store.db.selectFrom('notification').selectAll().execute();
      const tail = (await outbox(store)).at(-1);
      const input = { block: id, note: 'Late.' };
      const late = await apply(curated.escalate, input, curator, 'late');
      expect(late.block).toMatchObject({ addressee: 'operator', state: 'open' });
      expect(await comments(store)).toEqual([
        { text: 'Q?' },
        { text: 'First.' },
        { text: 'Late.' },
      ]);
      const reply = (await replies(store)).at(-1);
      expect(reply?.parent_outbox_id).toBe(tail?.id);
      expect(JSON.parse(reply?.payload ?? '{}')).toMatchObject({ text: 'Late.' });
      expect((await events(store)).slice(before.length).map((event) => event.kind)).toEqual([
        'comment_added',
      ]);
      expect(await escalations(store)).toHaveLength(2);
      expect((await outbox(store)).filter((row) => row.kind === 'conversation.open')).toHaveLength(
        1,
      );
      expect(await store.db.selectFrom('notification').selectAll().execute()).toEqual(notices);
      expect(await answerRows(store)).toEqual([]);

      const settled = await counts(store);
      expect(await apply(curated.escalate, input, curator, 'late')).toEqual(late);
      await expect(
        apply(curated.escalate, { ...input, note: 'Changed.' }, curator, 'late'),
      ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
      expect(await counts(store)).toEqual(settled);
    });

    it('leaves an operator conversation on a task where the operator addressed it', async () => {
      const board = conversationConfig();
      const { store } = await conversationStore();
      stores.push(store);
      await startConversation(store, board, '@cur o/r#101 status?');
      const notices = await store.db.selectFrom('notification').selectAll().execute();
      const before = await store.db.selectFrom('block').selectAll().execute();
      const result = await createApply({ store, clock, config: board })(
        createBlockMutations(board).escalate,
        { block: 'B1', note: 'Not mine.' },
        curator,
        'esc',
      );
      expect(result.block).toMatchObject({ task: KEY, addressee: 'curator', state: 'open' });
      expect(await store.db.selectFrom('block').selectAll().execute()).toEqual(before);
      expect(before[0]).toMatchObject({ addressee_spur_project: 'cur', addressee_role: 'curator' });
      expect(await store.db.selectFrom('notification').selectAll().execute()).toEqual(notices);
      expect((await comments(store)).at(-1)).toEqual({ text: 'Not mine.' });
      expect(await escalations(store)).toEqual([]);
    });

    it('adds the note when the block is already at the top', async () => {
      const { store, apply, ops: curated, id } = await operatorThread();
      const notices = await store.db.selectFrom('notification').selectAll().execute();
      const tail = (await outbox(store)).at(-1);
      const top = await apply(curated.escalate, { block: id, note: 'Top.' }, 'operator', 'top');
      expect(top.block).toMatchObject({ addressee: 'operator', state: 'open' });
      expect((await comments(store)).at(-1)).toEqual({ text: 'Top.' });
      const reply = (await replies(store)).at(-1);
      expect(reply?.parent_outbox_id).toBe(tail?.id);
      expect(JSON.parse(reply?.payload ?? '{}')).toMatchObject({ text: 'Top.' });
      expect(await escalations(store)).toHaveLength(2);
      expect(await store.db.selectFrom('notification').selectAll().execute()).toEqual(notices);
      expect(await answerRows(store)).toEqual([]);
    });

    it('writes nothing without a note', async () => {
      const { store, apply, ops: curated, id } = await operatorThread();
      const settled = await counts(store);
      await apply(curated.escalate, { block: id }, curator, 'retry');
      await apply(curated.escalate, { block: id }, 'operator', 'top');
      expect(await counts(store)).toEqual({ ...settled, commands: settled.commands + 2 });
    });
  });
});

describe('edit of an acknowledged comment', () => {
  const used = withCurator();
  const answers = (store: Store, comment: string) =>
    store.db
      .selectFrom('notification')
      .select(['revision', 'acked_at'])
      .where('kind', '=', 'answer')
      .where('comment_id', '=', Number(comment.slice(1)))
      .orderBy('revision')
      .execute();

  /** Writes `kind` as C2 on a worker question, acknowledged by the worker, and returns its writer. */
  async function acked(kind: 'note' | 'withdrawal' | 'answer') {
    const board = await curatorBoard(kind === 'withdrawal' ? 'dev' : 'qa', used);
    const { store, apply, ops: curated } = board;
    const asker = kind === 'withdrawal' ? orchestrator : author;
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, asker, 'ask');
    let writer: ActorId = curator;
    if (kind === 'note') {
      await apply(curated.escalate, { block: block.id, note: 'Owner away.' }, curator, 'esc');
    } else if (kind === 'answer') {
      await apply(curated.answer, { block: block.id, text: 'Use v2.' }, curator, 'answer');
    } else {
      // After the move the asker's role reads as worker, so an answer ring would reach it.
      await store.transaction((trx) =>
        trx.updateTable('task').set({ column: 'qa' }).where('id', '=', 1).execute(),
      );
      writer = 'agent:qa/qa-2';
      await apply(
        curated.unblock,
        { mode: 'withdraw', block: block.id, answer: 'Settled.' },
        writer,
        'withdraw',
      );
    }
    await apply(curated.ack, { entries: [{ id: 'C2', revision: 1 }] }, asker, 'ack');
    return { ...board, writer };
  }

  const paths = {
    command: async (board: Awaited<ReturnType<typeof acked>>) => {
      await board.apply(board.ops.edit, { comment: 'C2', text: 'Edited.' }, board.writer, 'edit');
    },
    inbound: async (board: Awaited<ReturnType<typeof acked>>) => {
      await board.store.transaction(async (trx) => {
        const comment = await trx
          .selectFrom('comment')
          .selectAll()
          .where('id', '=', 2)
          .executeTakeFirstOrThrow();
        await editInboundComment(trx, {
          comment,
          text: 'Edited.',
          at: new Date(NOW).toISOString(),
          actor: board.writer,
          config: used,
        });
      });
    },
  } as const;

  it.each([
    ['note', 'command'],
    ['note', 'inbound'],
    ['withdrawal', 'command'],
    ['withdrawal', 'inbound'],
  ] as const)('does not ring the question author for an edited %s (%s)', async (kind, path) => {
    const board = await acked(kind);
    await paths[path](board);
    expect(
      await board.store.db
        .selectFrom('comment')
        .select(['text', 'revision'])
        .where('id', '=', 2)
        .executeTakeFirstOrThrow(),
    ).toEqual({ text: 'Edited.', revision: 2 });
    expect(await answers(board.store, 'C2')).toEqual([]);
  });

  it.each(['command', 'inbound'] as const)(
    'rings the question author for an edited answer (%s)',
    async (path) => {
      const board = await acked('answer');
      await paths[path](board);
      expect(await answers(board.store, 'C2')).toEqual([
        { revision: 1, acked_at: new Date(NOW).toISOString() },
        { revision: 2, acked_at: null },
      ]);
    },
  );
});

describe('ledger block', () => {
  /** A system block to the operator with its anomaly item, as `reconcileItems` raises one. */
  async function ledger(store: Store, key: string) {
    return scanTransaction(store, config, async (trx) => {
      const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
      const at = new Date(NOW).toISOString();
      const block = await openSystemBlock(trx, { task, reason: 'PR closed', at, config });
      const item = await raiseItem(trx, {
        itemKey: key,
        kind: 'anomaly',
        text: `${KEY}: PR closed`,
        url: 'https://github.com/o/r/issues/101',
        taskId: task.id,
        blockId: block.id,
        at: new Date(NOW),
        fingerprint: `fingerprint-${key}`,
        source: 'github:proj:o/r',
      });
      return { task, block, item };
    });
  }
  const cleared = (store: Store, id: number) =>
    store.db
      .selectFrom('operator_item')
      .select('cleared_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('writes a dismissal when the operator unblocks a ledger block, none on a system close', async () => {
    const { store, apply } = await seeded();
    const byOperator = await ledger(store, 'pr-closed:1');
    expect(byOperator.block).toMatchObject({
      author: 'system',
      addressee_role: 'operator',
      type: 'needs_input',
    });
    await apply(
      ops.unblock,
      { mode: 'reason', block: `B${String(byOperator.block.id)}`, reason: 'Abandoned.' },
      'operator',
    );
    expect(await cleared(store, byOperator.item.id)).toEqual({
      cleared_at: new Date(NOW).toISOString(),
    });
    expect(await store.db.selectFrom('dismissal').selectAll().execute()).toEqual([
      {
        item_key: 'pr-closed:1',
        fingerprint: 'fingerprint-pr-closed:1',
        dismissed_by: 'operator',
        dismissed_at: new Date(NOW).toISOString(),
      },
    ]);

    const bySystem = await ledger(store, 'ticket-closed:1');
    await scanTransaction(store, config, (trx) =>
      closeOpenBlock(
        trx,
        taskSubject(bySystem.task),
        bySystem.block,
        { actor: 'system', at: new Date(NOW).toISOString() },
        'withdrawn',
        'condition ended',
      ),
    );
    expect(await cleared(store, bySystem.item.id)).toEqual({
      cleared_at: new Date(NOW).toISOString(),
    });
    expect(
      (await store.db.selectFrom('dismissal').select('item_key').execute()).map(
        (row) => row.item_key,
      ),
    ).toEqual(['pr-closed:1']);
  });
});

describe('project question', () => {
  const used = withCurator();
  const at = new Date(NOW).toISOString();
  const stranger = 'agent:stranger/s-1';
  const board = () => curatorBoard('dev', used);
  type Board = Awaited<ReturnType<typeof board>>;
  const ask = (b: Board, actor: ActorId, key = 'ask', project = 'proj') =>
    b.apply(b.ops.projectAsk, { project, to: 'operator', text: 'Restart?' }, actor, key);
  const outbox = async (store: Store, kind: string) =>
    (await store.db.selectFrom('outbox').select('payload').where('kind', '=', kind).execute()).map(
      (row) => JSON.parse(row.payload) as Record<string, unknown>,
    );
  const inbox = (store: Store, actor: ActorId) =>
    createQuery({ store, clock, config: used })(
      createTaskQueries({ config: used, clock, completeSince: new Map() }).inbox,
      {},
      actor,
    );

  it('opens an operator block without a task for the curator, an orchestrator and a worker', async () => {
    const b = await board();
    const authors = [curator, orchestrator, author] as const;
    for (const [index, actor] of authors.entries()) {
      const { block } = await ask(b, actor, `ask-${String(index)}`);
      expect(block).toEqual({
        id: `B${String(index + 1)}`,
        task: null,
        project: 'proj',
        type: 'needs_input',
        state: 'open',
        author: actor,
        addressee: 'operator',
        reason: 'Restart?',
        at,
        outcome: null,
        outcomeReason: null,
        unblockedBy: null,
        unblockedAt: null,
      });
    }
    expect(
      await b.store.db.selectFrom('block').select(['task_id', 'project', 'author']).execute(),
    ).toEqual(authors.map((actor) => ({ task_id: null, project: 'proj', author: actor })));
    expect(
      await b.store.db.selectFrom('comment').select(['task_id', 'block_id', 'text']).execute(),
    ).toEqual([1, 2, 3].map((id) => ({ task_id: null, block_id: id, text: 'Restart?' })));
    const before = await counts(b.store);
    await expect(ask(b, stranger, 'ask-stranger')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await events(b.store)).filter((e) => e.kind === 'operation_denied')).toHaveLength(1);
    await expect(ask(b, curator, 'ask-nope', 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect((await counts(b.store)).blocks).toBe(before.blocks);
    const { block: taskBlock } = await b.apply(b.ops.ask, { task: KEY, text: 'Q?' }, author, 'q');
    expect(taskBlock.task).toBe(KEY);
    expect(taskBlock).not.toHaveProperty('project');
  });

  it('opens the thread under the author persona, and none for an operator-role agent', async () => {
    const b = await board();
    const personas = [];
    for (const actor of [curator, orchestrator, author] as const) {
      const { block } = await ask(b, actor, `ask-${actor}`);
      const [open] = (await outbox(b.store, 'conversation.open')).filter(
        (payload) => payload['blockId'] === Number(block.id.slice(1)),
      );
      expect(open).toMatchObject({ key: 'proj (project)', taskId: null, text: 'Restart?' });
      personas.push(open?.['persona']);
    }
    expect(personas).toEqual([
      { name: 'cur', role: 'curator' },
      { name: 'qa', role: 'worker' },
      { name: 'web', role: 'worker' },
    ]);
    await ask(b, operatorAgent, 'ask-ops');
    expect(await outbox(b.store, 'conversation.open')).toHaveLength(3);
  });

  it('raises a from-you item and feed line that the answer clears', async () => {
    const b = await board();
    const { block } = await ask(b, curator);
    const reconcile = () =>
      scanTransaction(b.store, used, (trx) => reconcileItems(trx, used, NOW, true));
    await reconcile();
    const items = () =>
      b.store.db
        .selectFrom('operator_item')
        .select(['item_key', 'task_id', 'text', 'cleared_at'])
        .execute();
    expect(await items()).toEqual([
      {
        item_key: `operator-block:${block.id.slice(1)}`,
        task_id: null,
        text: 'proj (project): Restart?',
        cleared_at: null,
      },
    ]);
    expect(await outbox(b.store, 'feed.line')).toHaveLength(1);
    await b.apply(b.ops.answer, { block: block.id, text: 'Yes.' }, 'operator', 'answer');
    await reconcile();
    expect((await items())[0]?.cleared_at).not.toBeNull();
  });

  it('closes by answer, reason or withdrawal with the task-block close line', async () => {
    const b = await board();
    const closes: unknown[] = [];
    const close = async (actor: ActorId, run: (id: string) => Promise<unknown>) => {
      const { block } = await ask(b, actor, `ask-${String(closes.length)}`);
      const [open] = await b.store.db
        .selectFrom('outbox')
        .select('id')
        .where('kind', '=', 'conversation.open')
        .orderBy('id', 'desc')
        .execute();
      // Mark the open delivered so the close follows its thread, as after a real post.
      await b.store.db
        .updateTable('outbox')
        .set({ state: 'done' })
        .where('id', '=', open?.id ?? 0)
        .execute();
      await b.store.db
        .insertInto('conversation')
        .values({
          ...sampleRows.conversation,
          ref: `c-${block.id}`,
          task_id: null,
          block_id: Number(block.id.slice(1)),
          state: 'open',
          closed_at: null,
        })
        .execute();
      await run(block.id);
      const [row] = (await outbox(b.store, 'conversation.close')).slice(-1);
      closes.push({ key: row?.['key'], text: row?.['text'], taskId: row?.['taskId'] });
    };
    await close(curator, (id) =>
      b.apply(b.ops.answer, { block: id, text: 'Yes.' }, 'operator', 'answer'),
    );
    await close(curator, (id) =>
      b.apply(b.ops.unblock, { block: id, mode: 'reason', reason: 'Not now.' }, 'operator', 'r'),
    );
    await close(author, (id) =>
      b.apply(b.ops.unblock, { block: id, mode: 'withdraw', answer: 'Solved.' }, author, 'w'),
    );
    expect(closes).toEqual([
      { key: 'proj (project)', text: 'resolved: done (operator)', taskId: null },
      { key: 'proj (project)', text: 'resolved: reason (operator)', taskId: null },
      { key: 'proj (project)', text: `resolved: withdrawn (${author})`, taskId: null },
    ]);
    expect(
      await b.store.db.selectFrom('block').select(['state', 'unblocked_by']).execute(),
    ).toEqual([
      { state: 'unblocked', unblocked_by: 'operator' },
      { state: 'unblocked', unblocked_by: 'operator' },
      { state: 'unblocked', unblocked_by: author },
    ]);
  });

  it('lists the block to the operator and the answer to the curator, who acks it', async () => {
    const b = await board();
    const { block } = await ask(b, curator);
    expect((await inbox(b.store, operatorAgent)).blocks.map((entry) => entry.id)).toEqual([
      block.id,
    ]);
    expect((await inbox(b.store, curator)).blocks).toEqual([]);
    const { comment } = await b.apply(
      b.ops.answer,
      { block: block.id, text: 'Yes.' },
      'operator',
      'answer',
    );
    expect((await inbox(b.store, operatorAgent)).blocks).toEqual([]);
    expect((await inbox(b.store, curator)).comments).toMatchObject([
      { id: comment.id, task: null, block: block.id, text: 'Yes.' },
    ]);
    const acked = await b.apply(
      b.ops.ack,
      { entries: [{ id: comment.id, revision: 1 }] },
      curator,
      'ack',
    );
    expect(acked).toEqual({ acked: [comment.id] });
    expect((await inbox(b.store, curator)).comments).toEqual([]);

    const ring = await board();
    const second = await ask(ring, curator);
    await ring.apply(
      ring.ops.answer,
      { block: second.block.id, text: 'Yes.' },
      'operator',
      'answer',
    );
    const notice = await ring.store.db
      .selectFrom('notification')
      .select('id')
      .executeTakeFirstOrThrow();
    const ringId = `N${String(notice.id)}-1`;
    expect(
      await ring.apply(ring.ops.ack, { entries: [{ id: ringId }] }, curator, 'ack-ring'),
    ).toEqual({ acked: [ringId] });
    expect((await inbox(ring.store, curator)).comments).toEqual([]);
  });

  it('refuses the author an escalation and lets the operator post a note in place', async () => {
    const b = await board();
    const { block } = await ask(b, curator);
    await expect(
      b.apply(b.ops.escalate, { block: block.id }, curator, 'esc'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await events(b.store)).filter((e) => e.kind === 'operation_denied')).toHaveLength(1);
    const escalated = await b.apply(
      b.ops.escalate,
      { block: block.id, note: 'Looking.' },
      'operator',
      'esc-op',
    );
    expect(escalated.block).toMatchObject({ state: 'open', addressee: 'operator' });
    expect(
      await b.store.db.selectFrom('comment').select('text').where('block_id', '=', 1).execute(),
    ).toEqual([{ text: 'Restart?' }, { text: 'Looking.' }]);
    expect(await outbox(b.store, 'conversation.reply')).toHaveLength(1);
  });
});

describe('operator conversation', () => {
  const board = conversationConfig();
  /** A `cur` conversation with its block ring and one unacked operator follow-up ring. */
  async function followedUp(text = '@cur hello', config = board) {
    const { store } = await conversationStore();
    stores.push(store);
    await startConversation(store, config, text);
    await scanTransaction(store, config, (trx) =>
      recordInboundBlockMessage(trx, {
        blockId: 1,
        text: 'and more',
        conversationRef: 'top-1',
        messageRef: 'top-1-reply-1',
        at: new Date(NOW).toISOString(),
        config,
      }),
    );
    return { store, apply: createApply({ store, clock, config }) };
  }
  const notices = (store: Store) =>
    store.db
      .selectFrom('notification')
      .select(['kind', 'role', 'acked_at'])
      .orderBy('id')
      .execute();
  const replies = async (store: Store) =>
    (
      await store.db
        .selectFrom('outbox')
        .select('payload')
        .where('kind', '=', 'conversation.reply')
        .execute()
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

  it.each([
    ['the curator it addresses', 'agent:cur/cur-1', { name: 'cur', role: 'curator' }],
    ['an operator-role agent', 'agent:board-pm/pm-1', { name: 'board-pm', role: 'board' }],
  ] as const)('keeps the conversation open when %s answers', async (_who, actor, persona) => {
    const { store, apply } = await followedUp();
    const unacked = await notices(store);
    expect(unacked).toEqual([
      { kind: 'block', role: 'curator', acked_at: null },
      { kind: 'answer', role: 'curator', acked_at: null },
    ]);
    const answered = await apply(
      createBlockMutations(board).answer,
      { block: 'B1', text: 'hi' },
      actor,
      'answer',
    );
    expect(answered.block).toMatchObject({
      state: 'open',
      addressee: 'curator',
      type: 'needs_input',
    });
    expect(await replies(store)).toEqual([
      expect.objectContaining({ text: 'hi', persona, targetConversation: 'top-1' }),
    ]);
    expect(await notices(store)).toEqual(
      unacked.map((row) => ({ ...row, acked_at: new Date(NOW).toISOString() })),
    );
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
    ).toEqual([]);
  });

  /** `board` with display names and icons on operator-role `board-pm` and curator `cur`. */
  const named = configSchema.parse({
    ...board,
    projects: board.projects.map((project) => ({
      ...project,
      spurProjects: project.spurProjects.map((spur) =>
        spur.name === 'board-pm'
          ? { ...spur, displayName: 'PM', icon: ':memo:' }
          : spur.name === 'cur'
            ? { ...spur, displayName: 'Cur Bot', icon: ':owl:' }
            : spur,
      ),
    })),
  });

  it.each([
    [
      'an operator-role agent',
      'agent:board-pm/pm-1',
      { name: 'PM', role: 'board', icon: ':memo:' },
    ],
    ['the curator', 'agent:cur/cur-1', { name: 'Cur Bot', role: 'curator', icon: ':owl:' }],
    ['the operator CLI', 'operator', { name: 'operator', role: 'board' }],
  ] as const)(
    'answers for %s under its configured display name and icon',
    async (_who, actor, persona) => {
      const { store, apply } = await followedUp('@cur hello', named);
      await apply(createBlockMutations(named).answer, { block: 'B1', text: 'hi' }, actor, 'answer');
      expect(await replies(store)).toEqual([
        expect.objectContaining({ text: 'hi', persona, targetConversation: 'top-1' }),
      ]);
    },
  );

  it('keeps the board persona on board-written messages under configured display names', () => {
    expect(personaFor(named, projectSubject('proj'), 'system')).toEqual({
      name: 'board',
      role: 'board',
    });
  });

  it('rings the addressee again for an operator CLI answer', async () => {
    const { store, apply } = await followedUp();
    await apply(createBlockMutations(board).answer, { block: 'B1', text: 'hi' }, 'operator', 'a');
    expect((await notices(store)).map((row) => [row.kind, row.acked_at === null])).toEqual([
      ['block', false],
      ['answer', false],
      ['answer', true],
    ]);
  });

  it('answers a task conversation under the orchestrator persona of its column', async () => {
    const { store, apply } = await followedUp('@qa o/r#101 status?');
    await apply(
      createBlockMutations(board).answer,
      { block: 'B1', text: 'ok' },
      'agent:qa/qa-1',
      'a',
    );
    expect(await replies(store)).toEqual([
      expect.objectContaining({ persona: { name: 'qa', role: 'orchestrator' } }),
    ]);
    expect(
      await store.db.selectFrom('outbox').select('kind').where('kind', '=', 'feed.line').execute(),
    ).toEqual([]);
  });

  it.each([
    ['--reason', { mode: 'reason', reason: 'Done here.' }],
    ['--withdraw', { mode: 'withdraw', answer: 'Never mind.' }],
  ] as const)('refuses the addressee %s and keeps the conversation open', async (_flag, mode) => {
    const { store, apply } = await followedUp();
    const unacked = await notices(store);
    await expect(
      apply(createBlockMutations(board).unblock, { block: 'B1', ...mode }, 'agent:cur/cur-1', 'u'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await store.db.selectFrom('block').select('state').execute()).toEqual([
      { state: 'open' },
    ]);
    expect(await notices(store)).toEqual(unacked);
    expect(await replies(store)).toEqual([]);
  });

  it.each(['operator', 'agent:board-pm/pm-1'] as const)(
    'lets %s close the conversation with --reason',
    async (actor) => {
      const { apply } = await followedUp();
      const closed = await apply(
        createBlockMutations(board).unblock,
        { block: 'B1', mode: 'reason', reason: 'Settled.' },
        actor,
        'u',
      );
      expect(closed.block).toMatchObject({ state: 'unblocked', outcome: 'reason' });
    },
  );

  it('rings again and lists a follow-up the operator edits after the answer', async () => {
    const { store, apply } = await followedUp();
    await apply(
      createBlockMutations(board).answer,
      { block: 'B1', text: 'hi' },
      'agent:cur/cur-1',
      'a',
    );
    const followUp = await store.db
      .selectFrom('comment')
      .selectAll()
      .where('text', '=', 'and more')
      .executeTakeFirstOrThrow();
    expect(followUp.acked_revision).toBe(followUp.revision);
    await scanTransaction(store, board, (trx) =>
      editInboundComment(trx, {
        comment: followUp,
        text: 'and more, edited',
        at: new Date(NOW + 1000).toISOString(),
        actor: 'operator',
        config: board,
      }),
    );
    const fresh = await store.db
      .selectFrom('notification')
      .select(['kind', 'role', 'comment_id'])
      .where('acked_at', 'is', null)
      .execute();
    expect(fresh).toEqual([{ kind: 'answer', role: 'curator', comment_id: followUp.id }]);
    const listed = await createQuery({ store, clock, config: board })(
      createTaskQueries({ config: board, clock, completeSince: new Map() }).inbox,
      {},
      'agent:cur/cur-1',
    );
    expect(listed.comments).toEqual([
      expect.objectContaining({ id: `C${String(followUp.id)}`, text: 'and more, edited' }),
    ]);
  });

  it('denies an agent of another Spur project', async () => {
    const { apply } = await followedUp();
    await expect(
      apply(createBlockMutations(board).answer, { block: 'B1', text: 'x' }, 'agent:qa/qa-1', 'a'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('follow-up on an answered block', () => {
  const inQa = (store: Store) =>
    store.transaction((trx) =>
      trx.updateTable('task').set({ column: 'qa' }).where('id', '=', 1).execute(),
    );
  /** A question the worker asked in `qa`, so the operator holds it, and the operator's answer. */
  async function answered(b: Awaited<ReturnType<typeof seeded>>, n: number): Promise<string> {
    const asked = await b.apply(
      ops.ask,
      { task: KEY, text: `Question ${String(n)}?` },
      author,
      `ask-${String(n)}`,
    );
    await b.apply(
      ops.answer,
      { block: asked.block.id, text: 'Use v2.' },
      'operator',
      `answer-${String(n)}`,
    );
    return asked.block.id;
  }
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('Expected a command error');
      },
      (error: unknown) => {
        if (!(error instanceof CommandError)) throw error;
        return error;
      },
    );

  it('refuses an open block, an archived task and a non-operator', async () => {
    const b = await seeded();
    const asked = await b.apply(ops.ask, { task: KEY, text: 'Which version?' }, author, 'ask-1');
    const created = await b.apply(
      ops.create,
      { task: KEY, type: 'dependency', reason: 'Needs outside work.' },
      orchestrator,
      'create-1',
    );
    const before = await counts(b.store);
    const question = await rejection(
      b.apply(ops.followup, { block: asked.block.id, text: 'More.' }, 'operator', 'follow-1'),
    );
    expect(question.code).toBe('block_still_open');
    expect(question.hint).toContain('board answer');
    const dependency = await rejection(
      b.apply(ops.followup, { block: created.block.id, text: 'More.' }, 'operator', 'follow-2'),
    );
    expect(dependency.code).toBe('block_still_open');
    expect(dependency.hint).toContain('board comment');
    expect(dependency.hint).toContain('--block');
    expect(await counts(b.store)).toEqual(before);

    await b.apply(ops.answer, { block: asked.block.id, text: 'Use v2.' }, orchestrator, 'answer-1');
    await expect(
      b.apply(ops.followup, { block: asked.block.id, text: 'More.' }, author, 'follow-3'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await b.store.transaction((trx) =>
      trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute(),
    );
    await expect(
      b.apply(ops.followup, { block: asked.block.id, text: 'More.' }, 'operator', 'follow-4'),
    ).rejects.toMatchObject({ code: 'task_archived' });
  });

  it('stores a follow-up the same way from a Slack thread and from the operation', async () => {
    const b = await seeded();
    await inQa(b.store);
    const slack = await answered(b, 1);
    const operation = await answered(b, 2);
    const text = 'Also check v3.';
    const inbound = await withVia('slack', () =>
      scanTransaction(b.store, config, (trx) =>
        recordInboundBlockMessage(trx, {
          blockId: Number(slack.slice(1)),
          text,
          conversationRef: 'thread-1',
          messageRef: 'thread-1-reply-2',
          at: new Date(NOW).toISOString(),
          config,
        }),
      ),
    );
    expect(inbound.answered).toBe(false);
    const followed = await b.apply(
      ops.followup,
      { block: operation, text },
      'operator',
      'follow-1',
    );
    expect(followed.comment).toMatchObject({ block: operation, author: 'operator', text });

    const ids = [inbound.comment.id, Number(followed.comment.id.slice(1))];
    const comments = await b.store.db
      .selectFrom('comment')
      .select(['block_id', 'author', 'text', 'task_id', 'revision'])
      .where('id', 'in', ids)
      .orderBy('id')
      .execute();
    expect(comments.map((row) => ({ ...row, block_id: undefined }))).toEqual([
      { block_id: undefined, author: 'operator', text, task_id: 1, revision: 1 },
      { block_id: undefined, author: 'operator', text, task_id: 1, revision: 1 },
    ]);
    expect(comments.map((row) => `B${String(row.block_id)}`)).toEqual([slack, operation]);

    const added = await b.store.db
      .selectFrom('event')
      .select(['payload', 'via'])
      .where('kind', '=', 'comment_added')
      .orderBy('id')
      .execute();
    const byComment = (id: number) =>
      added.filter(
        (row) => (JSON.parse(row.payload) as { comment: string }).comment === `C${String(id)}`,
      );
    const [slackEvent, operationEvent] = ids.map(byComment);
    expect(slackEvent).toHaveLength(1);
    expect(operationEvent).toHaveLength(1);
    expect(slackEvent?.[0]?.via).toBe('slack');
    const addressee = (rows: typeof added | undefined) =>
      (JSON.parse(rows?.[0]?.payload ?? '{}') as { addressee?: string }).addressee;
    expect(addressee(slackEvent)).toBe('worker');
    expect(addressee(operationEvent)).toBe(addressee(slackEvent));

    const rings = await Promise.all(
      ids.map((id) =>
        b.store.db
          .selectFrom('notification')
          .select(['kind', 'role', 'author_session'])
          .where('comment_id', '=', id)
          .execute(),
      ),
    );
    expect(rings).toEqual([
      [{ kind: 'answer', role: 'worker', author_session: 'worker-1' }],
      [{ kind: 'answer', role: 'worker', author_session: 'worker-1' }],
    ]);
    expect(
      await b.store.db.selectFrom('block').select(['state', 'outcome']).orderBy('id').execute(),
    ).toEqual([
      { state: 'unblocked', outcome: 'done' },
      { state: 'unblocked', outcome: 'done' },
    ]);
    const replies = (
      await b.store.db
        .selectFrom('outbox')
        .select('payload')
        .where('kind', '=', 'conversation.reply')
        .execute()
    ).map((row) => (JSON.parse(row.payload) as { commentId: number }).commentId);
    expect(replies.filter((id) => id === ids[0])).toHaveLength(0);
    expect(replies.filter((id) => id === ids[1])).toHaveLength(1);
  });

  it('keeps the block closed and the column and turn unchanged', async () => {
    const b = await seeded();
    await inQa(b.store);
    const block = await answered(b, 1);
    await b.store.transaction((trx) =>
      trx
        .insertInto('turn')
        .values({ ...sampleRows.turn, column: 'qa', closed_at: null, closed_reason: null })
        .execute(),
    );
    const snapshot = () =>
      Promise.all([
        b.store.db.selectFrom('task').selectAll().execute(),
        b.store.db.selectFrom('turn').selectAll().orderBy('id').execute(),
        b.store.db.selectFrom('block').selectAll().orderBy('id').execute(),
      ]);
    const before = await snapshot();
    const journal = (await events(b.store)).length;
    await b.apply(ops.followup, { block, text: 'Also check v3.' }, 'operator', 'follow-1');
    expect(await snapshot()).toEqual(before);
    expect((await events(b.store)).slice(journal).map((event) => event.kind)).toEqual([
      'comment_added',
    ]);
  });

  it("stores an operator-role session's follow-up under that session, like an answer", async () => {
    const b = await seeded();
    await inQa(b.store);
    const block = await answered(b, 1);
    const followed = await b.apply(
      ops.followup,
      { block, text: 'More.' },
      operatorAgent,
      'follow-1',
    );
    expect(followed.comment).toMatchObject({ author: operatorAgent, block });
    expect(
      await b.store.db
        .selectFrom('notification')
        .select(['kind', 'author_session'])
        .where('comment_id', '=', Number(followed.comment.id.slice(1)))
        .execute(),
    ).toEqual([{ kind: 'answer', author_session: 'worker-1' }]);
  });
});
