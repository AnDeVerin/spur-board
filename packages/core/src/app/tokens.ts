import { createHash } from 'node:crypto';
import { EVENT_VERSION, eventPayloadSchemas, type EventKind } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { toJson } from '../store/json.ts';
import type { OperatorTokenStatus, Row, Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { CommandError, type Mutation } from './commands.ts';
import { clearItem, raiseItem } from './feed.ts';
import type { Query } from './queries.ts';

type Trx = Kysely<Tables>;
const REQUEST_LIFETIME_MS = 15 * 60 * 1000;

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
      project: 'board',
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

export interface TokenRequest {
  name: string;
  folder: string;
  host: string;
  hash: string;
}

/** Register a hash and its approval item together. The raw file secret never reaches this app. */
export async function requestToken(
  store: Store,
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
  return store.transaction(async (trx) => {
    const existing = await trx
      .selectFrom('operator_token')
      .select('id')
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (existing !== undefined) throw new CommandError('usage', 'Choose a new token name.');
    const item = await raiseItem(trx, {
      itemKey: `token:${input.name}`,
      kind: 'token_request',
      text: `Approve operator token ${input.name} for ${input.folder} on ${input.host}, requested ${at.toISOString()}?`,
      url: '',
      taskId: null,
      blockId: null,
      at,
    });
    await trx
      .insertInto('operator_token')
      .values({
        name: input.name,
        hash: input.hash,
        folder: input.folder,
        host: input.host,
        status: 'pending',
        requested_at: at.toISOString(),
        expires_at: expiresAt,
        decided_at: null,
        item_id: item.id,
      })
      .execute();
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
    if (status === 'expired' && row.status === 'pending') {
      await trx
        .updateTable('operator_token')
        .set({ status: 'expired', decided_at: at.toISOString() })
        .where('id', '=', row.id)
        .execute();
      await journalToken(trx, 'token_expired', row.name, at);
      await clearItem(trx, row.item_id, at);
    }
    return { name: row.name, status };
  }
  const next = decision === 'approve' ? 'approved' : 'denied';
  await trx
    .updateTable('operator_token')
    .set({ status: next, decided_at: at.toISOString() })
    .where('id', '=', row.id)
    .execute();
  await journalToken(trx, decision === 'approve' ? 'token_approved' : 'token_denied', row.name, at);
  await clearItem(trx, row.item_id, at);
  return { name: row.name, status: next };
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
      await clearItem(trx, row.item_id, at);
    }
    return { name: row.name, status: 'revoked' };
  },
};
