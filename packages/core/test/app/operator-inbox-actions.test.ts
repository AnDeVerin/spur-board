import { ITEM_KINDS } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationRegistry, createQuery, type Store } from '../../src/index.ts';
import {
  ago,
  block,
  clock,
  failedPost,
  HOUR,
  item,
  mixed,
  task,
} from '../support/operator-inbox.ts';
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
  it.each([null, ago(HOUR)])(
    'projects meaningful stored URLs, handled at %s',
    async (clearedAt) => {
      const { store, inbox } = setup();
      const url = 'https://github.com/o/first/actions/runs/42';
      await store.transaction((trx) =>
        item(trx, {
          key: 'default-branch:github:first:o/first',
          kind: 'board_observation',
          url,
          clearedAt,
        }),
      );
      const result = await inbox();
      expect(clearedAt === null ? result.items : result.handled).toMatchObject([{ url }]);
    },
  );

  it.each([
    '',
    'javascript:alert(1)',
    '/relative',
    'https://github.com',
    'HTTPS://GITHUB.COM:443/',
    'https://github.com/?q=help#top',
  ])('omits unusable stored URL %s and never parses text', async (url) => {
    const { store, inbox } = setup();
    await store.transaction((trx) =>
      item(trx, {
        key: 'misc:1',
        kind: 'board_observation',
        url,
        text: 'Open https://example.test/run',
      }),
    );
    expect((await inbox()).items[0]).not.toHaveProperty('url');
  });

  it.each([null, ago(HOUR)])('selects official source help, handled at %s', async (clearedAt) => {
    const { store, inbox } = setup();
    const targets = [
      [
        'github:first:o/first',
        'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api',
      ],
      [
        'github-issues:first:o/first',
        'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api',
      ],
      ['jira:first', 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro'],
      ['spur', undefined],
      ['unknown', undefined],
    ] as const;
    const ids = await store.transaction(async (trx) =>
      Promise.all(
        targets.map(([source]) =>
          item(trx, {
            key: `source:${source}`,
            kind: 'board_observation',
            url: 'https://github.com',
            clearedAt,
          }),
        ),
      ),
    );
    const result = await inbox();
    const entries = clearedAt === null ? result.items : result.handled;
    for (const [i, [, url]] of targets.entries()) {
      const entry = entries.find((entry) => entry.id === ids[i]);
      if (url === undefined) expect(entry).not.toHaveProperty('url');
      else expect(entry).toMatchObject({ url });
    }
  });

  it.each([null, ago(HOUR)])(
    'uses own then immediate parent delivery permalink, handled at %s',
    async (clearedAt) => {
      const { store, inbox } = setup();
      const own = 'https://chat.example.test/own';
      const parent = 'https://chat.example.test/parent';
      const ref = (permalink: string) =>
        JSON.stringify({ conversation: 'C1:1', message: '2', permalink });
      const ids = await store.transaction(async (trx) => {
        // Reuse an outbox fixture as the parent, retaining a structurally valid delivered reference.
        await failedPost(trx, {
          kind: 'feed.line',
          payload: {},
          externalRef: ref(parent),
          dedupeKey: 'parent',
        });
        const row = await trx
          .selectFrom('outbox')
          .select('id')
          .where('dedupe_key', '=', 'parent')
          .executeTakeFirstOrThrow();
        const inputs = [
          { externalRef: ref(own), parentId: row.id },
          { externalRef: ref('javascript:alert(1)'), parentId: row.id },
          { parentId: row.id },
          {},
          { externalRef: 'invalid-json' },
        ];
        return Promise.all(
          inputs.map((input, i) =>
            failedPost(trx, {
              kind: 'feed.line',
              payload: {},
              dedupeKey: `child:${String(i)}`,
              ...input,
              ...(clearedAt === null ? {} : { clearedAt }),
            }),
          ),
        );
      });
      const result = await inbox();
      const entries = clearedAt === null ? result.items : result.handled;
      for (const [i, url] of [own, parent, parent, undefined, undefined].entries()) {
        const entry = entries.find((entry) => entry.id === ids[i]);
        if (url === undefined) expect(entry).not.toHaveProperty('url');
        else expect(entry).toMatchObject({ url });
      }
    },
  );

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
          `start a session in spur-x, or close B${String(conversation)} with a reason`,
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
        [
          await raise('default-branch:github:first:o/first', 'board_observation'),
          'open the failing run; fix or revert',
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

  it('marks a default-branch item a failure under _board', async () => {
    const { store, inbox } = setup();
    const text = 'o/first: main is red since aaaaaaa (build): fix main before merging more';
    const id = await store.transaction((trx) =>
      item(trx, { key: 'default-branch:github:first:o/first', kind: 'board_observation', text }),
    );

    const { items } = await inbox();

    expect(items.find((entry) => entry.id === id)).toMatchObject({
      kind: 'board_observation',
      severity: 'failure',
      project: '_board',
      action: 'open the failing run; fix or revert',
      text: `${text}: open the failing run; fix or revert`,
    });
  });
});
