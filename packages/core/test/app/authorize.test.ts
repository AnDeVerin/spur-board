import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLUMN_IDS,
  OPERATIONS,
  RESERVED_PROJECT,
  configSchema,
  type ActorId,
  type BlockType,
  type Config,
} from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deniedProject } from '../../src/app/denied-event.ts';
import {
  CommandError,
  authorize,
  createApply,
  createQuery,
  openStore,
  type AuthorizationTarget,
  type Mutation,
  type Query,
  type Store,
} from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';

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
      columns: COLUMN_IDS.map((id) => ({ id, orchestrator: id === 'dev' ? 'qa' : 'none' })),
    },
    {
      id: 'other',
      tracker: { type: 'github-issues', repo: 'x/y', milestone: 'M1' },
      repos: ['x/y'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'foreign', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});

const actors = {
  operator: 'operator',
  same: 'agent:web/web-7',
  other: 'agent:foreign/foreign-1',
  worker: 'agent:web/worker-1',
  sameSession: 'agent:web/web-8',
  orchestrator: 'agent:qa/qa-1',
  addressee: 'agent:web/addressee-1',
  author: 'agent:web/author-1',
} as const satisfies Record<string, ActorId>;
type ActorLabel = keyof typeof actors;
type MutationId = Extract<(typeof OPERATIONS)[number], { kind: 'mutation' }>['id'];

function operation(id: string) {
  const entry = OPERATIONS.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Missing catalog operation ${id}`);
  return entry;
}

const projectAgents: readonly ActorLabel[] = [
  'same',
  'worker',
  'sameSession',
  'orchestrator',
  'addressee',
  'author',
];
const allowed = {
  'inbox.ack': projectAgents,
  'token.revoke': ['operator'],
  'task.add': ['operator'],
  'task.archive': ['operator'],
  'link.add': ['operator'],
  'link.remove': ['operator'],
  'item.retry': ['operator'],
  'item.close': ['operator'],
  'block.ask': projectAgents,
  'comment.add': ['operator', ...projectAgents],
  'comment.edit': ['operator', ...projectAgents],
  'block.create': ['operator', 'orchestrator'],
  'block.escalate': ['worker', 'addressee'],
  'block.answer': ['operator', 'worker', 'addressee'],
  'block.unblock': ['worker', 'addressee'],
} satisfies Record<MutationId, readonly ActorLabel[]>;

const block: NonNullable<AuthorizationTarget['block']> = {
  type: 'code',
  author: actors.author,
  addressee_role: 'worker',
};
const target: AuthorizationTarget = {
  project: 'proj',
  task: { id: 1, column: 'dev' },
  block,
  workers: [
    { session_id: 'worker-1', role: 'worker', banned: 0 },
    { session_id: 'addressee-1', role: 'worker', banned: 0 },
    { session_id: 'web-8', role: 'worker', banned: 1 },
  ],
};

const cases = [
  ...OPERATIONS.filter((operation) => operation.kind === 'mutation').map((operation) => ({
    operation,
    mode: operation.id === 'block.unblock' ? 'done' : undefined,
    type: operation.id === 'block.answer' ? 'needs_input' : 'code',
    allowed: allowed[operation.id],
  })),
  {
    operation: operation('block.unblock'),
    mode: 'reason',
    type: 'code',
    allowed: ['operator', 'worker', 'orchestrator', 'addressee'],
  },
  {
    operation: operation('block.unblock'),
    mode: 'withdraw',
    type: 'needs_input',
    allowed: ['author'],
  },
] as const;

describe('authorize catalog grants', () => {
  it('covers every current mutation and every unblock mode', () => {
    expect(Object.keys(allowed).sort()).toEqual(
      OPERATIONS.filter((operation) => operation.kind === 'mutation')
        .map((operation) => operation.id)
        .sort(),
    );
    expect(
      cases.filter(({ operation }) => operation.id === 'block.unblock').map(({ mode }) => mode),
    ).toEqual(['done', 'reason', 'withdraw']);
    for (const row of cases) {
      for (const [label, actor] of Object.entries(actors)) {
        const state = {
          config,
          target: {
            kind: 'found' as const,
            value: {
              ...target,
              block: { ...block, type: row.type as BlockType },
            },
          },
          ...(row.mode === undefined ? {} : { mode: row.mode }),
        };
        const expected = (row.allowed as readonly string[]).includes(label) ? 'allowed' : 'denied';
        expect(
          authorize(row.operation.grants, actor, state).status,
          `${row.operation.id}/${row.mode ?? 'default'}/${label}`,
        ).toBe(expected);
      }
    }
  });

  it('uses configured operator projects and task worker links', () => {
    const archive = operation('task.archive');
    const state = { config, target: { kind: 'found' as const, value: target } };
    expect(authorize(archive.grants, 'agent:ops/ops-1', state).status).toBe('allowed');
    const unblock = operation('block.unblock');
    expect(authorize(unblock.grants, actors.sameSession, { ...state, mode: 'done' }).status).toBe(
      'denied',
    );
  });

  it('resolves each block addressee role against current state', () => {
    const escalate = operation('block.escalate');
    const state = (addressee_role: 'operator' | 'orchestrator:dev' | 'worker') => ({
      config,
      target: {
        kind: 'found' as const,
        value: {
          ...target,
          block: { ...block, addressee_role },
        },
      },
    });
    expect(authorize(escalate.grants, actors.operator, state('operator')).status).toBe('allowed');
    expect(authorize(escalate.grants, actors.same, state('operator')).status).toBe('denied');
    expect(authorize(escalate.grants, actors.orchestrator, state('orchestrator:dev')).status).toBe(
      'allowed',
    );
    expect(authorize(escalate.grants, actors.other, state('orchestrator:dev')).status).toBe(
      'denied',
    );
    expect(authorize(escalate.grants, actors.worker, state('worker')).status).toBe('allowed');
  });

  describe('curator', () => {
    const curator = 'agent:cur/cur-1';
    const curated = (projHasCurator: boolean) =>
      configSchema.parse({
        ...config,
        projects: config.projects.map((project) => ({
          ...project,
          spurProjects:
            project.id === 'other'
              ? [{ name: 'foreign', role: 'curator' }]
              : projHasCurator
                ? [...project.spurProjects, { name: 'cur', role: 'curator' }]
                : project.spurProjects,
        })),
      });
    const state = (
      addressee_role: NonNullable<AuthorizationTarget['block']>['addressee_role'],
      type: BlockType = 'needs_input',
      mode?: string,
      used = curated(true),
    ) => ({
      config: used,
      target: {
        kind: 'found' as const,
        value: { ...target, block: { ...block, type, addressee_role } },
      },
      ...(mode === undefined ? {} : { mode }),
    });
    const answer = operation('block.answer');
    const unblock = operation('block.unblock');

    it('lets the curator of the board project answer and unblock a curator-addressed block', () => {
      expect(authorize(answer.grants, curator, state('curator')).status).toBe('allowed');
      expect(
        authorize(unblock.grants, curator, state('curator', 'needs_input', 'reason')).status,
      ).toBe('allowed');
    });

    it.each([true, false])(
      "denies another board project's curator on this project's block (own curator: %s)",
      (projHasCurator) => {
        const decision = authorize(
          answer.grants,
          actors.other,
          state('curator', 'needs_input', undefined, curated(projHasCurator)),
        );
        expect(decision.status).toBe('denied');
      },
    );

    it('denies workers and orchestrators on a curator-addressed block', () => {
      for (const actor of [actors.worker, actors.same, actors.orchestrator]) {
        expect(authorize(answer.grants, actor, state('curator')).status, actor).toBe('denied');
      }
    });

    it('keeps the operator override on a curator-addressed block', () => {
      expect(authorize(answer.grants, actors.operator, state('curator')).status).toBe('allowed');
      expect(
        authorize(unblock.grants, actors.operator, state('curator', 'needs_input', 'reason'))
          .status,
      ).toBe('allowed');
    });

    it('denies a curator on blocks addressed to anyone else', () => {
      expect(authorize(answer.grants, curator, state('operator')).status).toBe('denied');
      for (const role of ['worker', 'orchestrator:dev'] as const) {
        expect(authorize(answer.grants, curator, state(role, 'code')).status, role).toBe('denied');
        for (const mode of ['reason', 'done']) {
          expect(
            authorize(unblock.grants, curator, state(role, 'code', mode)).status,
            `${role}/${mode}`,
          ).toBe('denied');
        }
      }
    });

    it('never gives a curator the operator grant', () => {
      for (const id of ['task.archive', 'task.add', 'link.add', 'item.close', 'block.create']) {
        expect(authorize(operation(id).grants, curator, state('curator')).status, id).toBe(
          'denied',
        );
      }
    });
  });

  it('limits unblock grants to their declared block types', () => {
    const unblock = operation('block.unblock');
    const state = (type: BlockType, mode: string) => ({
      config,
      mode,
      target: { kind: 'found' as const, value: { ...target, block: { ...block, type } } },
    });
    expect(authorize(unblock.grants, actors.worker, state('dependency', 'done')).status).toBe(
      'denied',
    );
    expect(authorize(unblock.grants, actors.author, state('code', 'withdraw')).status).toBe(
      'denied',
    );
    expect(authorize(unblock.grants, actors.orchestrator, state('external', 'reason')).status).toBe(
      'denied',
    );
  });

  it('classifies every operation input key as a project hint or not', () => {
    const HINT = ['task', 'project'];
    const NOT_HINT = [
      'role',
      'entries',
      'name',
      'mode',
      'pr',
      'session',
      'ticket',
      'reason',
      'item',
      'text',
      'comment',
      'type',
      'block',
      'ref',
      'answer',
      'detail',
    ];
    const keys = new Set<string>();
    for (const entry of OPERATIONS) {
      const input: z.ZodType = entry.input;
      const shapes =
        input instanceof z.ZodObject
          ? [input]
          : input instanceof z.ZodDiscriminatedUnion
            ? (input.options as z.ZodObject[])
            : [];
      expect(shapes, `${entry.id} input is an object or a union of objects`).not.toHaveLength(0);
      for (const shape of shapes) for (const key of Object.keys(shape.shape)) keys.add(key);
    }
    expect(
      [...keys].filter((key) => !HINT.includes(key) && !NOT_HINT.includes(key)),
      'classify each new input key: a project hint goes in HINT and in deniedProject',
    ).toEqual([]);
  });
});

const stores: Store[] = [];
const clock = { now: () => Date.parse('2026-11-03T10:00:00.000Z') };
function track(store: Store): Store {
  stores.push(store);
  return store;
}
async function seeded(): Promise<Store> {
  const store = track(openStore(join(mkdtempSync(join(tmpdir(), 'core-authorize-')), 'board.db')));
  await store.transaction(async (trx) => {
    await trx
      .insertInto('task')
      .values({ ...sampleRows.task, project: 'proj' })
      .execute();
    await trx
      .insertInto('task')
      .values({
        ...sampleRows.task,
        id: 2,
        project: 'other',
        key: 'x/y#202',
        tracker_id: '202',
      })
      .execute();
    await trx
      .insertInto('comment')
      .values([
        { ...sampleRows.comment, id: 1, task_id: 1, block_id: null, acked_revision: null },
        { ...sampleRows.comment, id: 2, task_id: 2, block_id: null, acked_revision: null },
      ])
      .execute();
  });
  return store;
}

let runs = 0;
const ack: Mutation<'inbox.ack'> = {
  id: 'inbox.ack',
  async resolveTargets(trx, input) {
    return Promise.all(
      input.entries.map(async ({ id: text }) => {
        const id = Number(text.slice(1));
        const row = await trx
          .selectFrom('comment')
          .innerJoin('task', 'task.id', 'comment.task_id')
          .select(['comment.id as commentId', 'task.id as taskId', 'task.project', 'task.column'])
          .where('comment.id', '=', id)
          .executeTakeFirst();
        return row === undefined
          ? { kind: 'missing' as const, id: text }
          : {
              kind: 'found' as const,
              id: `C${String(row.commentId)}`,
              value: {
                project: row.project,
                task: { id: row.taskId, column: row.column },
                block: null,
                workers: [],
              },
            };
      }),
    );
  },
  async run(trx, input) {
    runs += 1;
    for (const entry of input.entries) {
      if (!('revision' in entry)) continue;
      await trx
        .updateTable('comment')
        .set({ acked_revision: entry.revision })
        .where('id', '=', Number(entry.id.slice(1)))
        .execute();
    }
    return { acked: input.entries.map(({ id }) => id) };
  },
};

const entries = (...ids: string[]) => ({ entries: ids.map((id) => ({ id, revision: 1 })) });

const emptyAsk: Mutation<'block.ask'> = {
  id: 'block.ask',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run() {
    runs += 1;
    return Promise.reject(new Error('must not run'));
  },
};
const emptyAck: Mutation<'inbox.ack'> = {
  id: 'inbox.ack',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run() {
    runs += 1;
    return Promise.reject(new Error('must not run'));
  },
};
const taskless: Mutation<'task.add'> = {
  id: 'task.add',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run(_trx, input) {
    runs += 1;
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
const retry: Mutation<'item.retry'> = {
  id: 'item.retry',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run(_trx, input) {
    runs += 1;
    return Promise.resolve({
      item: {
        id: input.item,
        task: null,
        at: new Date(clock.now()).toISOString(),
        summary: 'Retry',
      },
    });
  },
};
const close: Mutation<'item.close'> = {
  id: 'item.close',
  resolveTargets() {
    return Promise.resolve([]);
  },
  run(_trx, input) {
    runs += 1;
    return Promise.resolve({
      item: {
        id: input.item,
        task: null,
        at: new Date(clock.now()).toISOString(),
        summary: 'Closed',
      },
    });
  },
};

afterEach(async () => {
  runs = 0;
  for (const store of stores.splice(0)) await store.close();
});

describe('authorization at the command boundary', () => {
  it('commits a denial with actor and operation but no effect or command row', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    const refusal = await apply(ack, entries('C1'), actors.other, 'K').catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(CommandError);
    if (!(refusal instanceof CommandError)) throw new Error('Expected a command refusal');
    expect(refusal.code).toBe('forbidden');
    expect(refusal.hint).toContain('project-agent');
    expect(runs).toBe(0);
    expect(await store.db.selectFrom('command').selectAll().execute()).toHaveLength(0);
    expect(
      (
        await store.db
          .selectFrom('comment')
          .select('acked_revision')
          .where('id', '=', 1)
          .executeTakeFirstOrThrow()
      ).acked_revision,
    ).toBeNull();
    expect(await store.db.selectFrom('event').selectAll().execute()).toMatchObject([
      {
        kind: 'operation_denied',
        project: 'proj',
        task_id: 1,
        actor: 'agent',
        actor_ref: '{"project":"foreign","session":"foreign-1"}',
        payload: '{"operation":"inbox.ack","reason":"Caller does not match the operation grants."}',
        request_id: 'K',
      },
    ]);
  });

  it('authorizes every found batch target before applying any acknowledgement', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    await expect(apply(ack, entries('C1', 'C2'), actors.same, 'K')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(runs).toBe(0);
    expect(await store.db.selectFrom('comment').select('acked_revision').execute()).toEqual([
      { acked_revision: null },
      { acked_revision: null },
    ]);
    expect(await store.db.selectFrom('event').selectAll().execute()).toHaveLength(1);
  });

  it('defers a missing target until a found target is authorized', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    await expect(apply(ack, entries('C999', 'C1'), actors.other, 'K')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(apply(ack, entries('C999', 'C1'), actors.same, 'other-key')).rejects.toMatchObject(
      { code: 'not_found' },
    );
    expect(runs).toBe(0);
  });

  it('rejects empty targets for target-dependent mutations and permits operator-only taskless calls', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    await expect(
      apply(emptyAsk, { task: 'o/r#101', text: 'Question?' }, actors.same, 'A'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(apply(emptyAck, entries('C1'), actors.same, 'B')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(runs).toBe(0);
    await expect(apply(taskless, { task: 'o/r#103' }, actors.same, 'C')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await apply(taskless, { task: 'o/r#103' }, actors.operator)).task.key).toBe('o/r#103');
    expect((await apply(retry, { item: 'I1' }, actors.operator)).item.id).toBe('I1');
    expect((await apply(close, { item: 'I1' }, actors.operator)).item.id).toBe('I1');
    expect(runs).toBe(3);
  });

  it('does not let a partial inbox resolver skip an item', async () => {
    const store = await seeded();
    const partial: Mutation<'inbox.ack'> = {
      ...ack,
      resolveTargets(trx, input, actor) {
        const first = input.entries.at(0);
        if (first === undefined) throw new Error('Expected a comment ID');
        return ack.resolveTargets(trx, { entries: [first] }, actor);
      },
    };
    await expect(
      createApply({ store, clock, config })(partial, entries('C1', 'C2'), actors.same, 'K'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(runs).toBe(0);
  });

  it('does not let a duplicate inbox target authorize another requested comment', async () => {
    const store = await seeded();
    const duplicate: Mutation<'inbox.ack'> = {
      ...ack,
      async resolveTargets(trx, input, actor) {
        const first = input.entries.at(0);
        if (first === undefined) throw new Error('Expected a comment ID');
        const [target] = await ack.resolveTargets(trx, { entries: [first] }, actor);
        if (target === undefined) throw new Error('Expected a resolved target');
        return input.entries.map(() => target);
      },
    };
    await expect(
      createApply({ store, clock, config })(duplicate, entries('C1', 'C2'), actors.same, 'K'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(runs).toBe(0);
    expect(await store.db.selectFrom('comment').select('acked_revision').execute()).toEqual([
      { acked_revision: null },
      { acked_revision: null },
    ]);
    expect(await store.db.selectFrom('command').selectAll().execute()).toHaveLength(0);
  });

  it('applies an inbox acknowledgement when the resolved ID matches', async () => {
    const store = await seeded();
    const result = await createApply({ store, clock, config })(
      ack,
      entries('C1'),
      actors.same,
      'K',
    );
    expect(result.acked).toEqual(['C1']);
    expect(runs).toBe(1);
    expect(
      (
        await store.db
          .selectFrom('comment')
          .select('acked_revision')
          .where('id', '=', 1)
          .executeTakeFirstOrThrow()
      ).acked_revision,
    ).toBe(1);
  });

  it('rejects a query or unknown operation ID before the handler runs', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    const query = { ...taskless, id: 'status.get' } as unknown as Mutation<'task.add'>;
    const unknown = { ...taskless, id: 'unknown' } as unknown as Mutation<'task.add'>;
    await expect(apply(query, { task: 'o/r#103' }, actors.operator)).rejects.toBeInstanceOf(
      CommandError,
    );
    await expect(apply(unknown, { task: 'o/r#103' }, actors.operator)).rejects.toBeInstanceOf(
      CommandError,
    );
    expect(runs).toBe(0);
  });

  it('returns forbidden before a handler state check on an existing target', async () => {
    const store = await seeded();
    const check: Mutation<'block.ask'> = {
      id: 'block.ask',
      resolveTargets() {
        return Promise.resolve([{ kind: 'found', value: target }]);
      },
      run() {
        return Promise.reject(new CommandError('task_archived', 'Task is archived.'));
      },
    };
    const apply = createApply({ store, clock, config });
    await expect(
      apply(check, { task: 'o/r#101', text: 'Question?' }, actors.other, 'K'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      apply(check, { task: 'o/r#101', text: 'Question?' }, actors.same, 'other'),
    ).rejects.toMatchObject({ code: 'task_archived' });
    expect(await store.db.selectFrom('event').selectAll().execute()).toHaveLength(1);
  });

  it('lets an authorized caller reach a wrong-block-type state check', async () => {
    const store = await seeded();
    const answer: Mutation<'block.answer'> = {
      id: 'block.answer',
      resolveTargets() {
        return Promise.resolve([{ kind: 'found', value: target }]);
      },
      run() {
        return Promise.reject(new CommandError('wrong_block_type', 'Answer a question block.'));
      },
    };
    await expect(
      createApply({ store, clock, config })(
        answer,
        { block: 'B1', text: 'Answer' },
        'operator',
        'K',
      ),
    ).rejects.toMatchObject({ code: 'wrong_block_type' });
    expect(await store.db.selectFrom('event').selectAll().execute()).toHaveLength(0);
    expect(await store.db.selectFrom('command').selectAll().execute()).toHaveLength(0);
  });
});

describe('target-less denial project', () => {
  const stranger = 'agent:stranger/s-1';
  const rows = (store: Store) =>
    store.db
      .selectFrom('event')
      .select(['kind', 'project', 'task_id', 'actor'])
      .orderBy('id')
      .execute();

  it('journals under the project the task key names', async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    await expect(apply(taskless, { task: 'x/y#5' }, actors.same, 'D1')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await rows(store)).toEqual([
      { kind: 'operation_denied', project: 'other', task_id: null, actor: 'agent' },
    ]);
  });

  it('uses a configured project input and falls through on an unconfigured one', () => {
    expect(deniedProject(config, actors.same, { project: 'other' })).toBe('other');
    expect(deniedProject(config, actors.same, { project: 'nope' })).toBe('proj');
    expect(deniedProject(config, stranger, { project: 'nope' })).toBe(RESERVED_PROJECT);
    expect(deniedProject(config, 'operator', undefined)).toBe(RESERVED_PROJECT);
    expect(deniedProject(config, stranger, 'o/r#1')).toBe(RESERVED_PROJECT);
    expect(deniedProject(config, stranger, { task: 7, project: null })).toBe(RESERVED_PROJECT);
  });

  it("journals under the actor's only board project", async () => {
    const store = await seeded();
    const apply = createApply({ store, clock, config });
    await expect(apply(taskless, { task: 'zz/q#1' }, actors.same, 'D2')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const tokenList: Query<'token.list'> = {
      id: 'token.list',
      resolveTargets: () => Promise.resolve([]),
      run: () => Promise.reject(new Error('must not run')),
    };
    await expect(
      createQuery({ store, clock, config })(tokenList, {}, actors.same),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await rows(store)).toEqual([
      { kind: 'operation_denied', project: 'proj', task_id: null, actor: 'agent' },
      { kind: 'operation_denied', project: 'proj', task_id: null, actor: 'agent' },
    ]);
  });

  it('falls back to the reserved project', async () => {
    const store = await seeded();
    await expect(
      createApply({ store, clock, config })(taskless, { task: 'zz/q#1' }, stranger, 'D3'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // configSchema refuses a Spur project under two board projects, so this is built without it.
    const shared: Config = {
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        spurProjects: [...project.spurProjects, { name: 'shared', role: 'worker' }],
      })),
    };
    await expect(
      createApply({ store, clock, config: shared })(
        taskless,
        { task: 'zz/q#1' },
        'agent:shared/s-1',
        'D4',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await rows(store)).toEqual([
      { kind: 'operation_denied', project: RESERVED_PROJECT, task_id: null, actor: 'agent' },
      { kind: 'operation_denied', project: RESERVED_PROJECT, task_id: null, actor: 'agent' },
    ]);
  });

  it('never journals a target-less denial under a configured board project', async () => {
    const store = await seeded();
    const withBoard = configSchema.parse({
      ...config,
      projects: [
        ...config.projects,
        {
          id: 'board',
          tracker: { type: 'github-issues', repo: 'b/c', milestone: 'M1' },
          repos: ['b/c'],
          operatorGithubLogin: 'operator',
        },
      ],
    });
    const apply = createApply({ store, clock, config: withBoard });
    await expect(apply(taskless, { task: 'zz/q#1' }, stranger, 'D5')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(apply(taskless, { task: 'b/c#1' }, stranger, 'D6')).rejects.toMatchObject({
      code: 'forbidden',
    });
    const [unmapped, named] = await rows(store);
    expect(unmapped?.project).toBe(RESERVED_PROJECT);
    expect(unmapped?.project).not.toBe('board');
    expect(named?.project).toBe('board');
  });
});
