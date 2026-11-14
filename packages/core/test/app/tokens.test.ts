import { scanTransaction } from '../../src/app/secrets.ts';
import { RESERVED_PROJECT } from '@spur-board/contracts';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, openStore, type Store } from '../../src/index.ts';
import { capPoints, raiseItem } from '../../src/app/feed.ts';
import {
  decideTokenInTransaction,
  expirePendingTokens,
  postTokenList,
  purgeEndedTokenRequests,
  requestToken,
  tokenListQuery,
  tokenStatusByHash,
  tokenRevokeMutation,
  verifyOperatorToken,
} from '../../src/app/tokens.ts';
import { observeGateway } from '../support/observe.ts';
import { testConfig } from '../support/config.ts';

const AT = new Date('2026-11-04T10:00:00.000Z');
const SECRET = 'example-private-token-value';
const HASH = createHash('sha256').update(SECRET).digest('hex');
const SECRET2 = 'example-second-token-value';
const HASH2 = createHash('sha256').update(SECRET2).digest('hex');
const TAKEN = 'Token name desk is taken; choose another name (see `board token list`).';
const DAY_MS = 86_400_000;
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup(): Store {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db'));
  stores.push(store);
  return store;
}

function enroll(store: Store, name = 'desk', hash = HASH, at = AT) {
  return requestToken(
    store,
    testConfig,
    { name, folder: 'workspace/desk', host: 'local', hash },
    at,
  );
}

async function editPayload(store: Store, dedupeKey: string): Promise<unknown> {
  const row = await store.db
    .selectFrom('outbox')
    .select('payload')
    .where('dedupe_key', '=', dedupeKey)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.payload);
}

describe('operator token lifecycle', () => {
  it('stores only a hash, stays pending until approval, then revokes immediately', async () => {
    const store = setup();
    expect(await enroll(store)).toEqual({
      name: 'desk',
      status: 'pending',
      expiresAt: '2026-11-04T10:15:00.000Z',
    });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    const row = await store.db.selectFrom('operator_token').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ name: 'desk', hash: HASH, status: 'pending' });
    const persisted = JSON.stringify([
      row,
      await store.db.selectFrom('event').selectAll().execute(),
      await store.db.selectFrom('outbox').selectAll().execute(),
    ]);
    expect(persisted).not.toContain(SECRET);
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'approve', AT),
      ),
    ).toEqual({ name: 'desk', status: 'approved' });
    expect(await verifyOperatorToken(store, SECRET)).toEqual({ name: 'desk' });
    const card = await editPayload(store, `feed.line.edit:token-card:${String(row.item_id)}`);
    expect(card).toMatchObject({
      tokenCard: {
        name: 'desk',
        folder: 'workspace/desk',
        createdAt: AT.toISOString(),
        approvedAt: AT.toISOString(),
      },
      actions: [{ id: `token:${String(row.item_id)}:revoke`, label: 'Revoke' }],
    });
    expect(card).not.toHaveProperty('url');
    expect(card).not.toHaveProperty('resolved');
    expect(
      await store.db
        .selectFrom('event')
        .select('actor')
        .where('kind', '=', 'from_you_cleared')
        .executeTakeFirstOrThrow(),
    ).toEqual({ actor: 'operator' });
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        tokenRevokeMutation.run(trx, { name: 'desk' }, { actor: 'operator', at: AT.toISOString() }),
      ),
    ).toEqual({ name: 'desk', status: 'revoked' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    await expect(enroll(store, 'desk', HASH2)).rejects.toMatchObject({
      code: 'usage',
      hint: TAKEN,
    });
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        tokenListQuery({ now: () => AT.getTime() }).run(trx, {}, 'operator'),
      ),
    ).toEqual({ tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'revoked' }] });
    expect(
      await store.db.selectFrom('event').select(['kind', 'project']).orderBy('id').execute(),
    ).toEqual([
      { kind: 'from_you_raised', project: RESERVED_PROJECT },
      { kind: 'token_requested', project: RESERVED_PROJECT },
      { kind: 'token_approved', project: RESERVED_PROJECT },
      { kind: 'from_you_cleared', project: RESERVED_PROJECT },
      { kind: 'token_revoked', project: RESERVED_PROJECT },
    ]);
  });

  it('revokes an approved token whose legacy name is longer than enrollment now allows', async () => {
    const store = setup();
    await enroll(store);
    const row = await store.db.selectFrom('operator_token').selectAll().executeTakeFirstOrThrow();
    await scanTransaction(store, testConfig, (trx) =>
      decideTokenInTransaction(trx, row.item_id, 'approve', AT),
    );
    const legacy = `old desk ${'x'.repeat(300)}`;
    await store.db.updateTable('operator_token').set({ name: legacy }).execute();
    expect(await verifyOperatorToken(store, SECRET)).toEqual({ name: legacy });

    expect(
      await scanTransaction(store, testConfig, (trx) =>
        tokenRevokeMutation.run(trx, { name: legacy }, { actor: 'operator', at: AT.toISOString() }),
      ),
    ).toEqual({ name: legacy, status: 'revoked' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
  });

  it('refuses a live duplicate name, denies the request, then reuses the denied name', async () => {
    const store = setup();
    await enroll(store);
    await expect(enroll(store, 'desk', HASH2)).rejects.toMatchObject({
      code: 'usage',
      hint: TAKEN,
    });
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'deny', AT),
      ),
    ).toEqual({ name: 'desk', status: 'denied' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'deny', AT),
      ),
    ).toEqual({ name: 'desk', status: 'denied' });
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_denied')
        .execute(),
    ).toHaveLength(1);
    expect(await enroll(store, 'desk', HASH2)).toEqual({
      name: 'desk',
      status: 'pending',
      expiresAt: '2026-11-04T10:15:00.000Z',
    });
    await scanTransaction(store, testConfig, (trx) =>
      tokenRevokeMutation.run(trx, { name: 'desk' }, { actor: 'operator', at: AT.toISOString() }),
    );
    expect(await editPayload(store, 'feed.line.edit:token:desk:2')).toMatchObject({
      resolved: { by: 'operator' },
    });
  });

  it.each([
    { swept: true, title: 'swept' },
    { swept: false, title: 'not swept' },
  ])('reuses the name of a request that expired, $title', async ({ swept }) => {
    const store = setup();
    await enroll(store);
    const old = await store.db
      .selectFrom('operator_token')
      .select(['id', 'item_id'])
      .executeTakeFirstOrThrow();
    const late = new Date(AT.getTime() + 15 * 60 * 1000);
    if (swept) expect(await expirePendingTokens(store, testConfig, late)).toBe(1);
    expect(await enroll(store, 'desk', HASH2, late)).toEqual({
      name: 'desk',
      status: 'pending',
      expiresAt: '2026-11-04T10:30:00.000Z',
    });
    expect(await expirePendingTokens(store, testConfig, late)).toBe(0);
    const row = await store.db.selectFrom('operator_token').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ id: old.id, hash: HASH2, status: 'pending', decided_at: null });
    expect(row.item_id).not.toBe(old.item_id);
    await expect(
      scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, old.item_id, 'approve', late),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await store.db.selectFrom('operator_token').select('status').executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending' });
    expect(
      await store.db
        .selectFrom('operator_item')
        .select(['raise_no', 'cleared_at'])
        .where('item_key', '=', 'token:desk')
        .orderBy('raise_no')
        .execute(),
    ).toEqual([
      { raise_no: 1, cleared_at: late.toISOString() },
      { raise_no: 2, cleared_at: null },
    ]);
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'approve', late),
      ),
    ).toEqual({ name: 'desk', status: 'approved' });
    expect(await verifyOperatorToken(store, SECRET2)).toEqual({ name: 'desk' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_expired')
        .execute(),
    ).toHaveLength(1);
  });

  it('treats an unapproved request as expired at the fifteen-minute boundary', async () => {
    const store = setup();
    await enroll(store);
    const late = new Date(AT.getTime() + 15 * 60 * 1000);
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        tokenListQuery({ now: () => late.getTime() }).run(trx, {}, 'operator'),
      ),
    ).toEqual({ tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'expired' }] });
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    expect(
      await scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'approve', late),
      ),
    ).toEqual({ name: 'desk', status: 'expired' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_expired')
        .execute(),
    ).toHaveLength(1);
  });

  it('expires a request at send time instead of posting its approval after expiry', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db');
    const store = openStore(file);
    stores.push(store);
    await enroll(store);
    await scanTransaction(store, testConfig, (trx) =>
      raiseItem(trx, {
        itemKey: 'other',
        kind: 'worker_not_reading',
        text: 'Unrelated item',
        url: '',
        taskId: null,
        blockId: null,
        at: AT,
      }),
    );
    // No expiry sweep runs: the sender alone must keep the stale approval off the feed.
    const late = new Date(AT.getTime() + 15 * 60 * 1000);
    const observed = observeGateway(createFakeGateway({ profile: 'slack-like' }), file);
    const sender = createSender({
      config: testConfig,
      store,
      gateway: observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => late,
      spaceIntervalMs: 0,
    });
    for (let i = 0; i < 3; i++) await sender.tick();
    expect(observed.requests).toHaveLength(1);
    expect(JSON.stringify(observed.requests[0]?.body)).toContain('Unrelated item');
    expect(
      await store.db.selectFrom('operator_token').select(['status', 'decided_at']).execute(),
    ).toEqual([{ status: 'expired', decided_at: late.toISOString() }]);
    expect(
      await store.db
        .selectFrom('outbox')
        .select(['dedupe_key', 'state'])
        .where('dedupe_key', 'like', '%token:desk%')
        .orderBy('id')
        .execute(),
    ).toEqual([
      { dedupe_key: expect.stringContaining('token:desk') as unknown, state: 'dead' },
      { dedupe_key: 'feed.line.edit:token:desk:1', state: 'dead' },
    ]);
    expect(await expirePendingTokens(store, testConfig, late)).toBe(0);
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_expired')
        .execute(),
    ).toHaveLength(1);
  });

  it('expires a request at send time under a clock that moves on every read', async () => {
    // The expiry time lands in the edit payload, a gateway string: read inside the scan
    // transaction, it would change on every replay and abort the tick.
    const file = join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db');
    const store = openStore(file);
    stores.push(store);
    await enroll(store);
    await scanTransaction(store, testConfig, (trx) =>
      raiseItem(trx, {
        itemKey: 'other',
        kind: 'worker_not_reading',
        text: 'Unrelated item',
        url: '',
        taskId: null,
        blockId: null,
        at: AT,
      }),
    );
    let ms = AT.getTime() + 15 * 60 * 1000;
    const observed = observeGateway(createFakeGateway({ profile: 'slack-like' }), file);
    const sender = createSender({
      config: testConfig,
      store,
      gateway: observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => new Date((ms += 7)),
      spaceIntervalMs: 0,
    });
    for (let i = 0; i < 3; i++) await sender.tick();
    expect(observed.requests).toHaveLength(1);
    expect(JSON.stringify(observed.requests[0]?.body)).toContain('Unrelated item');
    expect(await store.db.selectFrom('operator_token').select('status').execute()).toEqual([
      { status: 'expired' },
    ]);
    expect(
      await store.db
        .selectFrom('outbox')
        .select('state')
        .where('dedupe_key', 'like', '%token:desk%')
        .execute(),
    ).toEqual([{ state: 'dead' }, { state: 'dead' }]);
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_expired')
        .execute(),
    ).toHaveLength(1);
  });

  it('expires a request that lapses while its send waits for the write lock', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db');
    const store = openStore(file);
    stores.push(store);
    await enroll(store);
    // The clock reads one ms before expiry until the send-start transaction holds the lock.
    const expiry = AT.getTime() + 15 * 60 * 1000;
    let transactions = 0;
    const transaction = store.transaction.bind(store);
    const counted: Store = {
      ...store,
      transaction: (fn) => {
        transactions += 1;
        return transaction(fn);
      },
    };
    const observed = observeGateway(createFakeGateway({ profile: 'slack-like' }), file);
    const sender = createSender({
      config: testConfig,
      store: counted,
      gateway: observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => new Date(transactions >= 2 ? expiry : expiry - 1),
      spaceIntervalMs: 0,
    });
    await sender.tick();
    expect(observed.requests).toHaveLength(0);
    expect(await store.db.selectFrom('operator_token').select('status').execute()).toEqual([
      { status: 'expired' },
    ]);
  });

  it('expires unreviewed requests and clears their approval items once', async () => {
    const store = setup();
    await enroll(store);
    const late = new Date(AT.getTime() + 15 * 60 * 1000);
    expect(await expirePendingTokens(store, testConfig, late)).toBe(1);
    expect(await expirePendingTokens(store, testConfig, late)).toBe(0);
    expect(
      await store.db
        .selectFrom('operator_token')
        .select(['status', 'decided_at'])
        .executeTakeFirst(),
    ).toEqual({ status: 'expired', decided_at: late.toISOString() });
    expect(
      await store.db.selectFrom('operator_item').select('cleared_at').executeTakeFirst(),
    ).toEqual({ cleared_at: late.toISOString() });
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_expired')
        .execute(),
    ).toHaveLength(1);
    expect(
      await store.db
        .selectFrom('outbox')
        .select('kind')
        .where('kind', '=', 'feed.line.edit')
        .execute(),
    ).toHaveLength(1);
  });

  it('bounds live pending requests without writing an extra approval item', async () => {
    const store = setup();
    for (let index = 0; index < 10; index += 1) {
      await requestToken(
        store,
        testConfig,
        {
          name: `desk-${String(index)}`,
          folder: 'workspace/desk',
          host: 'local',
          hash: createHash('sha256')
            .update(`secret-${String(index)}`)
            .digest('hex'),
        },
        AT,
      );
    }
    const blocked = {
      name: 'desk-blocked',
      folder: 'workspace/desk',
      host: 'local',
      hash: createHash('sha256').update('blocked').digest('hex'),
    };
    await expect(requestToken(store, testConfig, blocked, AT)).rejects.toMatchObject({
      code: 'usage',
    });
    expect(await store.db.selectFrom('operator_token').select('id').execute()).toHaveLength(10);
    expect(await store.db.selectFrom('outbox').select('id').execute()).toHaveLength(10);

    const afterExpiry = new Date(AT.getTime() + 15 * 60 * 1000);
    await expect(requestToken(store, testConfig, blocked, afterExpiry)).resolves.toMatchObject({
      name: 'desk-blocked',
      status: 'pending',
    });
  });
});

describe('token request input', () => {
  it('shows the short request hash in the approval prompt', async () => {
    const store = setup();
    await enroll(store);
    const item = await store.db
      .selectFrom('operator_item')
      .select('text')
      .executeTakeFirstOrThrow();
    expect(item.text).toBe(
      `Approve operator token desk (request ${HASH.slice(0, 10)}) for workspace/desk on local, requested ${AT.toISOString()}?`,
    );
  });

  it('refuses a folder of only spaces with usage', async () => {
    const store = setup();
    await expect(
      requestToken(
        store,
        testConfig,
        { name: 'desk', folder: '  ', host: 'local', hash: HASH },
        AT,
      ),
    ).rejects.toMatchObject({
      code: 'usage',
      hint: 'Fix `folder`: use 1-1024 characters, not only spaces, with no control or format characters.',
    });
    expect(await store.db.selectFrom('operator_token').select('id').execute()).toEqual([]);
  });
});

describe('purgeEndedTokenRequests', () => {
  const hashOf = (name: string) => createHash('sha256').update(name).digest('hex');
  async function decide(store: Store, name: string, decision: 'approve' | 'deny', at: Date) {
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    await scanTransaction(store, testConfig, (trx) =>
      decideTokenInTransaction(trx, row.item_id, decision, at),
    );
  }
  const names = async (store: Store) =>
    (await store.db.selectFrom('operator_token').select('name').orderBy('name').execute()).map(
      (row) => row.name,
    );

  it('deletes only expired and denied requests decided more than 7 days ago', async () => {
    const store = setup();
    const now = new Date(AT.getTime() + 30 * DAY_MS);
    const cutoff = new Date(now.getTime() - 7 * DAY_MS);
    const before = (ms: number) => new Date(cutoff.getTime() - ms);
    await enroll(store, 'approved', hashOf('approved'));
    await decide(store, 'approved', 'approve', AT);
    await enroll(store, 'revoked', hashOf('revoked'));
    await decide(store, 'revoked', 'approve', AT);
    await scanTransaction(store, testConfig, (trx) =>
      tokenRevokeMutation.run(
        trx,
        { name: 'revoked' },
        { actor: 'operator', at: AT.toISOString() },
      ),
    );
    await enroll(store, 'denied', hashOf('denied'), before(60_001));
    await decide(store, 'denied', 'deny', before(1));
    await enroll(store, 'expired', hashOf('expired'), before(15 * 60 * 1000));
    expect(await expirePendingTokens(store, testConfig, cutoff)).toBe(1);
    await enroll(store, 'pending', hashOf('pending'), now);
    const items = await store.db.selectFrom('operator_item').selectAll().orderBy('id').execute();

    expect(await purgeEndedTokenRequests(store, now)).toBe(1);

    expect(await names(store)).toEqual(['approved', 'expired', 'pending', 'revoked']);
    expect(await store.db.selectFrom('operator_item').selectAll().orderBy('id').execute()).toEqual(
      items,
    );
    expect(await tokenStatusByHash(store, hashOf('denied'), now)).toBe('unknown');
    expect(await tokenStatusByHash(store, hashOf('expired'), now)).toBe('expired');
    expect(await purgeEndedTokenRequests(store, now)).toBe(0);
  });

  it('answers a decision on a purged request with not_found and writes nothing', async () => {
    const store = setup();
    await enroll(store);
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    await decide(store, 'desk', 'deny', AT);
    const later = new Date(AT.getTime() + 7 * DAY_MS + 1);
    expect(await purgeEndedTokenRequests(store, later)).toBe(1);

    await expect(
      scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'approve', later),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await names(store)).toEqual([]);
    expect(
      (
        await store.db
          .selectFrom('event')
          .select('kind')
          .where('kind', 'like', 'token_%')
          .orderBy('id')
          .execute()
      ).map((event) => event.kind),
    ).toEqual(['token_requested', 'token_denied']);
  });
});

describe('token card', () => {
  async function delivered(name = 'desk') {
    const file = join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db');
    const store = openStore(file);
    stores.push(store);
    await enroll(store, name);
    const fake = createFakeGateway({ profile: 'slack-like' });
    const observed = observeGateway(fake, file);
    // The sender's clock follows the last revoke, so its edit is due.
    let sentAt = AT;
    const sender = createSender({
      config: testConfig,
      store,
      gateway: observed.gateway,
      spur: { send: () => Promise.resolve() },
      now: () => sentAt,
      spaceIntervalMs: 0,
    });
    const tick = async () => {
      for (let i = 0; i < 4; i++) await sender.tick();
    };
    await tick();
    const row = await store.db.selectFrom('operator_token').selectAll().executeTakeFirstOrThrow();
    const approve = () =>
      scanTransaction(store, testConfig, (trx) =>
        decideTokenInTransaction(trx, row.item_id, 'approve', AT),
      );
    const revoke = (at = REVOKED_AT) => {
      sentAt = at;
      return scanTransaction(store, testConfig, (trx) =>
        tokenRevokeMutation.run(
          trx,
          { name: row.name },
          { actor: 'operator', at: at.toISOString() },
        ),
      );
    };
    const message = () => {
      const [line] = fake.platform.messages();
      if (line === undefined) throw new Error('no line');
      return line;
    };
    const rows = (like: string) =>
      store.db
        .selectFrom('outbox')
        .selectAll()
        .where('dedupe_key', 'like', like)
        .orderBy('id')
        .execute();
    return { store, observed, tick, row, approve, revoke, message, rows };
  }

  const REVOKED_AT = new Date('2026-11-04T11:30:00.000Z');

  it('turns the approved line into a card with a confirmed Revoke', async () => {
    const { observed, tick, row, approve, message } = await delivered();
    expect(message().actions).toEqual([
      `token:${String(row.item_id)}:approve`,
      `token:${String(row.item_id)}:deny`,
      `item:${String(row.item_id)}:close`,
    ]);
    await approve();
    await tick();
    const request = observed.requests.at(-1);
    expect(request?.target.kind).toBe('edit');
    expect(request?.actions).toEqual([
      {
        id: `token:${String(row.item_id)}:revoke`,
        label: 'Revoke',
        confirm: 'Revoke operator token desk? Calls with it fail at once.',
      },
    ]);
    expect(message().actions).toEqual([`token:${String(row.item_id)}:revoke`]);
    expect(message().text).toBe(
      'Operator token desk\n\nFolder: workspace/desk\n\nCreated 2026-11-04 10:00 · Approved 2026-11-04 10:00',
    );
  });

  it('edits the card to revoked after a revoke', async () => {
    const { tick, row, approve, revoke, message, rows } = await delivered();
    await approve();
    await tick();
    await revoke();
    await tick();
    expect(message().text).toBe(
      'Operator token desk\n\nFolder: workspace/desk\n\nCreated 2026-11-04 10:00 · Approved 2026-11-04 10:00\n\nRevoked by @operator at 11:30',
    );
    expect(message().actions).toEqual([]);
    const [card, revoked] = await rows(`feed.line.edit:token-card:${String(row.item_id)}%`);
    expect(revoked).toMatchObject({
      dedupe_key: `feed.line.edit:token-card:${String(row.item_id)}:revoked`,
      parent_outbox_id: card?.id,
      state: 'done',
    });
    expect(JSON.parse(revoked?.payload ?? '{}')).not.toHaveProperty('actions');
  });

  it('posts one revoked line and one card edit from the CLI handler and adds nothing on a second revoke', async () => {
    const { store, tick, row, approve, revoke, rows } = await delivered();
    await approve();
    await tick();
    await revoke();
    const outbox = await store.db.selectFrom('outbox').select('id').execute();
    expect(await revoke(new Date(REVOKED_AT.getTime() + 60_000))).toEqual({
      name: 'desk',
      status: 'revoked',
    });
    expect(await store.db.selectFrom('outbox').select('id').execute()).toEqual(outbox);
    const lines = await rows('feed.line:token-revoked:%');
    expect(lines.map((line) => line.dedupe_key)).toEqual([
      `feed.line:token-revoked:${String(row.id)}`,
    ]);
    expect(JSON.parse(lines[0]?.payload ?? '{}')).toMatchObject({
      text: 'token desk revoked',
      title: 'token desk revoked',
    });
    expect(await rows(`feed.line.edit:token-card:${String(row.item_id)}:revoked`)).toHaveLength(1);
    expect(
      await store.db.selectFrom('event').select('id').where('kind', '=', 'token_revoked').execute(),
    ).toHaveLength(1);
  });

  it('posts the revoked line without a card edit for a token that has no card', async () => {
    const { store, row, approve, revoke, rows } = await delivered();
    await approve();
    // As for a token approved before cards existed.
    await store.db
      .deleteFrom('outbox')
      .where('dedupe_key', '=', `feed.line.edit:token-card:${String(row.item_id)}`)
      .execute();
    await revoke();
    expect(await rows('feed.line:token-revoked:%')).toHaveLength(1);
    expect(await rows('feed.line.edit:token-card:%')).toEqual([]);
  });

  it('posts the revoked line and the resolved edit when a pending request is revoked', async () => {
    const { store, row, revoke, rows } = await delivered();
    await revoke();
    expect(await store.db.selectFrom('operator_token').select('status').execute()).toEqual([
      { status: 'revoked' },
    ]);
    expect(await rows('feed.line:token-revoked:%')).toHaveLength(1);
    expect(await rows('feed.line.edit:token-card:%')).toEqual([]);
    expect(
      JSON.parse((await rows('feed.line.edit:token:desk:1'))[0]?.payload ?? '{}'),
    ).toMatchObject({ resolved: { by: 'operator' } });
    expect(row.status).toBe('pending');
  });

  it('caps a legacy name and folder in the card, the revoked line and the list', async () => {
    const { store, tick, approve, row, rows } = await delivered();
    const legacy = `old desk ${'x'.repeat(300)}`;
    await store.db
      .updateTable('operator_token')
      .set({ name: legacy, folder: 'f'.repeat(1024) })
      .execute();
    await approve();
    await scanTransaction(store, testConfig, (trx) =>
      postTokenList(trx, { key: 'legacy-list', at: AT }),
    );
    await scanTransaction(store, testConfig, (trx) =>
      tokenRevokeMutation.run(trx, { name: legacy }, { actor: 'operator', at: AT.toISOString() }),
    );
    await tick();
    const points = (text: unknown) => Array.from(String(text)).length;
    const card = JSON.parse(
      (await rows(`feed.line.edit:token-card:${String(row.item_id)}`))[0]?.payload ?? '{}',
    ) as {
      tokenCard: { name: string; folder: string };
      actions: { label: string; confirm: string }[];
    };
    expect(points(card.tokenCard.name)).toBe(200);
    expect(card.tokenCard.name.endsWith('…')).toBe(true);
    expect(points(card.tokenCard.folder)).toBe(500);
    expect(card.tokenCard.folder.endsWith('…')).toBe(true);
    expect(points(card.actions[0]?.confirm)).toBeLessThanOrEqual(300);
    const [line] = await rows('feed.line:token-revoked:%');
    expect(JSON.parse(line?.payload ?? '{}')).toMatchObject({
      text: `token ${capPoints(legacy, 200)} revoked`,
    });
    const list = JSON.parse((await rows('feed.line:token-list:%'))[0]?.payload ?? '{}') as {
      text: string;
      actions: { label: string; confirm: string }[];
    };
    expect(list.text).toBe(
      `${capPoints(legacy, 64)} (approved), ${capPoints('f'.repeat(1024), 120)}`,
    );
    expect(points(list.actions[0]?.label)).toBe(47);
    expect(list.actions[0]?.label.endsWith('…')).toBe(true);
    expect(list.actions[0]?.confirm).toBe(card.actions[0]?.confirm);
    const edits = await rows('feed.line.edit:token-card:%');
    expect(edits.map((edit) => edit.state)).toEqual(['done', 'done']);
    for (const outbox of await store.db.selectFrom('outbox').select('dedupe_key').execute()) {
      expect(outbox.dedupe_key.length).toBeLessThanOrEqual(255);
    }
  });
});
