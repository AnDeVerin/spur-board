import { scanTransaction } from './secrets.ts';
import { createHash } from 'node:crypto';
import {
  RESERVED_PROJECT,
  TOKEN_REQUEST_LIMITS,
  requestHashOf,
  tokenRequestSchema,
  type Action,
  type Config,
  type EventKind,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { OperatorTokenStatus, Row, Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { emit } from './board-utils.ts';
import { CommandError, type Mutation } from './commands.ts';
import { capPoints, clearItem, raiseItem } from './feed.ts';
import { enqueueBoardFeedLine, enqueueTokenCard, tokenCardKey } from './outbox.ts';
import type { Query } from './queries.ts';

type Trx = Kysely<Tables>;
const REQUEST_LIFETIME_MS = 15 * 60 * 1000;
const MAX_PENDING_REQUESTS = 10;
/** Days an expired or denied request stays after its decision before the daily purge drops it. */
const TOKEN_REQUEST_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
/** Code-point caps that keep a legacy name or folder from overflowing a card, line or button. */
const CARD_NAME = 200;
const CARD_FOLDER = 500;
const LIST_NAME = 64;
const LIST_FOLDER = 120;
const LABEL_NAME = 40;
/** Tokens in one token-list feed line that get a Revoke button. */
const LIST_BUTTONS = 20;
/** An approved token's last use is written at most once per token per this interval. */
const TOKEN_USE_INTERVAL_MS = 5 * 60_000;
/** The longest attention line; the doctor fix limit is the same. */
const ATTENTION_LINE_MAX = 300;

/** The Revoke button of the token approved through item `itemId`, on its card or in a list. */
function revokeAction(itemId: number, name: string, label: string): Action {
  return {
    id: `token:${String(itemId)}:revoke`,
    label,
    confirm: `Revoke operator token ${capPoints(name, CARD_NAME)}? Calls with it fail at once.`,
  };
}

/** The card of token `row` approved at `approvedAt`, its name and folder capped. */
function cardOf(row: Row<'operator_token'>, approvedAt: string) {
  return {
    name: capPoints(row.name, CARD_NAME),
    folder: capPoints(row.folder, CARD_FOLDER),
    createdAt: row.requested_at,
    approvedAt,
  };
}

export function effectiveStatus(row: Row<'operator_token'>, at: Date): OperatorTokenStatus {
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
  await emit(
    trx,
    kind,
    RESERVED_PROJECT,
    null,
    at.toISOString(),
    { name },
    kind === 'token_approved' || kind === 'token_denied' || kind === 'token_revoked'
      ? 'operator'
      : 'system',
  );
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

/** Fixed per-field text: the hint never echoes the value or an unknown key. */
const REQUEST_FIELD_HINTS: Record<string, string> = {
  name: `Fix \`name\`: use 1-${String(TOKEN_REQUEST_LIMITS.name)} characters, each a letter, digit, ".", "_" or "-".`,
  folder: `Fix \`folder\`: use 1-${String(TOKEN_REQUEST_LIMITS.folder)} characters, not only spaces, with no control or format characters.`,
  host: `Fix \`host\`: use 1-${String(TOKEN_REQUEST_LIMITS.host)} characters with no control or format characters.`,
  hash: 'Fix `hash`: send the 64-character lowercase hex SHA-256 of the token.',
};

/** Register a hash and its approval item together. The raw file secret never reaches this app. */
export async function requestToken(
  store: Store,
  config: Config,
  body: unknown,
  at: Date,
): Promise<{ name: string; status: 'pending'; expiresAt: string }> {
  const parsed = tokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new CommandError(
      'usage',
      (typeof field === 'string' ? REQUEST_FIELD_HINTS[field] : undefined) ??
        'Send a JSON object with only name, folder, host and hash.',
    );
  }
  const input = parsed.data;
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
      text: `Approve operator token ${input.name} (request ${requestHashOf(input.hash)}) for ${input.folder} on ${input.host}, requested ${at.toISOString()}?`,
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
    .set({
      status: next,
      decided_at: at.toISOString(),
      ...(next === 'approved' ? { approved_at: at.toISOString() } : {}),
    })
    .where('id', '=', row.id)
    .execute();
  await journalToken(trx, decision === 'approve' ? 'token_approved' : 'token_denied', row.name, at);
  // Only the operator can decide a token request; an approval turns the line into a card.
  await clearItem(
    trx,
    row.item_id,
    at,
    'operator',
    decision === 'approve'
      ? (item, lineId) =>
          enqueueTokenCard(trx, {
            itemId: item.id,
            parent: lineId,
            card: cardOf(row, at.toISOString()),
            actions: [revokeAction(item.id, row.name, 'Revoke')],
            at,
          })
      : undefined,
  );
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

/**
 * Deletes expired and denied requests decided more than the retention period before `at`; a row
 * exactly at the cutoff stays. Approved, revoked and pending rows and every approval item stay.
 */
export async function purgeEndedTokenRequests(store: Store, at: Date): Promise<number> {
  const cutoff = new Date(at.getTime() - TOKEN_REQUEST_RETENTION_DAYS * DAY_MS).toISOString();
  return store.transaction(async (trx) => {
    const deleted = await trx
      .deleteFrom('operator_token')
      .where('status', 'in', ['expired', 'denied'])
      .where('decided_at', '<', cutoff)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  });
}

/**
 * Hash lookup uses the unique index and checks durable state on every call. An approved token's
 * use at `at` is recorded when its last recorded use is older than `TOKEN_USE_INTERVAL_MS`; a
 * failed write goes to `onUseError` and never changes the result.
 */
export async function verifyOperatorToken(
  store: Store,
  token: string,
  at: Date,
  onUseError: (err: unknown) => void,
): Promise<{ name: string } | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const row = await store.db
    .selectFrom('operator_token')
    .select(['name', 'status', 'last_used_at'])
    .where('hash', '=', hash)
    .executeTakeFirst();
  if (row?.status !== 'approved') return null;
  const usedAt = at.toISOString();
  const staleBy = new Date(at.getTime() - TOKEN_USE_INTERVAL_MS).toISOString();
  if (row.last_used_at === null || row.last_used_at <= staleBy) {
    try {
      // The guard repeats the staleness test under the write lock, so concurrent calls write once.
      await store.transaction((trx) =>
        trx
          .updateTable('operator_token')
          .set({ last_used_at: usedAt })
          .where('hash', '=', hash)
          .where('status', '=', 'approved')
          .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<=', staleBy)]))
          .execute(),
      );
    } catch (err) {
      onUseError(err);
    }
  }
  return { name: row.name };
}

/** Read-only: an expired pending row is reported as expired but left for the sweep. */
export async function tokenStatusByHash(
  store: Store,
  hash: string,
  at: Date,
): Promise<OperatorTokenStatus | 'unknown'> {
  const row = await store.db
    .selectFrom('operator_token')
    .selectAll()
    .where('hash', '=', hash)
    .executeTakeFirst();
  return row === undefined ? 'unknown' : effectiveStatus(row, at);
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
          createdAt: row.requested_at,
          approvedAt: row.approved_at,
          lastUsedAt: row.last_used_at,
        })),
      };
    },
  };
}

/**
 * Posts one feed line listing the approved and unexpired pending tokens under `key`, so a replay
 * of the same command posts none; the first ones get a Revoke button. Returns how many are
 * listed and writes nothing for none.
 */
export async function postTokenList(trx: Trx, input: { key: string; at: Date }): Promise<number> {
  const rows = (await trx.selectFrom('operator_token').selectAll().orderBy('id').execute())
    .map((row) => ({ row, status: effectiveStatus(row, input.at) }))
    .filter(({ status }) => status === 'approved' || status === 'pending');
  if (rows.length === 0) return 0;
  const lines = rows.map(
    ({ row, status }) =>
      `${capPoints(row.name, LIST_NAME)} (${status}), ${capPoints(row.folder, LIST_FOLDER)}`,
  );
  const hidden = rows.length - LIST_BUTTONS;
  if (hidden > 0) lines.push(`${String(hidden)} more: \`board token list\``);
  await enqueueBoardFeedLine(trx, {
    dedupeKey: `feed.line:token-list:${input.key}`,
    itemKey: `token-list:${input.key}`,
    text: lines.join('\n'),
    title: 'Operator tokens',
    actions: rows
      .slice(0, LIST_BUTTONS)
      .map(({ row }) =>
        revokeAction(row.item_id, row.name, `Revoke ${capPoints(row.name, LABEL_NAME)}`),
      ),
    at: input.at,
  });
  return rows.length;
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
      const text = `token ${capPoints(row.name, CARD_NAME)} revoked`;
      await enqueueBoardFeedLine(trx, {
        dedupeKey: `feed.line:token-revoked:${String(row.id)}`,
        itemKey: `token-revoked:${String(row.id)}`,
        text,
        title: text,
        at,
      });
      const card =
        row.status === 'approved'
          ? await trx
              .selectFrom('outbox')
              .select(['id', 'state'])
              .where('dedupe_key', '=', tokenCardKey(row.item_id))
              .executeTakeFirst()
          : undefined;
      // A dead card edit was never shown: the revoked card would die with it.
      if (card !== undefined && card.state !== 'dead' && row.decided_at !== null) {
        await enqueueTokenCard(trx, {
          itemId: row.item_id,
          parent: card.id,
          card: { ...cardOf(row, row.decided_at), revoked: { by: ctx.actor, at: ctx.at } },
          at,
        });
      }
    }
    return { name: row.name, status: 'revoked' };
  },
};

/** Approved tokens that need the operator's attention, by token name in creation order. */
export interface TokenAttention {
  /** On this host, the token's folder no longer holds its token file. */
  fileMissing: string[];
  /** Not used for `unusedAfterDays` days; a token in `fileMissing` is not repeated here. */
  unused: string[];
}

/**
 * Approved tokens unused for `unusedAfterDays` days (last use, else approval, else request time)
 * or whose token file is gone. `probe` answers whether the token file is present, or null when
 * it cannot tell (another host, an unreadable folder); it runs after the read, outside any
 * transaction.
 */
export async function tokenAttention(
  store: Store,
  at: Date,
  unusedAfterDays: number,
  probe: (token: { folder: string; host: string }) => Promise<boolean | null>,
): Promise<TokenAttention> {
  const rows = await store.db
    .selectFrom('operator_token')
    .select(['name', 'folder', 'host', 'requested_at', 'approved_at', 'last_used_at'])
    .where('status', '=', 'approved')
    .orderBy('id')
    .execute();
  const cutoff = new Date(at.getTime() - unusedAfterDays * DAY_MS).toISOString();
  const attention: TokenAttention = { fileMissing: [], unused: [] };
  for (const row of rows) {
    if ((await probe({ folder: row.folder, host: row.host })) === false) {
      attention.fileMissing.push(row.name);
    } else if ((row.last_used_at ?? row.approved_at ?? row.requested_at) <= cutoff) {
      attention.unused.push(row.name);
    }
  }
  return attention;
}

/**
 * One line naming the tokens in `attention`, at most 300 characters, or null when none needs
 * attention. Shared by `board doctor` and the daily digest. A name enrollment would refuse today
 * is counted, never printed; trailing names that do not fit become "and N more".
 */
export function tokenAttentionLine(
  attention: TokenAttention,
  unusedAfterDays: number,
): string | null {
  const total = attention.fileMissing.length + attention.unused.length;
  if (total === 0) return null;
  const head = `${String(total)} operator ${total === 1 ? 'token needs' : 'tokens need'} attention (revoke any that nothing uses with \`board token revoke <name>\`)`;
  const printableNames = (names: string[]) =>
    names.filter((name) => tokenRequestSchema.shape.name.safeParse(name).success);
  const printable = [
    { label: 'no token file', names: printableNames(attention.fileMissing) },
    {
      label: `unused for ${String(unusedAfterDays)}+ days`,
      names: printableNames(attention.unused),
    },
  ];
  const named = printable.reduce((n, group) => n + group.names.length, 0);
  for (let shown = named; shown > 0; shown -= 1) {
    let left = shown;
    const parts: string[] = [];
    for (const { label, names } of printable) {
      const listed = names.slice(0, left);
      left -= listed.length;
      if (listed.length > 0) parts.push(`${label}: ${listed.join(', ')}`);
    }
    const more = total - shown;
    const line = `${head}: ${parts.join('; ')}${more > 0 ? ` and ${String(more)} more` : ''}`;
    if (line.length <= ATTENTION_LINE_MAX) return line;
  }
  return `${head}: ${String(total)} not named`;
}
