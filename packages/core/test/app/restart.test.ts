import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockIdSchema,
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type ServerErrorCode,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApply, openStore, toJson, type Mutation, type Store } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const clock = { now: () => NOW };

class Rejected extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode) {
    super(code);
    this.code = code;
  }
}

const actorRefSchema = z.strictObject({
  project: z.string().min(1),
  session: z.string().min(1),
});

let calls = 0;
let thrown: Rejected | undefined;

function reject(code: ServerErrorCode): Rejected {
  thrown = new Rejected(code);
  return thrown;
}

const touch: Mutation<
  z.ZodObject<{ block: typeof blockIdSchema }, z.core.$strict>,
  { taskId: number; reason: string }
> = {
  id: 'test.touch',
  kind: 'mutation',
  output: z.strictObject({ block: blockIdSchema }),
  async run(trx, input, ctx) {
    calls += 1;
    const task = await trx
      .selectFrom('task')
      .select(['id', 'project', 'membership'])
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (task === undefined) throw reject('not_found');
    const parsed = parseActorId(ctx.actor);
    if (parsed === null) throw new Error('invalid actor');
    const { id } = await trx
      .insertInto('block')
      .values({
        task_id: task.id,
        type: 'needs_input',
        reason: input.reason,
        author: ctx.actor,
        addressee_role: 'operator',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: ctx.at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const block = `B${String(id)}`;
    await trx
      .insertInto('event')
      .values({
        at: ctx.at,
        project: task.project,
        task_id: task.id,
        kind: 'block_opened',
        actor: parsed.actor,
        actor_ref: parsed.actor === 'agent' ? toJson(actorRefSchema, parsed.actorRef) : null,
        payload: toJson(eventPayloadSchemas.block_opened, {
          block,
          type: 'needs_input',
          addressee: 'operator',
        }),
        v: EVENT_VERSION,
        request_id: null,
      })
      .execute();
    if (task.membership === 'archived') throw reject('task_archived');
    return { block };
  },
};

const open: Store[] = [];

function track(store: Store): Store {
  open.push(store);
  return store;
}

async function seededFile(membership: 'active' | 'archived' = 'active'): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), 'core-apply-')), 'board.db');
  const store = track(openStore(file));
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({ ...sampleRows.task, membership })
      .execute();
  });
  return file;
}

async function counts(store: Store): Promise<{ block: number; event: number; command: number }> {
  const count = async (table: 'block' | 'event' | 'command') =>
    (await store.db.selectFrom(table).selectAll().execute()).length;
  return {
    block: await count('block'),
    event: await count('event'),
    command: await count('command'),
  };
}

const agent7: ActorId = 'agent:web/web-7';
const agent8: ActorId = 'agent:web/web-8';
const input = { taskId: 1, reason: 'which API?' };

afterEach(async () => {
  calls = 0;
  thrown = undefined;
  for (const store of open.splice(0)) await store.close();
});

describe('apply', () => {
  it('returns the stored result after a crash between commit and reply', async () => {
    const file = await seededFile();
    const first = await createApply({ store: track(openStore(file)), clock })(
      touch,
      input,
      agent7,
      'K',
    );
    // The reply is lost: the first store is abandoned without close(), then the daemon restarts.
    const restarted = track(openStore(file));
    const retried = await createApply({ store: restarted, clock })(touch, input, agent7, 'K');

    expect(first).toEqual({ block: 'B1' });
    expect(retried).toEqual(first);
    expect(calls).toBe(1);
    expect(await counts(restarted)).toEqual({ block: 1, event: 1, command: 1 });
    expect(await restarted.db.selectFrom('command').selectAll().execute()).toEqual([
      {
        actor: agent7,
        key: 'K',
        operation: 'test.touch',
        fingerprint: null,
        result: '{"block":"B1"}',
        at: new Date(NOW).toISOString(),
      },
    ]);
  });

  it('keeps keys in the actor namespace', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock });

    expect(await apply(touch, input, agent7, 'K')).toEqual({ block: 'B1' });
    expect(await apply(touch, input, agent8, 'K')).toEqual({ block: 'B2' });
    expect(await apply(touch, input, agent7, 'K')).toEqual({ block: 'B1' });
    expect(await apply(touch, input, agent8, 'K')).toEqual({ block: 'B2' });
    expect(calls).toBe(2);
    expect(await counts(store)).toEqual({ block: 2, event: 2, command: 2 });
  });

  it('stores nothing for a rejected command and evaluates its retry', async () => {
    const store = track(openStore(await seededFile('archived')));
    const apply = createApply({ store, clock });

    const rejection = await apply(touch, input, agent7, 'K').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Rejected);
    expect(rejection).toBe(thrown);
    expect(rejection).toMatchObject({ code: 'task_archived' });
    expect(await counts(store)).toEqual({ block: 0, event: 0, command: 0 });

    await store.transaction(async (trx) => {
      await trx.updateTable('task').set({ membership: 'active' }).where('id', '=', 1).execute();
    });
    expect(await apply(touch, input, agent7, 'K')).toEqual({ block: 'B1' });
    expect(calls).toBe(2);
    expect(await counts(store)).toEqual({ block: 1, event: 1, command: 1 });
  });

  it('applies two concurrent calls with the same key once', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock });

    const [a, b] = await Promise.all([
      apply(touch, input, agent7, 'K'),
      apply(touch, input, agent7, 'K'),
    ]);
    expect(a).toEqual({ block: 'B1' });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    expect(await counts(store)).toEqual({ block: 1, event: 1, command: 1 });
  });
});
