import { ITEM_KINDS } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import { ago, block, clock, HOUR, item, mixed, task } from '../support/operator-inbox.ts';
import { openTempStore } from '../support/store.ts';

const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup() {
  const { store } = openTempStore('board-operator-inbox-actions-');
  stores.push(store);
  const registry = createOperationRegistry({ config: mixed, clock, completeSince: new Map() });
  const query = createQuery({ store, config: mixed, clock });
  const inbox = () => query(registry['inbox.operator'], {}, 'operator');
  return { store, inbox };
}

describe('inbox.operator actions', () => {
  it('gives every item kind an action', async () => {
    const { store, inbox } = setup();
    const kinds = ITEM_KINDS.filter((kind) => kind !== 'turn');
    const blockKinds = new Set(['anomaly', 'course_check', 'cycle_limit', 'conversation_waiting']);
    const cleared = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      for (const kind of kinds) {
        const blockId = blockKinds.has(kind)
          ? await block(trx, { taskId: first, addressee: 'worker' })
          : null;
        await item(trx, {
          key:
            kind === 'board_observation'
              ? `filter:${String(first)}`
              : kind === 'transport_health'
                ? 'transport:slack'
                : `${kind}:1`,
          kind,
          taskId: first,
          blockId,
        });
      }
      return item(trx, {
        key: `pr-outcome:${String(first)}:o/first#3`,
        kind: 'board_observation',
        taskId: first,
        clearedAt: ago(HOUR),
      });
    });

    const { items, handled } = await inbox();

    expect(items.map((entry) => entry.kind).sort()).toEqual([...kinds].sort());
    expect(handled.map((entry) => entry.id)).toEqual([cleared]);
    for (const entry of [...items, ...handled]) {
      expect(entry.action?.length, entry.kind).toBeGreaterThan(0);
      expect(entry.text.endsWith(`: ${entry.action ?? ''}`), entry.kind).toBe(true);
    }
  });

  it('names the block, session and project an item is about', async () => {
    const { store, inbox } = setup();
    const expected = await store.transaction(async (trx) => {
      const first = await task(trx, { project: 'first', key: 'o/first#1' });
      const conversation = await block(trx, {
        taskId: first,
        addressee: 'worker',
        author: 'operator',
        addresseeSpurProject: 'spur-x',
      });
      const workerBlock = await block(trx, { taskId: first, addressee: 'worker' });
      const ledger = await block(trx, { taskId: first, author: 'system', addressee: 'worker' });
      const raise = (key: string, kind: string, blockId: number | null = null) =>
        item(trx, { key, kind, taskId: first, text: `${kind} text`, blockId });
      const health = `health:${String(first)}:s9`;
      const rows: [string, string][] = [
        [
          await raise(`conversation:${String(conversation)}`, 'conversation_waiting'),
          `start a session in spur-x, or withdraw B${String(conversation)}`,
        ],
        [await raise(`${health}:worker_idle`, 'board_observation'), 'check session s9 in Spur'],
        [
          await raise(`${health}:worker_vanished`, 'board_observation'),
          'start a new worker for the task, or archive the task',
        ],
        [
          await raise(`block:${String(workerBlock)}`, 'board_observation'),
          `answer B${String(workerBlock)} if it is a question, or close it with a reason`,
        ],
        [
          await raise(`pr-outcome:${String(first)}:o/first#3`, 'board_observation'),
          'check the pull request, then close the item or archive the task',
        ],
        [
          await raise(`lookup:${String(first)}`, 'board_observation'),
          'check the ticket in the tracker, then close the item or archive the task',
        ],
        [
          await raise(`filter:${String(first)}`, 'board_observation'),
          'return the ticket to the tracker filter, or finish or unlink the linked work',
        ],
        [await raise('misc:1', 'board_observation'), 'check the task, then close the item'],
        [
          await raise('answer_author_unavailable:2', 'answer_author_unavailable'),
          'comment on the task so a live session reads the answer, then close the item',
        ],
        [
          await raise(`${health}:worker_killed`, 'worker_ended'),
          'start a new worker for the task, or archive the task',
        ],
        [
          await raise(`anomaly:${String(first)}`, 'anomaly', ledger),
          `wait for the answer to B${String(ledger)}, or answer it yourself`,
        ],
        [
          await raise(`course:${String(first)}`, 'course_check', ledger),
          `wait for the answer to B${String(ledger)}, or answer it yourself`,
        ],
        [
          await raise(`cycle:${String(first)}`, 'cycle_limit', ledger),
          `answer or close B${String(ledger)} to reset the cycle count`,
        ],
      ];
      return rows;
    });

    const { items } = await inbox();

    const byId = new Map(items.map((entry) => [entry.id, entry]));
    for (const [id, action] of expected) {
      const entry = byId.get(id);
      expect(entry, action).toMatchObject({ action, text: `${entry?.kind ?? ''} text: ${action}` });
    }
  });
});
