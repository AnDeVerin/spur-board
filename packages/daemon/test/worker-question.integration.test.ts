import { afterEach, describe, expect, it } from 'vitest';
import { createE2eHarness } from './e2e-harness.ts';

type Harness = Awaited<ReturnType<typeof createE2eHarness>>;
const active: Harness[] = [];
afterEach(async () => {
  for (const harness of active.splice(0)) await harness.dispose();
});

async function setup(): Promise<Harness> {
  const harness = await createE2eHarness();
  active.push(harness);
  await harness.start();
  return harness;
}

async function ask(harness: Harness, key: string) {
  const result = await harness.cli([
    'ask',
    harness.taskKey,
    'Which release?',
    '--key',
    key,
    '--json',
  ]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(`key: ${key}`);
  const output = JSON.parse(result.stdout) as { block: { id: string } };
  expect(output.block.id).toMatch(/^B[1-9][0-9]*$/);
  await harness.pulse();
  expect(harness.gateway.platform.conversations()).toHaveLength(1);
  const conversation = harness.gateway.platform.conversations()[0];
  if (conversation === undefined) throw new Error('Missing conversation');
  return { blockId: output.block.id, conversation: conversation.ref };
}

describe('worker question through the daemon', () => {
  it('answers, rings, acknowledges and clarifies a worker question', async () => {
    const h = await setup();
    const { blockId, conversation } = await ask(h, 'ask-proj-123-release-0800');
    expect(await h.store.db.selectFrom('block').select('id').execute()).toHaveLength(1);
    const storedConversation = await h.store.db
      .selectFrom('conversation')
      .select(['space', 'block_id'])
      .executeTakeFirstOrThrow();
    expect(storedConversation.space).toBe('orchestrators');
    expect(`B${String(storedConversation.block_id)}`).toBe(blockId);
    const open = await h.store.db
      .selectFrom('outbox')
      .select('payload')
      .where('kind', '=', 'conversation.open')
      .executeTakeFirstOrThrow();
    const openPayload: unknown = JSON.parse(open.payload);
    expect(openPayload).toMatchObject({ persona: { name: 'worker', role: 'worker' } });

    await h.gateway.platform.inject({
      kind: 'message',
      conversation,
      author: h.operator,
      text: 'Use the stable release.',
    });
    await h.gateway.platform.settle();
    const block = await h.store.db
      .selectFrom('block')
      .select(['state', 'outcome'])
      .executeTakeFirstOrThrow();
    expect(block).toEqual({ state: 'unblocked', outcome: 'done' });
    const comment = await h.store.db
      .selectFrom('comment')
      .select(['id', 'block_id', 'revision', 'text'])
      .where('author', '=', 'operator')
      .executeTakeFirstOrThrow();
    expect(`B${String(comment.block_id)}`).toBe(blockId);
    expect(comment.text).toBe('Use the stable release.');
    h.advance(1001);
    await h.pulse();
    expect(h.gateway.platform.conversations()[0]?.done).toBe(true);
    expect(h.gateway.platform.messages().some((message) => message.text.includes('done'))).toBe(
      true,
    );
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.session).toBe(h.session);
    expect(h.sends[0]?.text).toContain('board inbox');

    const inbox = await h.cli(['inbox', '--json']);
    expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.stdout)).toMatchObject({
      comments: [{ id: `C${String(comment.id)}`, block: blockId, untrusted: true }],
    });

    h.advance(120_001);
    await h.pulse();
    expect(h.sends).toHaveLength(2);
    const ack = await h.cli([
      'inbox',
      'ack',
      `C${String(comment.id)}@${String(comment.revision)}`,
      '--key',
      'ack-proj-123-answer-0802',
      '--json',
    ]);
    expect(ack.code).toBe(0);
    h.advance(300_001);
    await h.pulse();
    expect(h.sends).toHaveLength(2);

    await h.gateway.platform.inject({
      kind: 'message',
      conversation,
      author: h.operator,
      text: 'One more detail.',
    });
    await h.gateway.platform.settle();
    await h.pulse();
    expect(
      await h.store.db
        .selectFrom('comment')
        .select('id')
        .where('author', '=', 'operator')
        .execute(),
    ).toHaveLength(2);
    expect(
      await h.store.db
        .selectFrom('notification')
        .select('id')
        .where('kind', '=', 'answer')
        .execute(),
    ).toHaveLength(2);
    expect(h.sends).toHaveLength(3);
  });

  it('recovers an answer posted while the daemon is down', async () => {
    const h = await setup();
    const { conversation } = await ask(h, 'ask-proj-123-downtime-0800');
    await h.stop();
    await h.gateway.platform.inject({
      kind: 'message',
      conversation,
      author: h.operator,
      text: 'Answer during downtime.',
    });
    await h.start();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await h.store.db
        .selectFrom('comment')
        .select('id')
        .where('author', '=', 'operator')
        .execute();
      if (rows.length > 0) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(
      await h.store.db
        .selectFrom('comment')
        .select('text')
        .where('author', '=', 'operator')
        .execute(),
    ).toEqual([{ text: 'Answer during downtime.' }]);
    await h.pulse();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.text).toContain('board inbox');
    const inbox = await h.cli(['inbox', '--json']);
    expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.stdout)).toMatchObject({
      comments: [{ text: 'Answer during downtime.', untrusted: true }],
    });
  });
});
