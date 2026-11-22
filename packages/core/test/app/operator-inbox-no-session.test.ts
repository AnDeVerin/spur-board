import { afterEach, describe, expect, it } from 'vitest';
import { noSessionSummary } from '../../src/domain/fromYou.ts';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { ago, clock, HOUR, item, mixed, task } from '../support/operator-inbox.ts';
import { openTempStore } from '../support/store.ts';

// The `noSession` fields and text of `no-session:` items in the operator inbox.

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup() {
  const { store } = openTempStore('board-operator-inbox-no-session-');
  stores.push(store);
  const registry = createOperationRegistry({ config: mixed, clock, completeSince: new Map() });
  const query = createQuery({ store, config: mixed, clock });
  const inbox = () => query(registry['inbox.operator'], {}, 'operator');
  return { store, inbox };
}

describe('inbox.operator no-session items', () => {
  it('adds the waiting turns of non-archived tasks and the minutes without a session to an open no-session item', async () => {
    const { store, inbox } = setup();
    // An unrecorded open summary falls back to the binding and the task's waiting turn.
    const text = 'first review: turns wait for a live session of Spur project first-orch';
    // `first:dev` is unbound now; its handled entry keeps what it recorded.
    const clearedText = noSessionSummary({
      project: 'first',
      column: 'dev',
      spur: 'first-dev-orch',
      turn: 41,
      ringAt: ago(2 * HOUR),
    });
    const ids = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const tasks = [
        first,
        await task(trx, { project: 'first', key: 'o/first#2' }),
        await task(trx, { project: 'first', key: 'o/first#3', membership: 'archived' }),
      ];
      const turnIds: number[] = [];
      for (const [index, taskId] of tasks.entries()) {
        const row = await trx
          .insertInto('turn')
          .values({
            task_id: taskId,
            column: 'review',
            epoch: 1,
            seq: 1,
            role: 'orchestrator:review',
            reason: 'Review the PR',
            handed: '[]',
            acked_by: null,
            acked_at: null,
            closed_at: null,
            closed_reason: null,
            created_at: ago(30 - index),
            head_sha: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        turnIds.push(row.id);
        await trx
          .insertInto('notification')
          .values({
            source_key: `turn:${String(row.id)}`,
            kind: 'turn',
            task_id: taskId,
            block_id: null,
            comment_id: null,
            revision: null,
            role: 'orchestrator:review',
            author_session: null,
            recipient_session: null,
            next_at: ago(1),
            last_outbox_id: null,
            acked_at: null,
            exhausted_at: null,
            created_at: ago(30 - index),
            turn_id: row.id,
          })
          .execute();
      }
      const open = await item(trx, {
        key: 'no-session:first:review',
        kind: 'board_observation',
        taskId: first,
        text,
      });
      const cleared = await item(trx, {
        key: 'no-session:first:dev',
        kind: 'board_observation',
        taskId: first,
        text: clearedText,
        clearedAt: ago(HOUR),
      });
      await trx
        .updateTable('operator_item')
        .set({ fact_at: ago(14.5) })
        .where('item_key', 'like', 'no-session:%')
        .execute();
      return { open, cleared, oldest: turnIds[0] };
    });

    const { items, handled } = await inbox();

    const action =
      'start a session in Spur project first-orch, or take over its turns with board inbox ack';
    const open = items.find((entry) => entry.id === ids.open);
    expect(open).toMatchObject({
      text: `${text}; 2 waiting, no live session for 14 min: ${action}`,
      action,
    });
    expect(open?.noSession).toEqual({
      project: 'first',
      column: 'review',
      spurProject: 'first-orch',
      oldestTask: 'o/first#1',
      since: ago(14.5),
      waiting: 2,
      oldestTurn: `T${String(ids.oldest)}`,
      oldestAt: ago(30),
    });
    const cleared = handled.find((entry) => entry.id === ids.cleared);
    expect(cleared).toMatchObject({
      text: `${clearedText}: start a session in its Spur project, or take over its turns with board inbox ack`,
    });
    expect(cleared?.noSession).toEqual({
      project: 'first',
      column: 'dev',
      spurProject: 'first-dev-orch',
      oldestTask: 'o/first#1',
      since: ago(14.5),
      oldestTurn: 'T41',
    });
  });

  /** A `review` orchestrator turn of the task, ringing from `ring` when given. */
  const reviewTurn = async (
    trx: Parameters<Parameters<Store['transaction']>[0]>[0],
    taskId: number,
    turn: { seq: number; createdAt: string; closedAt?: string; ring?: string },
  ) => {
    const row = await trx
      .insertInto('turn')
      .values({
        task_id: taskId,
        column: 'review',
        epoch: 1,
        seq: turn.seq,
        role: 'orchestrator:review',
        reason: 'Review the PR',
        handed: '[]',
        acked_by: null,
        acked_at: null,
        closed_at: turn.closedAt ?? null,
        closed_reason: turn.closedAt === undefined ? null : 'moved',
        created_at: turn.createdAt,
        head_sha: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (turn.ring !== undefined)
      await trx
        .insertInto('notification')
        .values({
          source_key: `turn:${String(row.id)}`,
          kind: 'turn',
          task_id: taskId,
          block_id: null,
          comment_id: null,
          revision: null,
          role: 'orchestrator:review',
          author_session: null,
          recipient_session: null,
          next_at: ago(1),
          last_outbox_id: null,
          acked_at: null,
          exhausted_at: null,
          created_at: turn.ring,
          turn_id: row.id,
        })
        .execute();
    return row.id;
  };
  /** A `no-session:first:<column>` item raised 80 min ago, without a session since 85 min ago. */
  const noSessionItem = async (
    trx: Parameters<Parameters<Store['transaction']>[0]>[0],
    input: { taskId: number; text: string; column?: string; clearedAt?: string },
  ) => {
    const key = `no-session:first:${input.column ?? 'review'}`;
    const id = await item(trx, {
      key,
      kind: 'board_observation',
      taskId: input.taskId,
      text: input.text,
      raisedAt: ago(80),
      clearedAt: input.clearedAt ?? null,
    });
    await trx
      .updateTable('operator_item')
      .set({ fact_at: ago(85) })
      .where('item_key', '=', key)
      .execute();
    return id;
  };
  const summary = (spur: string, turn: number, ringAt: string) =>
    noSessionSummary({ project: 'first', column: 'review', spur, turn, ringAt });
  const fieldsOf = (entries: readonly { id: string; noSession?: unknown }[], id: string) =>
    entries.find((entry) => entry.id === id)?.noSession;

  it('keeps the recorded turn on a handled no-session item when it closed before the raise', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const taskId = await task(trx, { project: 'first', key: 'o/first#1' });
      const turn = await reviewTurn(trx, taskId, {
        seq: 1,
        createdAt: ago(120),
        closedAt: ago(81),
      });
      await reviewTurn(trx, taskId, { seq: 2, createdAt: ago(20), ring: ago(20) });
      const id = await noSessionItem(trx, {
        taskId,
        text: summary('first-orch', turn, ago(120)),
        clearedAt: ago(30),
      });
      return { id, turn };
    });

    expect(fieldsOf((await inbox()).handled, ids.id)).toEqual({
      project: 'first',
      column: 'review',
      spurProject: 'first-orch',
      oldestTask: 'o/first#1',
      since: ago(85),
      oldestTurn: `T${String(ids.turn)}`,
    });
  });

  it('keeps the recorded Spur project on a handled no-session item after the column is rebound', async () => {
    const { store, inbox } = setup();
    const id = await store.transaction(async (trx) => {
      const taskId = await task(trx, { project: 'first', key: 'o/first#1' });
      return noSessionItem(trx, {
        taskId,
        text: summary('old-orch', 7, ago(120)),
        clearedAt: ago(30),
      });
    });

    const entry = (await inbox()).handled.find((found) => found.id === id);
    expect(entry?.noSession).toMatchObject({ spurProject: 'old-orch', oldestTurn: 'T7' });
    // The text and action stay as they were: the action names the current binding.
    expect(entry?.action).toBe(
      'start a session in Spur project first-orch, or take over its turns with board inbox ack',
    );
  });

  it('names the recorded turn without its ring time once a replacement turn waits instead', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const taskId = await task(trx, { project: 'first', key: 'o/first#1' });
      const turn = await reviewTurn(trx, taskId, {
        seq: 1,
        createdAt: ago(60),
        closedAt: ago(40),
      });
      await reviewTurn(trx, taskId, { seq: 2, createdAt: ago(40), ring: ago(40) });
      const id = await noSessionItem(trx, { taskId, text: summary('first-orch', turn, ago(60)) });
      return { id, turn };
    });

    expect(fieldsOf((await inbox()).items, ids.id)).toEqual({
      project: 'first',
      column: 'review',
      spurProject: 'first-orch',
      oldestTask: 'o/first#1',
      since: ago(85),
      waiting: 1,
      oldestTurn: `T${String(ids.turn)}`,
    });
  });

  it('gives the recorded ring time while the recorded turn still waits', async () => {
    const { store, inbox } = setup();
    const ids = await store.transaction(async (trx) => {
      const taskId = await task(trx, { project: 'first', key: 'o/first#1' });
      const turn = await reviewTurn(trx, taskId, { seq: 1, createdAt: ago(60), ring: ago(59) });
      const id = await noSessionItem(trx, { taskId, text: summary('first-orch', turn, ago(59)) });
      return { id, turn };
    });

    expect(fieldsOf((await inbox()).items, ids.id)).toMatchObject({
      waiting: 1,
      oldestTurn: `T${String(ids.turn)}`,
      oldestAt: ago(59),
    });
  });

  it('leaves out the Spur project when neither the summary nor the binding names one', async () => {
    const { store, inbox } = setup();
    const id = await store.transaction(async (trx) => {
      const taskId = await task(trx, { project: 'first', key: 'o/first#1' });
      return noSessionItem(trx, {
        taskId,
        column: 'dev',
        text: 'first dev: turns wait',
        clearedAt: ago(30),
      });
    });

    expect(fieldsOf((await inbox()).handled, id)).toEqual({
      project: 'first',
      column: 'dev',
      oldestTask: 'o/first#1',
      since: ago(85),
    });
  });
});
