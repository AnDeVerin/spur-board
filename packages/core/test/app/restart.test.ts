import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVENT_VERSION,
  configSchema,
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
let now = NOW;
const clock = { now: () => now };
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });

class Rejected extends Error {
  readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode) {
    super(code);
    this.code = code;
  }
}

let calls = 0;
let thrown: Rejected | undefined;
function reject(code: ServerErrorCode): Rejected {
  thrown = new Rejected(code);
  return thrown;
}

const touch: Mutation<'block.ask'> = {
  id: 'block.ask',
  async resolveTargets(trx, input) {
    const task = await trx
      .selectFrom('task')
      .select(['id', 'project', 'column'])
      .where('key', '=', input.task)
      .executeTakeFirst();
    return task === undefined
      ? [{ kind: 'missing' }]
      : [
          {
            kind: 'found',
            value: { project: task.project, task, block: null, workers: [] },
          },
        ];
  },
  async run(trx, input, ctx) {
    calls += 1;
    const task = await trx
      .selectFrom('task')
      .select(['id', 'project', 'membership'])
      .where('key', '=', input.task)
      .executeTakeFirstOrThrow();
    const parsed = parseActorId(ctx.actor);
    if (parsed === null) throw new Error('invalid actor');
    const { id } = await trx
      .insertInto('block')
      .values({
        task_id: task.id,
        type: 'needs_input',
        reason: input.text,
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
    return {
      block: {
        id: block,
        task: input.task,
        type: 'needs_input' as const,
        state: 'open' as const,
        author: ctx.actor,
        addressee: 'operator' as const,
        reason: input.text,
        at: ctx.at,
        outcome: null,
      },
    };
  },
};

const add: Mutation<'task.add'> = {
  id: 'task.add',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run(_trx, input) {
    calls += 1;
    return Promise.resolve({
      task: {
        key: input.task,
        project: 'proj',
        column: 'dev' as const,
        membership: 'active' as const,
      },
    });
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
const input = { task: 'o/r#101', text: 'which API?' };

afterEach(async () => {
  calls = 0;
  thrown = undefined;
  now = NOW;
  for (const store of open.splice(0)) await store.close();
});

describe('apply', () => {
  it('returns the stored result after a crash between commit and reply', async () => {
    const file = await seededFile();
    const first = await createApply({ store: track(openStore(file)), clock, config })(
      touch,
      input,
      agent7,
      'K',
    );
    const restarted = track(openStore(file));
    const retried = await createApply({ store: restarted, clock, config })(
      touch,
      input,
      agent7,
      'K',
    );
    expect(first.block.id).toBe('B1');
    expect(retried).toEqual(first);
    expect(calls).toBe(1);
    expect(await counts(restarted)).toEqual({ block: 1, event: 1, command: 1 });
    expect(await restarted.db.selectFrom('command').selectAll().execute()).toMatchObject([
      { actor: agent7, key: 'K', operation: 'block.ask', result: JSON.stringify(first) },
    ]);
    expect(
      (await restarted.db.selectFrom('command').select('fingerprint').executeTakeFirstOrThrow())
        .fingerprint,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps keys in the actor namespace', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect((await apply(touch, input, agent8, 'K')).block.id).toBe('B2');
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect(calls).toBe(2);
    expect(await counts(store)).toEqual({ block: 2, event: 2, command: 2 });
  });

  it('rejects a changed input or operation under the same key', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    await apply(touch, input, agent7, 'K');
    expect(await apply(touch, { text: input.text, task: input.task }, agent7, 'K')).toMatchObject({
      block: { id: 'B1' },
    });
    await expect(
      apply(touch, { ...input, text: 'another question' }, agent7, 'K'),
    ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
    await expect(apply(add, { task: input.task }, agent7, 'K')).rejects.toMatchObject({
      code: 'idempotency_key_mismatch',
    });
    expect(calls).toBe(1);
  });

  it('refuses a legacy command whose fingerprint cannot be verified', async () => {
    const store = track(openStore(await seededFile()));
    await store.transaction(async (trx) => {
      await trx
        .insertInto('command')
        .values({
          actor: agent7,
          key: 'K',
          operation: 'block.ask',
          fingerprint: null,
          result: '{}',
          at: new Date(NOW).toISOString(),
        })
        .execute();
    });
    await expect(
      createApply({ store, clock, config })(touch, input, agent7, 'K'),
    ).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
    expect(calls).toBe(0);
  });

  it('replays after state changes and retains the first server-side time', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    const first = await apply(touch, input, agent7, 'K');
    await store.transaction(async (trx) => {
      await trx.updateTable('task').set({ membership: 'archived' }).where('id', '=', 1).execute();
    });
    now += 60_000;
    expect(await apply(touch, input, agent7, 'K')).toEqual(first);
    expect(first.block.at).toBe(new Date(NOW).toISOString());
    expect(calls).toBe(1);
    await expect(apply(touch, input, agent7, 'new')).rejects.toMatchObject({
      code: 'task_archived',
    });
  });

  it('stores nothing for a rejected state check and evaluates its retry', async () => {
    const store = track(openStore(await seededFile('archived')));
    const apply = createApply({ store, clock, config });
    const rejection = await apply(touch, input, agent7, 'K').catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Rejected);
    expect(rejection).toBe(thrown);
    expect(await counts(store)).toEqual({ block: 0, event: 0, command: 0 });
    await store.transaction(async (trx) => {
      await trx.updateTable('task').set({ membership: 'active' }).where('id', '=', 1).execute();
    });
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect(calls).toBe(2);
  });

  it('requires an agent key and applies an operator mutation without one', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    await expect(apply(touch, input, agent7)).rejects.toMatchObject({ code: 'usage' });
    await expect(apply(touch, input, agent7, '')).rejects.toMatchObject({ code: 'usage' });
    expect(calls).toBe(0);
    const result = await apply(add, { task: 'o/r#102' }, 'operator');
    expect(result.task.key).toBe('o/r#102');
    expect(calls).toBe(1);
    expect((await store.db.selectFrom('command').selectAll().execute()).length).toBe(1);
  });

  it('applies two concurrent calls with the same key once', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    const [a, b] = await Promise.all([
      apply(touch, input, agent7, 'K'),
      apply(touch, input, agent7, 'K'),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect(await counts(store)).toEqual({ block: 1, event: 1, command: 1 });
  });

  it('uses the first result when a replay crosses a process restart', async () => {
    const file = await seededFile();
    const first = await createApply({ store: track(openStore(file)), clock, config })(
      touch,
      input,
      agent7,
      'K',
    );
    now += 120_000;
    const replayed = await createApply({ store: track(openStore(file)), clock, config })(
      touch,
      input,
      agent7,
      'K',
    );
    expect(replayed.block.at).toBe(first.block.at);
    expect(calls).toBe(1);
  });
});
