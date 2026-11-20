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
 * block), the undelivered answer to one (the item's block), a Slack answer to one whose author
 * is unavailable (only its key names the comment) and a failed Slack reply in its thread (only
 * the stored event names the thread), as rows raised before items stored the block, an item
 * of a task, and a red default branch and a blind tracker, which name only the project's source.
 * Plus a board item that names nothing, a blind Spur, which every project shares, and a red
 * branch, a failed delivery and an item of a task of a project that has left the config, which
 * are the board's.
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
      const thread = `thread-${project}`;
      await trx
        .insertInto('conversation')
        .values({
          gateway: 'slack',
          ref: thread,
          space: 'orchestrators',
          task_id: null,
          block_id: asked,
          purpose: 'block',
          state: 'open',
          root_message_ref: `root-${project}`,
          after_message_ref: null,
          created_at: ago(HOUR),
          closed_at: null,
        })
        .execute();
      const answer = await trx
        .insertInto('comment')
        .values({
          task_id: null,
          block_id: asked,
          author: 'operator',
          text: 'Version 2.',
          conversation_ref: thread,
          message_ref: `reply-${project}`,
          acked_revision: null,
          created_at: ago(HOUR),
          delivery_state: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[`${project} author away`] = await item(trx, {
        key: `doorbell:unavailable:doorbell:comment:${String(answer.id)}:revision:1`,
        kind: 'answer_author_unavailable',
      });
      ids[`${project} reply failed`] = await item(trx, {
        key: `inbound:failure:reply-${project}`,
        kind: 'inbound_failure',
        inboundEvent: { kind: 'message', conversation: thread, message: `reply-${project}` },
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
      const repo = `github:${project}:o/${project}`;
      ids[`${project} red branch`] = await item(trx, {
        key: `default-branch:${repo}`,
        kind: 'board_observation',
        source: repo,
      });
      const tracker = `github-issues:${project}:o/${project}`;
      ids[`${project} blind tracker`] = await item(trx, {
        key: `source:${tracker}`,
        kind: 'board_observation',
        source: tracker,
      });
    }
    ids.board = await item(trx, { key: 'token:8', kind: 'token_request' });
    ids['blind spur'] = await item(trx, {
      key: 'source:spur',
      kind: 'board_observation',
      source: 'spur',
    });
    ids['gone red branch'] = await item(trx, {
      key: 'default-branch:github:gone:o/gone',
      kind: 'board_observation',
      source: 'github:gone:o/gone',
    });
    const gone = await task(trx, { project: 'gone', key: 'o/gone#1' });
    ids['gone delivery'] = await failedPost(trx, {
      kind: 'conversation.open',
      payload: { taskId: gone },
    });
    ids['gone task'] = await item(trx, {
      key: 'inbound:gone',
      kind: 'inbound_failure',
      taskId: gone,
    });
    return ids;
  });
}

const kinds = [
  'ask post',
  'answer',
  'author away',
  'reply failed',
  'task',
  'red branch',
  'blind tracker',
];
const firstOnes = kinds.map((kind) => `first ${kind}`);
const secondOnes = kinds.map((kind) => `second ${kind}`);
const boardOnes = ['board', 'blind spur', 'gone red branch', 'gone delivery', 'gone task'];

describe("an operator item's project", () => {
  it.each([
    ['no board-wide operator', 'operator', ownOnly, [...firstOnes, ...secondOnes, ...boardOnes]],
    ['no board-wide operator', 'agent:first-ops/s1', ownOnly, firstOnes],
    ['a board-wide operator', 'operator', mixed, [...firstOnes, ...secondOnes, ...boardOnes]],
    ['a board-wide operator', 'agent:first-ops/s1', mixed, firstOnes],
    ['a board-wide operator', 'agent:hq/s1', mixed, [...secondOnes, ...boardOnes]],
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
