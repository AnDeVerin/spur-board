import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '@spur-board/core';
import { createE2eHarness } from './e2e-harness.ts';

type Harness = Awaited<ReturnType<typeof createE2eHarness>>;
const active: Harness[] = [];
afterEach(async () => {
  for (const harness of active.splice(0)) await harness.dispose();
});

describe('restart during board ask', () => {
  it('replays a committed ask after its response is lost without duplicating the block or thread', async () => {
    const h = await createE2eHarness();
    active.push(h);
    await h.start();
    const key = 'ask-proj-123-restart-0800';
    h.dropNextResponse();
    const unknown = await h.cli(['ask', h.taskKey, 'Which release?', '--key', key, '--json']);
    expect(unknown.code).toBe(5);
    expect(unknown.stderr).toContain(`key: ${key}`);
    await h.stop();
    expect(h.gateway.platform.conversations()).toHaveLength(0);
    const persisted = openStore(h.dbFile);
    try {
      expect(await persisted.db.selectFrom('block').select('id').execute()).toHaveLength(1);
      expect(
        await persisted.db
          .selectFrom('outbox')
          .select(['kind', 'state'])
          .where('kind', '=', 'conversation.open')
          .execute(),
      ).toEqual([{ kind: 'conversation.open', state: 'pending' }]);
    } finally {
      await persisted.close();
    }
    await h.start();
    const retry = await h.cli(['ask', h.taskKey, 'Which release?', '--key', key, '--json']);
    expect(retry.code).toBe(0);
    const output = JSON.parse(retry.stdout) as { block: { id: string } };
    expect(output.block.id).toBe('B1');
    await h.pulse();
    expect(await h.store.db.selectFrom('block').select('id').execute()).toHaveLength(1);
    expect(h.gateway.platform.conversations()).toHaveLength(1);

    await h.stop();
    const unavailable = await h.cli([
      'ask',
      h.taskKey,
      'Different question',
      '--key',
      'ask-proj-123-down-0801',
      '--json',
    ]);
    expect(unavailable.code).toBe(3);
    await h.start();
    expect(await h.store.db.selectFrom('block').select('id').execute()).toHaveLength(1);
    await h.pulse();
    expect(h.gateway.platform.conversations()).toHaveLength(1);
  });
});
