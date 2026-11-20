import type { ActorId, Config } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createApply, createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import {
  ago,
  block,
  clock,
  failedPost,
  HOUR,
  item,
  mixed,
  ownOnly,
  task,
} from '../support/operator-inbox.ts';
import { openTempStore } from '../support/store.ts';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/**
 * Per project: the failed post of a `board project ask` (only its outbox payload names the
 * block), the undelivered answer to one (the item's block), and an item of a task; plus a board
 * item that names nothing.
 */
async function subjects(store: Store): Promise<Record<string, string>> {
  return store.transaction(async (trx) => {
    const ids: Record<string, string> = {};
    for (const project of ['first', 'second']) {
      const asked = await block(trx, { project });
      ids[`${project} ask post`] = await failedPost(trx, {
        kind: 'conversation.open',
        payload: { key: `${project} (project)`, taskId: null, blockId: asked, commentId: null },
      });
      const answered = await block(trx, { project, unblockedAt: ago(HOUR) });
      ids[`${project} answer`] = await item(trx, {
        key: `answer_undelivered:${String(answered)}`,
        kind: 'answer_undelivered',
        blockId: answered,
      });
      const taskId = await task(trx, { project, key: `o/${project}#1` });
      ids[`${project} task`] = await item(trx, {
        key: `inbound:${project}`,
        kind: 'inbound_failure',
        taskId,
      });
    }
    ids.board = await item(trx, { key: 'token:8', kind: 'token_request' });
    return ids;
  });
}

const firstOnes = ['first ask post', 'first answer', 'first task'];
const secondOnes = ['second ask post', 'second answer', 'second task'];

describe("an operator item's project", () => {
  it.each([
    ['no board-wide operator', 'operator', ownOnly, [...firstOnes, ...secondOnes, 'board']],
    ['no board-wide operator', 'agent:first-ops/s1', ownOnly, firstOnes],
    ['a board-wide operator', 'operator', mixed, [...firstOnes, ...secondOnes, 'board']],
    ['a board-wide operator', 'agent:first-ops/s1', mixed, firstOnes],
    ['a board-wide operator', 'agent:hq/s1', mixed, [...secondOnes, 'board']],
  ] as const)(
    'with %s, %s sees and acts on the same items in the inbox, status and item actions',
    async (_name, actor: ActorId, config: Config, expected: readonly string[]) => {
      const store = openTempStore('board-item-subject-').store;
      stores.push(store);
      const registry = createOperationRegistry({ config, clock, completeSince: new Map() });
      const query = createQuery({ store, config, clock });
      const apply = createApply({ store, config, clock });
      const ids = await subjects(store);
      const { items } = await query(registry['inbox.operator'], {}, actor);
      const status = await query(registry['status.get'], {}, actor);
      const permitted = (run: Promise<unknown>) =>
        run.then(
          () => true,
          (error: unknown) => (error as { code?: string }).code !== 'forbidden',
        );
      const seen = [];
      for (const [subject, id] of Object.entries(ids)) {
        const input = { item: id };
        seen.push([
          subject,
          items.some((entry) => entry.id === id),
          status.items.some((entry) => entry.id === id),
          await permitted(apply(registry['item.retry'], input, actor, `retry-${id}`)),
          await permitted(apply(registry['item.close'], input, actor, `close-${id}`)),
        ]);
      }
      expect(seen).toEqual(
        Object.keys(ids).map((subject) => {
          const mine = expected.includes(subject);
          return [subject, mine, mine, mine, mine];
        }),
      );
    },
  );
});
