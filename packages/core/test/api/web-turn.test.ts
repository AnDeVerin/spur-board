import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createWebServer, createOperationRegistry } from '../../src/index.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import { openTurn } from '../../src/app/turns.ts';
import { openTempStore } from '../support/store.ts';
import { sampleRows } from '../store/sample-rows.ts';

const origin = 'https://web.example.test';
const headers = { host: 'web.example.test', origin, 'content-type': 'application/json' };
const AT = '2026-11-04T08:00:00.000Z';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'worker', role: 'worker' },
        { name: 'rev', role: 'orchestrator' },
      ],
      columns: [
        { id: 'todo', orchestrator: 'none' },
        { id: 'dev', orchestrator: 'none' },
        { id: 'review', orchestrator: 'rev' },
        { id: 'done', orchestrator: 'none' },
      ],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
  web: { port: 4312, publicOrigin: origin },
});

async function setup(runOperation: (id: string, input: unknown) => void = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'web-turn-assets-'));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'index.html'), '<html>Board</html>');
  const store = openTempStore('web-turn-').store;
  cleanups.push(() => store.close());
  const clock = { now: () => Date.parse(AT) };
  const app = await createWebServer({
    store,
    config,
    clock,
    webRoot: root,
    logRequest: () => {},
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    firstPollDone: () => Promise.resolve(true),
    runOperation: (id, input, run) => {
      runOperation(id, input);
      return run();
    },
  });
  cleanups.push(() => app.close());
  const post = (id: string, input: unknown, key?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/ops/${id}`,
      headers,
      payload: JSON.stringify({ input, ...(key === undefined ? {} : { key }) }),
    });
  return { app, store, post };
}

const WRITES = [
  { id: 'inbox.ack', input: { entries: [{ id: 'T9' }] } },
  { id: 'task.submit', input: { turn: 'T9', sha: 'a'.repeat(40) } },
  { id: 'task.return', input: { turn: 'T9', reason: 'Fix the parser.' } },
];

it.each(WRITES)(
  'lets the Turn section reach the $id handler as operator',
  async ({ id, input }) => {
    const runOperation = vi.fn();
    const { post } = await setup(runOperation);
    const response = await post(id, input, `web-${id}`);
    // 403 would mean the web listener refused the op before its handler; not_found is the handler's.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    expect(runOperation).toHaveBeenCalledWith(id, input);
  },
);

it.each(WRITES)('refuses $id on the web without a key', async ({ id, input }) => {
  const runOperation = vi.fn();
  const { post } = await setup(runOperation);
  for (const key of [undefined, '', '   ']) {
    const response = await post(id, input, key);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'usage' });
  }
  expect(runOperation).not.toHaveBeenCalled();
});

it('takes an orchestrator turn and returns it through the web, journaled as operator via web', async () => {
  const { store, post } = await setup();
  await store.db
    .insertInto('task')
    .values({ ...sampleRows.task, membership: 'active', archive_reason: null, column: 'review' })
    .execute();
  await scanTransaction(store, config, async (trx) => {
    const task = await trx.selectFrom('task').selectAll().executeTakeFirstOrThrow();
    return openTurn(trx, { task, reason: 'Review', handed: [], at: new Date(AT), config });
  });
  const turn = await store.db.selectFrom('turn').select('id').executeTakeFirstOrThrow();
  const id = `T${String(turn.id)}`;
  const ack = await post('inbox.ack', { entries: [{ id }] }, 'web-ack');
  expect(ack.statusCode).toBe(200);
  expect(ack.json()).toMatchObject({ value: { acked: [id] } });
  const returned = await post('task.return', { turn: id, reason: 'Fix the parser.' }, 'web-ret');
  expect(returned.statusCode).toBe(200);
  expect(returned.json()).toMatchObject({
    value: { task: { column: 'dev' }, block: { author: 'operator', type: 'code' } },
  });
  // The same key answers the stored result instead of returning the task again.
  const again = await post('task.return', { turn: id, reason: 'Fix the parser.' }, 'web-ret');
  expect(again.json()).toMatchObject({ value: returned.json<{ value: unknown }>().value });
  const history = await post('task.history', { task: sampleRows.task.key });
  const events = history.json<{
    value: { events: { kind: string; actor: string; via?: string }[] };
  }>().value.events;
  for (const kind of ['turn_taken', 'turn_closed'])
    expect(events.find((event) => event.kind === kind)).toMatchObject({
      actor: 'operator',
      via: 'web',
    });
});
