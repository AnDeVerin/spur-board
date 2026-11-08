import { scanTransaction } from '../../src/app/secrets.ts';
import { RESERVED_PROJECT } from '@spur-board/contracts';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../src/index.ts';
import {
  decideTokenInTransaction,
  expirePendingTokens,
  requestToken,
  tokenListQuery,
  tokenRevokeMutation,
  verifyOperatorToken,
} from '../../src/app/tokens.ts';
import { testConfig } from '../support/config.ts';

const AT = new Date('2026-11-04T10:00:00.000Z');
const SECRET = 'example-private-token-value';
const HASH = createHash('sha256').update(SECRET).digest('hex');
const SECRET2 = 'example-second-token-value';
const HASH2 = createHash('sha256').update(SECRET2).digest('hex');
const TAKEN = 'Token name desk is taken; choose another name (see `board token list`).';
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
