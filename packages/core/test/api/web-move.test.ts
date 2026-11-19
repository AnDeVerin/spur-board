import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { expect, it } from 'vitest';
import { createWebServer, createOperationRegistry } from '../../src/index.ts';
import { openTempStore } from '../support/store.ts';
import { sampleRows } from '../store/sample-rows.ts';

const origin = 'https://web.example.test';
const headers = { host: 'web.example.test', origin, 'content-type': 'application/json' };
const post = (id: string, input: unknown) => ({
  method: 'POST' as const,
  url: `/v1/ops/${id}`,
  headers,
  payload: JSON.stringify({ input }),
});
async function setup() {
  const config = configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
    web: { port: 4312, publicOrigin: origin },
  });
  const root = mkdtempSync(join(tmpdir(), 'web-move-assets-'));
  writeFileSync(join(root, 'index.html'), '<html>Board</html>');
  const store = openTempStore('web-move-').store;
  const clock = { now: () => Date.parse('2026-11-04T08:00:00Z') };
  const app = await createWebServer({
    store,
    config,
    clock,
    webRoot: root,
    logRequest: () => {},
    registry: createOperationRegistry({ config, clock, completeSince: new Map() }),
    ready: () => true,
    firstPollDone: () => Promise.resolve(true),
  });
  return { app, store, root };
}

it('manually moves as operator with an explicit key, exact reason and web provenance', async () => {
  const { app, store, root } = await setup();
  try {
    await store.db
      .insertInto('task')
      .values({ ...sampleRows.task, membership: 'active', archive_reason: null, column: 'todo' })
      .execute();
    const reason = '  Ready\r\n\t<script> <!chan\u006eel> <@U123> *bold* `code` &  ';
    const request = post('task.move', {
      mode: 'manual',
      task: 'o/r#101',
      column: 'ready-for-dev',
      reason,
    });
    for (const key of [undefined, '', '   ']) {
      const response = await app.inject({
        ...request,
        payload: JSON.stringify({
          input: { mode: 'manual', task: 'o/r#101', column: 'ready-for-dev', reason },
          ...(key === undefined ? {} : { key }),
        }),
      });
      expect(response.statusCode).toBe(400);
    }
    const payload = JSON.stringify({
      input: { mode: 'manual', task: 'o/r#101', column: 'ready-for-dev', reason },
      key: 'web-manual',
    });
    const response = await app.inject({ ...request, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      value: { from: 'todo', to: 'ready-for-dev', column: 'ready-for-dev', settled: [] },
    });
    const event = await store.db
      .selectFrom('event')
      .selectAll()
      .where('kind', '=', 'task_manually_moved')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({ actor: 'operator', via: 'web', request_id: 'web-manual' });
    expect(JSON.parse(event.payload)).toEqual({ from: 'todo', to: 'ready-for-dev', reason });
    const replay: unknown = (await app.inject({ ...request, payload })).json();
    const original: unknown = response.json();
    expect(replay).toMatchObject({ ok: true });
    expect(original).toMatchObject({ ok: true });
    const inputOutput = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('value' in value))
        throw new Error('Missing value');
      return value.value;
    };
    expect(inputOutput(replay)).toEqual(inputOutput(original));
    expect(
      await store.db
        .selectFrom('event')
        .select('id')
        .where('kind', '=', 'task_manually_moved')
        .execute(),
    ).toHaveLength(1);
    const history = await app.inject(post('task.history', { task: 'o/r#101' }));
    expect(history.json()).toMatchObject({
      value: {
        events: [
          expect.objectContaining({
            kind: 'task_manually_moved',
            actor: 'operator',
            via: 'web',
            summary: `Manually moved todo → ready-for-dev: ${reason}`.replace(/\s+/g, ' ').trim(),
          }),
        ],
      },
    });
  } finally {
    await app.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
