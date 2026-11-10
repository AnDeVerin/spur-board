import { scanTransaction } from './secrets.ts';
import { createHash } from 'node:crypto';
import {
  EVENT_VERSION,
  RESERVED_PROJECT,
  eventPayloadSchemas,
  type Config,
  type EventKind,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { toJson } from '../store/json.ts';
import type { OperatorTokenStatus, Row, Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { CommandError, type Mutation } from './commands.ts';
import { clearItem, raiseItem } from './feed.ts';
import type { Query } from './queries.ts';

type Trx = Kysely<Tables>;
const REQUEST_LIFETIME_MS = 15 * 60 * 1000;
const MAX_PENDING_REQUESTS = 10;

function effectiveStatus(row: Row<'operator_token'>, at: Date): OperatorTokenStatus {
  return row.status === 'pending' && row.expires_at <= at.toISOString() ? 'expired' : row.status;
}

async function journalToken(
  trx: Trx,
  kind: Extract<
    EventKind,
    'token_requested' | 'token_approved' | 'token_denied' | 'token_expired' | 'token_revoked'
  >,
  name: string,
  at: Date,
): Promise<void> {
  await trx
    .insertInto('event')
    .values({
      at: at.toISOString(),
      project: RESERVED_PROJECT,
      task_id: null,
      kind,
      actor:
        kind === 'token_approved' || kind === 'token_denied' || kind === 'token_revoked'
          ? 'operator'
          : 'system',
      actor_ref: null,
      payload: toJson(eventPayloadSchemas[kind], { name }),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}

/** Lapse one pending request: journal it once and clear its approval item. */
async function expireToken(
  trx: Trx,
  row: { id: number; name: string; item_id: number },
  at: Date,
): Promise<void> {
  await trx
    .updateTable('operator_token')
    .set({ status: 'expired', decided_at: at.toISOString() })
    .where('id', '=', row.id)
    .execute();
  await journalToken(trx, 'token_expired', row.name, at);
  await clearItem(trx, row.item_id, at);
}

/**
 * Lapses the pending request whose approval item is `itemId` once it has expired at `at`. The
 * sender calls it before posting the approval line, so a late or failing sweep cannot post it.
 */
export async function expireTokenOfItem(trx: Trx, itemId: number, at: Date): Promise<void> {
  const row = await trx
    .selectFrom('operator_token')
    .select(['id', 'name', 'item_id'])
    .where('item_id', '=', itemId)
    .where('status', '=', 'pending')
    .where('expires_at', '<=', at.toISOString())
    .executeTakeFirst();
  if (row !== undefined) await expireToken(trx, row, at);
}

export interface TokenRequest {
  name: string;
  folder: string;
  host: string;
  hash: string;
}

/** Register a hash and its approval item together. The raw file secret never reaches this app. */
export async function requestToken(
  store: Store,
  config: Config,
  input: TokenRequest,
  at: Date,
): Promise<{ name: string; status: 'pending'; expiresAt: string }> {
  if (
    !/^[0-9a-f]{64}$/.test(input.hash) ||
    input.name.trim() === '' ||
    input.folder.trim() === ''
  ) {
    throw new CommandError('usage', 'Provide a name, folder and SHA-256 token hash.');
  }
  const expiresAt = new Date(at.getTime() + REQUEST_LIFETIME_MS).toISOString();
  return scanTransaction(store, config, async (trx) => {
    const existing = await trx
      .selectFrom('operator_token')
      .selectAll()
      .where('name', '=', input.name)
      .executeTakeFirst();
    // A request that ended without approval never held a credential, so its name is free again.
    const status = existing === undefined ? undefined : effectiveStatus(existing, at);
    if (status === 'pending' || status === 'approved' || status === 'revoked') {
      throw new CommandError(
        'usage',
        `Token name ${input.name} is taken; choose another name (see \`board token list\`).`,
      );
    }
    const pending = await trx
      .selectFrom('operator_token')
      .select('id')
      .where('status', '=', 'pending')
      .where('expires_at', '>', at.toISOString())
      .limit(MAX_PENDING_REQUESTS)
      .execute();
    if (pending.length >= MAX_PENDING_REQUESTS) {
      throw new CommandError('usage', 'Too many token requests are awaiting approval.');
    }
    // Lapse an unswept request first so its old approval button cannot approve the new hash.
    if (existing?.status === 'pending') await expireToken(trx, existing, at);
    const item = await raiseItem(trx, {
      itemKey: `token:${input.name}`,
      kind: 'token_request',
      text: `Approve operator token ${input.name} for ${input.folder} on ${input.host}, requested ${at.toISOString()}?`,
      url: '',
      taskId: null,
      blockId: null,
      at,
    });
    const values = {
      hash: input.hash,
      folder: input.folder,
      host: input.host,
      status: 'pending',
      requested_at: at.toISOString(),
      expires_at: expiresAt,
      decided_at: null,
      item_id: item.id,
    } as const;
    if (existing === undefined) {
      await trx
        .insertInto('operator_token')
        .values({ name: input.name, ...values })
        .execute();
    } else {
      await trx.updateTable('operator_token').set(values).where('id', '=', existing.id).execute();
    }
    await journalToken(trx, 'token_requested', input.name, at);
    return { name: input.name, status: 'pending', expiresAt };
  });
}

/** Called within the inbound event's transaction, after the gateway user and space are checked. */
export async function decideTokenInTransaction(
  trx: Trx,
  itemId: number,
  decision: 'approve' | 'deny',
  at: Date,
): Promise<{ name: string; status: OperatorTokenStatus }> {
  const row = await trx
    .selectFrom('operator_token')
    .selectAll()
    .where('item_id', '=', itemId)
    .executeTakeFirst();
  if (row === undefined) throw new CommandError('not_found', 'Token request was not found.');
  const status = effectiveStatus(row, at);
  if (status !== 'pending') {
    if (status === 'expired' && row.status === 'pending') await expireToken(trx, row, at);
    return { name: row.name, status };
  }
  const next = decision === 'approve' ? 'approved' : 'denied';
  await trx
    .updateTable('operator_token')
    .set({ status: next, decided_at: at.toISOString() })
    .where('id', '=', row.id)
    .execute();
  await journalToken(trx, decision === 'approve' ? 'token_approved' : 'token_denied', row.name, at);
  // Only the operator can decide a token request.
  await clearItem(trx, row.item_id, at, 'operator');
  return { name: row.name, status: next };
}

/** Clear unreviewed requests even when no approval button is pressed. */
export async function expirePendingTokens(store: Store, config: Config, at: Date): Promise<number> {
  const expiresAt = at.toISOString();
  const due = await store.db
    .selectFrom('operator_token')
    .select('id')
    .where('status', '=', 'pending')
    .where('expires_at', '<=', expiresAt)
    .executeTakeFirst();
  if (due === undefined) return 0;
  return scanTransaction(store, config, async (trx) => {
    const rows = await trx
      .selectFrom('operator_token')
      .select(['id', 'name', 'item_id'])
      .where('status', '=', 'pending')
      .where('expires_at', '<=', expiresAt)
      .execute();
    for (const row of rows) await expireToken(trx, row, at);
    return rows.length;
  });
}

/** Hash lookup uses the unique index and checks durable state on every call. */
export async function verifyOperatorToken(
  store: Store,
  token: string,
): Promise<{ name: string } | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const row = await store.db
    .selectFrom('operator_token')
    .select(['name', 'status'])
    .where('hash', '=', hash)
    .executeTakeFirst();
  return row?.status === 'approved' ? { name: row.name } : null;
}

export function tokenListQuery(clock: { now(): number }): Query<'token.list'> {
  return {
    id: 'token.list',
    resolveTargets: () => Promise.resolve([]),
    async run(trx) {
      const rows = await trx.selectFrom('operator_token').selectAll().orderBy('id').execute();
      const at = new Date(clock.now());
      return {
        tokens: rows.map((row) => ({
          name: row.name,
          folder: row.folder,
          status: effectiveStatus(row, at),
        })),
      };
    },
  };
}

export const tokenRevokeMutation: Mutation<'token.revoke'> = {
  id: 'token.revoke',
  resolveTargets: () => Promise.resolve([]),
  async run(trx, input, ctx) {
    const row = await trx
      .selectFrom('operator_token')
      .selectAll()
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (row === undefined) throw new CommandError('not_found', 'Token name was not found.');
    if (row.status !== 'revoked') {
      const at = new Date(ctx.at);
      await trx
        .updateTable('operator_token')
        .set({ status: 'revoked', decided_at: ctx.at })
        .where('id', '=', row.id)
        .execute();
      await journalToken(trx, 'token_revoked', row.name, at);
      await clearItem(trx, row.item_id, at, ctx.actor);
    }
    return { name: row.name, status: 'revoked' };
  },
};
