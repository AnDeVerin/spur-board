import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVENT_VERSION,
  configSchema,
  eventPayloadSchemas,
  parseActorId,
  userIdSchema,
  type ActorId,
  type ServerErrorCode,
} from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createApply,
  createInbound,
  openStore,
  toJson,
  type Mutation,
  type Store,
} from '../../src/index.ts';
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
        outcomeReason: null,
        unblockedBy: null,
        unblockedAt: null,
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

async function inboundFixture() {
  const file = await seededFile();
  const store = track(openStore(file));
  const gateway = createFakeGateway({ profile: 'slack-like', start: new Date(NOW) });
  const delivered = await gateway.deliver({
    key: 'question-open',
    maybeSent: false,
    target: { kind: 'open', space: 'orchestrators', title: 'Question' },
    persona: { name: 'board', role: 'board' },
    body: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'Which API?' }] }],
  });
  if (delivered.status !== 'delivered' || delivered.conversation === undefined) {
    throw new Error('Expected a conversation');
  }
  const conversation = delivered.conversation;
  await store.transaction(async (trx) => {
    await trx
      .insertInto('block')
      .values({
        task_id: 1,
        type: 'needs_input',
        reason: 'Which API?',
        author: 'system',
        addressee_role: 'operator',
        target_column: null,
        state: 'open',
        outcome: null,
        outcome_reason: null,
        repeat_of: null,
        unblocked_by: null,
        unblocked_at: null,
        created_at: new Date(NOW).toISOString(),
      })
      .execute();
    await trx
      .insertInto('conversation')
      .values({
        gateway: gateway.kind,
        ref: conversation,
        space: 'orchestrators',
        task_id: 1,
        block_id: 1,
        purpose: 'block',
        state: 'open',
        root_message_ref: delivered.message,
        after_message_ref: null,
        created_at: new Date(NOW).toISOString(),
        closed_at: null,
      })
      .execute();
  });
  return { file, store, gateway, conversation };
}

async function reopenInbound(
  file: string,
  store: Store,
  gateway: ReturnType<typeof createFakeGateway>,
) {
  await store.close();
  open.splice(open.indexOf(store), 1);
  const restarted = track(openStore(file));
  return { store: restarted, inbound: createInbound({ store: restarted, gateway, config, clock }) };
}

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
    expect(await restarted.db.selectFrom('command').selectAll().execute()).toEqual([
      {
        actor: agent7,
        key: 'K',
        operation: 'block.ask',
        fingerprint: '8938079f9a7e1eff50f245c6c4d497cbe5097672069bbc94932d844788abd7d5',
        result: JSON.stringify(first),
        at: new Date(NOW).toISOString(),
      },
    ]);
  });

  it('keeps keys in the actor namespace', async () => {
    const store = track(openStore(await seededFile()));
    const apply = createApply({ store, clock, config });
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect((await apply(touch, input, agent8, 'K')).block.id).toBe('B2');
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect((await apply(touch, input, agent8, 'K')).block.id).toBe('B2');
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
    expect(rejection).toMatchObject({ code: 'task_archived' });
    expect(await counts(store)).toEqual({ block: 0, event: 0, command: 0 });
    await store.transaction(async (trx) => {
      await trx.updateTable('task').set({ membership: 'active' }).where('id', '=', 1).execute();
    });
    expect((await apply(touch, input, agent7, 'K')).block.id).toBe('B1');
    expect(calls).toBe(2);
    expect(await counts(store)).toEqual({ block: 1, event: 1, command: 1 });
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
    expect(a.block.id).toBe('B1');
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

describe('inbound restart', () => {
  const operator = userIdSchema.parse('operator');

  it('keeps one answer when the gateway loses its acknowledgment after commit', async () => {
    const fixture = await inboundFixture();
    const inbound = createInbound({
      store: fixture.store,
      gateway: fixture.gateway,
      config,
      clock,
    });
    await fixture.gateway.start(async (event) => {
      await inbound.sink(event);
      if (event.kind === 'message') throw new Error('ack lost after commit');
    });
    await fixture.gateway.platform.settle();
    await expect(
      fixture.gateway.platform.inject({
        kind: 'message',
        conversation: fixture.conversation,
        author: operator,
        text: 'Use API v2',
      }),
    ).rejects.toThrow('ack lost after commit');
    expect(await fixture.store.db.selectFrom('comment').select('id').execute()).toHaveLength(1);
    await fixture.gateway.stop();
    const restarted = await reopenInbound(fixture.file, fixture.store, fixture.gateway);
    await restarted.inbound.recover();
    expect(await restarted.store.db.selectFrom('comment').select('id').execute()).toHaveLength(1);
    expect(await restarted.store.db.selectFrom('command').select('key').execute()).toHaveLength(1);
  });

  it('applies an answer posted during downtime on connection start', async () => {
    const fixture = await inboundFixture();
    await fixture.gateway.platform.inject({
      kind: 'message',
      conversation: fixture.conversation,
      author: operator,
      text: 'Use API v2',
    });
    const restarted = await reopenInbound(fixture.file, fixture.store, fixture.gateway);
    await fixture.gateway.start((event) => restarted.inbound.sink(event));
    await fixture.gateway.platform.settle();
    expect(await restarted.store.db.selectFrom('comment').select('text').execute()).toEqual([
      { text: 'Use API v2' },
    ]);
    expect(
      await restarted.store.db.selectFrom('block').select(['state', 'outcome']).executeTakeFirst(),
    ).toEqual({ state: 'unblocked', outcome: 'done' });
    await fixture.gateway.stop();
  });

  it('recovers a downtime edit as a new answer revision', async () => {
    const fixture = await inboundFixture();
    const inbound = createInbound({
      store: fixture.store,
      gateway: fixture.gateway,
      config,
      clock,
    });
    await fixture.gateway.start((event) => inbound.sink(event));
    await fixture.gateway.platform.settle();
    const posted = await fixture.gateway.platform.inject({
      kind: 'message',
      conversation: fixture.conversation,
      author: operator,
      text: 'Use API v2',
    });
    await fixture.gateway.stop();
    if (posted.message === undefined) throw new Error('Expected posted message');
    fixture.gateway.platform.advance(1000);
    now += 1000;
    await fixture.gateway.platform.inject({
      kind: 'edit',
      message: posted.message,
      text: 'Use API v3',
    });
    const restarted = await reopenInbound(fixture.file, fixture.store, fixture.gateway);
    await fixture.gateway.start((event) => restarted.inbound.sink(event));
    await fixture.gateway.platform.settle();
    expect(
      await restarted.store.db.selectFrom('comment').select(['text', 'revision']).execute(),
    ).toEqual([{ text: 'Use API v3', revision: 2 }]);
    expect(await restarted.store.db.selectFrom('comment').select('id').execute()).toHaveLength(1);
    await fixture.gateway.stop();
  });
});
