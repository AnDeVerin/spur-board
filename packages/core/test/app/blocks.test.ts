import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type ActorId, type ColumnId, type Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  createApply,
  createBlockMutations,
  openStore,
  type Store,
} from '../../src/index.ts';
import { reconcileItems } from '../../src/app/fromYou.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { sampleRows } from '../store/sample-rows.ts';

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
        { name: 'qa', role: 'worker' },
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

  it('addresses dependency and external blocks from a configured operator agent to operator', async () => {
    const { store, apply } = await seeded();
    for (const [type, actor] of [
      ['dependency', operatorAgent],
      ['external', remoteOperator],
    ] as const) {
      const created = await apply(
        ops.create,
        { task: KEY, type, reason: 'Waiting for a decision.' },
        actor,
        `operator-${type}`,
      );
      expect(created.block).toMatchObject({ author: actor, addressee: 'operator' });
    }
    expect(await counts(store)).toMatchObject({ outbox: 0 });
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

/** A board on the shared seed whose task sits in `column`; `dev` is orchestrated by `qa`. */
async function curatorBoard(column: ColumnId = 'dev', used: Config = withCurator()) {
  const { store } = await seeded();
  await store.transaction((trx) =>
    trx.updateTable('task').set({ column }).where('id', '=', 1).execute(),
  );
  return {
    store,
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
    const { apply, ops: curated } = await curatorBoard('dev', used);
    const created = await apply(
      curated.create,
      { task: KEY, type: 'dependency', reason: 'Waiting.' },
      curator,
      'create',
    );
    expect(created.block.addressee).toBe('orchestrator:dev');
    const own = await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'own');
    expect(own.block.addressee).toBe('operator');
    const asked = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(asked.block.addressee).toBe('orchestrator:dev');
    const hop = await apply(curated.escalate, { block: asked.block.id }, curator, 'hop-1');
    expect(hop.block.addressee).toBe('curator');
    const top = await apply(curated.escalate, { block: asked.block.id }, curator, 'hop-2');
    expect(top.block.addressee).toBe('operator');
  });
});

describe('curator escalation', () => {
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
    const { apply, ops: curated } = await curatorBoard('qa');
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(block.addressee).toBe('curator');
    const answered = await apply(
      curated.answer,
      { block: block.id, text: 'A.' },
      'operator',
      'answer',
    );
    expect(answered.block).toMatchObject({ state: 'unblocked', outcome: 'done' });
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

  it('rings nobody at the curator and opens the thread once at the operator', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    expect(block.addressee).toBe('curator');
    expect(await store.db.selectFrom('notification').select('id').execute()).toEqual([]);
    expect(await store.db.selectFrom('outbox').select('id').execute()).toEqual([]);
    await reconcile(store);
    expect(await operatorItems(store)).toEqual([]);

    await apply(curated.escalate, { block: block.id }, curator, 'esc');
    expect(await store.db.selectFrom('notification').select('id').execute()).toEqual([]);
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([
      { kind: 'conversation.open' },
    ]);
    await reconcile(store);
    expect(await operatorItems(store)).toEqual([`operator-block:${block.id.slice(1)}`]);
  });

  it('answers at the curator without writing a thread reply or close', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    const { block } = await apply(curated.ask, { task: KEY, text: 'Q?' }, author, 'ask');
    await apply(curated.answer, { block: block.id, text: 'A.' }, curator, 'answer');
    expect(await store.db.selectFrom('outbox').select('kind').execute()).toEqual([]);
  });

  it('opens the thread of a curator question under the orchestrator persona', async () => {
    const { store, apply, ops: curated } = await curatorBoard('qa', used);
    await apply(curated.ask, { task: KEY, text: 'Q?' }, curator, 'ask');
    const rows = await store.db.selectFrom('outbox').select(['kind', 'payload']).execute();
    expect(rows.map((row) => row.kind)).toEqual(['conversation.open']);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({
      persona: { name: 'cur', role: 'orchestrator' },
    });
  });
});
