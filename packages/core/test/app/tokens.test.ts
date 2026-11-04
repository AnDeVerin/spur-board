import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../src/index.ts';
import {
  decideTokenInTransaction,
  requestToken,
  tokenListQuery,
  tokenRevokeMutation,
  verifyOperatorToken,
} from '../../src/app/tokens.ts';

const AT = new Date('2026-11-04T10:00:00.000Z');
const SECRET = 'example-private-token-value';
const HASH = createHash('sha256').update(SECRET).digest('hex');
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function setup(): Store {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-token-')), 'board.db'));
  stores.push(store);
  return store;
}

function enroll(store: Store, name = 'desk') {
  return requestToken(store, { name, folder: 'workspace/desk', host: 'local', hash: HASH }, AT);
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
      await store.transaction((trx) => decideTokenInTransaction(trx, row.item_id, 'approve', AT)),
    ).toEqual({ name: 'desk', status: 'approved' });
    expect(await verifyOperatorToken(store, SECRET)).toEqual({ name: 'desk' });
    expect(
      await store.transaction((trx) =>
        tokenRevokeMutation.run(trx, { name: 'desk' }, { actor: 'operator', at: AT.toISOString() }),
      ),
    ).toEqual({ name: 'desk', status: 'revoked' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    expect(
      await store.transaction((trx) =>
        tokenListQuery({ now: () => AT.getTime() }).run(trx, {}, 'operator'),
      ),
    ).toEqual({ tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'revoked' }] });
  });

  it('denies a request and never accepts a duplicate name', async () => {
    const store = setup();
    await enroll(store);
    await expect(enroll(store)).rejects.toMatchObject({ code: 'usage' });
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    expect(
      await store.transaction((trx) => decideTokenInTransaction(trx, row.item_id, 'deny', AT)),
    ).toEqual({ name: 'desk', status: 'denied' });
    expect(await verifyOperatorToken(store, SECRET)).toBeNull();
    expect(
      await store.transaction((trx) => decideTokenInTransaction(trx, row.item_id, 'deny', AT)),
    ).toEqual({ name: 'desk', status: 'denied' });
    expect(
      await store.db
        .selectFrom('event')
        .select('kind')
        .where('kind', '=', 'token_denied')
        .execute(),
    ).toHaveLength(1);
  });

  it('treats an unapproved request as expired at the fifteen-minute boundary', async () => {
    const store = setup();
    await enroll(store);
    const late = new Date(AT.getTime() + 15 * 60 * 1000);
    expect(
      await store.transaction((trx) =>
        tokenListQuery({ now: () => late.getTime() }).run(trx, {}, 'operator'),
      ),
    ).toEqual({ tokens: [{ name: 'desk', folder: 'workspace/desk', status: 'expired' }] });
    const row = await store.db
      .selectFrom('operator_token')
      .select('item_id')
      .executeTakeFirstOrThrow();
    expect(
      await store.transaction((trx) => decideTokenInTransaction(trx, row.item_id, 'approve', late)),
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

  it('bounds live pending requests without writing an extra approval item', async () => {
    const store = setup();
    for (let index = 0; index < 10; index += 1) {
      await requestToken(
        store,
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
    await expect(requestToken(store, blocked, AT)).rejects.toMatchObject({ code: 'usage' });
    expect(await store.db.selectFrom('operator_token').select('id').execute()).toHaveLength(10);
    expect(await store.db.selectFrom('outbox').select('id').execute()).toHaveLength(10);

    const afterExpiry = new Date(AT.getTime() + 15 * 60 * 1000);
    await expect(requestToken(store, blocked, afterExpiry)).resolves.toMatchObject({
      name: 'desk-blocked',
      status: 'pending',
    });
  });
});
