import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type {} from '../packages/testkit/src/global-setup.ts';
import {
  createShellQaServer,
  shellConfig,
  shellFixture,
  shellInbox,
  shellTask,
  shellHistory,
  shellScenarios,
} from './web-shell-qa.ts';
import { browserOperations, statusOutputSchema } from '../packages/contracts/src/browser.ts';
import { APP_FILES } from './package.ts';

const webAssetsRoot = inject('webAssetsRoot');

describe('shell QA scenarios', () => {
  it.each(shellScenarios)('%s fixture conforms to the production status shape', (name) => {
    expect(statusOutputSchema.safeParse(shellFixture(name)).success).toBe(true);
  });
  it('config and inbox fixtures conform to the browser read shapes', () => {
    expect(browserOperations['config.get'].output.safeParse(shellConfig()).success).toBe(true);
    expect(browserOperations['inbox.operator'].output.safeParse(shellInbox()).success).toBe(true);
    expect(browserOperations['task.get'].output.safeParse(shellTask()).success).toBe(true);
    expect(browserOperations['task.history'].output.safeParse(shellHistory()).success).toBe(true);
    expect(shellConfig().projects.map((project) => project.id)).toEqual([
      ...new Set(shellFixture('healthy').tasks.map((task) => task.project)),
    ]);
  });
  it('provides empty, mixed-health long-name and recovery data', () => {
    expect(shellFixture('empty').tasks).toHaveLength(0);
    const mixed = shellFixture('mixed').sources;
    expect(mixed).toHaveLength(12);
    expect(mixed.some((source) => source.blindReason !== null)).toBe(true);
    expect(mixed.some((source) => !source.stale && source.blindReason === null)).toBe(true);
    expect(shellFixture('recovered').tasks).toHaveLength(2);
  });
});

it('serves built assets and controlled status/error/recovery fixtures on loopback', async () => {
  const server = createShellQaServer(webAssetsRoot);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(origin)).status).toBe(200);
    for (const file of APP_FILES) {
      const response = await fetch(`${origin}/${file}`);
      expect([response.status, response.headers.get('content-type')], file).toEqual([
        200,
        file.endsWith('.png')
          ? 'image/png'
          : file.endsWith('.svg')
            ? 'image/svg+xml'
            : 'application/manifest+json',
      ]);
      expect(
        Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(webAssetsRoot, file))),
        file,
      ).toBe(true);
    }
    const queries = Object.values(browserOperations).filter((op) => op.kind === 'query');
    for (const op of queries) {
      const response = await fetch(`${origin}/v1/ops/${op.id}`, { method: 'POST' });
      expect(response.status, op.id).toBe(200);
      await response.body?.cancel();
    }
    for (const name of ['empty', 'mixed', 'read-error', 'recovered']) {
      expect((await fetch(`${origin}/__qa/scenario/${name}`, { method: 'POST' })).status).toBe(204);
      const response = await fetch(`${origin}/v1/ops/status.get`, { method: 'POST' });
      const config = await fetch(`${origin}/v1/ops/config.get`, { method: 'POST' });
      const inbox = await fetch(`${origin}/v1/ops/inbox.operator`, { method: 'POST' });
      if (name === 'read-error') {
        expect([response.status, config.status, inbox.status]).toEqual([500, 500, 500]);
        await Promise.all([response, config, inbox].map((answer) => answer.text()));
      } else {
        const body = (await response.json()) as { value: unknown };
        expect(statusOutputSchema.parse(body.value)).toEqual(
          shellFixture(name === 'empty' ? 'empty' : name === 'mixed' ? 'mixed' : 'recovered'),
        );
        const configBody = (await config.json()) as { value: unknown };
        expect(browserOperations['config.get'].output.parse(configBody.value)).toEqual(
          shellConfig(),
        );
        const inboxBody = (await inbox.json()) as { value: unknown };
        expect(browserOperations['inbox.operator'].output.parse(inboxBody.value)).toEqual(
          shellInbox(),
        );
      }
    }
    expect((await fetch(`${origin}/__qa/scenario/loading`, { method: 'POST' })).status).toBe(204);
    const pending = queries.map((op) => fetch(`${origin}/v1/ops/${op.id}`, { method: 'POST' }));
    const early = await Promise.race([
      Promise.all(pending).then(() => 'answered'),
      new Promise((resolve) => setTimeout(resolve, 100, 'held')),
    ]);
    expect(early).toBe('held');
    expect((await fetch(`${origin}/__qa/release`, { method: 'POST' })).status).toBe(204);
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const events = await fetch(`${origin}/v1/events`);
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body?.getReader();
    if (!reader) throw new Error('Missing fixture event stream');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: hello');
    await reader.cancel();
    const legacy = await fetch(`${origin}/v1/stream`);
    expect(legacy.status).toBe(404);
    expect(await legacy.text()).toBe('');
    await fetch(`${origin}/__qa/scenario/stream-drop`, { method: 'POST' });
    expect((await fetch(`${origin}/v1/events`)).status).toBe(502);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
