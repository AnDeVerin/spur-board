// Delivers outbox rows: claim in one transaction, IO outside any transaction, record the result
// in a second one. The daemon calls `recover()` once on start, then `tick()` on its schedule.
import {
  SPACE_IDS,
  type ConnectionState,
  type DeliverRequest,
  type DeliveryResult,
  type DeliveryTarget,
  type Gateway,
  type SpaceId,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { Store } from '../store/store.ts';
import type { Row, Tables } from '../store/schema.ts';
import {
  deliveredRefSchema,
  KIND_PRIORITY,
  KIND_SPACE,
  outboxBodySchema,
  renderBody,
  type DeliveredRef,
  type OutboxBody,
} from './outbox.ts';

/** Spur's side of a doorbell: `spur send <session> <text>`. */
export interface SpurPort {
  send(session: string, text: string): Promise<void>;
}

export interface SenderOptions {
  store: Store;
  gateway: Gateway;
  spur: SpurPort;
  now?: () => Date;
  /** Minimum time between two deliveries into one space. */
  spaceIntervalMs?: number;
}

export interface Sender {
  /** Returns `in_flight` rows as uncertain and `post_failed` rows to `pending`. Run once on start. */
  recover(): Promise<void>;
  /** Claims due rows, delivers them one by one and records each result. */
  tick(): Promise<void>;
  /** Feeds the gateway's connection events; down for over 5 min raises health for every space. */
  recordConnection(state: ConnectionState, at: Date): void;
}

/** 1 msg/s per space: a platform limit, not an operator setting. */
const SPACE_INTERVAL_MS = 1000;
const RETRY_WINDOW_MS = 30 * 60_000;
const DOWN_THRESHOLD_MS = 5 * 60_000;
export const HEALTH_PROBE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

type Trx = Kysely<Tables>;
type OutboxRow = Row<'outbox'>;

interface Claim {
  id: number;
  key: string;
  space: SpaceId | null;
  maybeSent: boolean;
  attempts: number;
  body: OutboxBody;
  /** The parent's refs, for a dependent row. */
  parent: DeliveredRef | null;
}

type Outcome = DeliveryResult | { status: 'sent' };

function parseBody(row: Pick<OutboxRow, 'kind' | 'payload'>): OutboxBody | string {
  try {
    const parsed = outboxBodySchema.safeParse({
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    });
    return parsed.success ? parsed.data : `invalid payload: ${parsed.error.message}`;
  } catch (error) {
    return `invalid payload: ${String(error)}`;
  }
}

function commentOf(body: OutboxBody): number | null {
  switch (body.kind) {
    case 'conversation.open':
    case 'conversation.reply':
    case 'conversation.close':
      return body.payload.commentId;
    default:
      return null;
  }
}

function backoff(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

function target(claim: Claim): DeliveryTarget | null {
  const { body, parent } = claim;
  switch (body.kind) {
    case 'conversation.open':
    case 'feed.line':
      return { kind: 'open', space: KIND_SPACE[body.kind], title: body.payload.title };
    case 'conversation.reply':
      return parent && { kind: 'reply', conversation: parent.conversation };
    case 'conversation.close':
      return parent && { kind: 'close', conversation: parent.conversation };
    case 'feed.line.edit':
      return parent && { kind: 'edit', message: parent.message };
    case 'doorbell':
      return null;
  }
}

export function createSender(options: SenderOptions): Sender {
  const { store, gateway, spur } = options;
  const now = options.now ?? (() => new Date());
  const spaceIntervalMs = options.spaceIntervalMs ?? SPACE_INTERVAL_MS;
  const nextSlotAt = new Map<SpaceId, number>();
  const lastProbeAt = new Map<SpaceId, number>();
  let downSince: number | undefined;

  async function setComment(
    trx: Trx,
    body: OutboxBody,
    patch: Partial<Pick<Row<'comment'>, 'delivery_state' | 'conversation_ref' | 'message_ref'>>,
  ): Promise<void> {
    const commentId = commentOf(body);
    if (commentId === null) return;
    await trx.updateTable('comment').set(patch).where('id', '=', commentId).execute();
  }

  /** Sets the comments of `rows` that carry one to `superseded`. */
  async function supersedeComments(
    trx: Trx,
    rows: readonly Pick<OutboxRow, 'kind' | 'payload'>[],
  ): Promise<void> {
    for (const row of rows) {
      const body = parseBody(row);
      if (typeof body !== 'string') await setComment(trx, body, { delivery_state: 'superseded' });
    }
  }

  async function kill(trx: Trx, ids: readonly number[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    const rows = await trx
      .updateTable('outbox')
      .set({ state: 'dead', last_error: reason })
      .where('id', 'in', ids)
      .returning(['kind', 'payload'])
      .execute();
    await supersedeComments(trx, rows);
  }

  /**
   * Kills every pending or post_failed row whose parent is dead, to a fixpoint. Seeded from all
   * dead rows, not only this tick's, so a row written under an already dead parent dies too.
   */
  async function cascade(trx: Trx): Promise<void> {
    for (;;) {
      const rows = await trx
        .updateTable('outbox')
        .set({ state: 'dead', last_error: 'superseded' })
        .where('state', 'in', ['pending', 'post_failed'])
        .where('parent_outbox_id', 'in', (eb) =>
          eb.selectFrom('outbox as parent').select('parent.id').where('parent.state', '=', 'dead'),
        )
        .returning(['kind', 'payload'])
        .execute();
      if (rows.length === 0) return;
      await supersedeComments(trx, rows);
    }
  }

  /** tx 1: cancels stale rows, raises down-health and claims at most one due row per lane. */
  async function claim(trx: Trx, at: number): Promise<Claim[]> {
    const nowIso = new Date(at).toISOString();
    const rows = await trx
      .selectFrom('outbox')
      .selectAll()
      .where('state', 'in', ['pending', 'post_failed'])
      .orderBy('id')
      .execute();
    const bodies = new Map<number, OutboxBody>();
    for (const row of rows) {
      const body = parseBody(row);
      if (typeof body === 'string') await kill(trx, [row.id], body);
      else bodies.set(row.id, body);
    }

    const blockIds = [...bodies.values()].flatMap((b) =>
      b.kind === 'conversation.open' ? [b.payload.blockId] : [],
    );
    const openBlocks = new Set(
      blockIds.length === 0
        ? []
        : (
            await trx
              .selectFrom('block')
              .select('id')
              .where('id', 'in', blockIds)
              .where('state', '=', 'open')
              .execute()
          ).map((b) => b.id),
    );
    // A row that may already be posted (uncertain) is never stale: it is delivered with
    // maybeSent, and its dependents go as usual, so no platform thread is left unclosed.
    const stale: number[] = [];
    for (const row of rows) {
      const body = row.uncertain === 1 ? undefined : bodies.get(row.id);
      if (body?.kind === 'conversation.open' && !openBlocks.has(body.payload.blockId)) {
        stale.push(row.id);
      }
      // An edit written before its line was sent means the item was cleared (#37).
      if (body?.kind === 'feed.line' && row.state === 'pending') {
        const edits = rows.filter(
          (r) =>
            r.parent_outbox_id === row.id && r.state === 'pending' && r.kind === 'feed.line.edit',
        );
        if (edits.length > 0) stale.push(row.id, ...edits.map((r) => r.id));
      }
    }
    await kill(trx, stale, 'superseded');
    await cascade(trx);

    if (downSince !== undefined && at - downSince > DOWN_THRESHOLD_MS) {
      const since = new Date(downSince).toISOString();
      await trx
        .insertInto('transport_health')
        .values(SPACE_IDS.map((space) => ({ gateway: gateway.kind, space, reason: 'down', since })))
        .onConflict((oc) => oc.columns(['gateway', 'space']).doNothing())
        .execute();
    }

    const live = await trx
      .selectFrom('outbox')
      .leftJoin('outbox as parent', 'parent.id', 'outbox.parent_outbox_id')
      .selectAll('outbox')
      .select(['parent.state as parentState', 'parent.external_ref as parentRef'])
      .where('outbox.state', '=', 'pending')
      .where('outbox.next_at', '<=', nowIso)
      .execute();
    const unhealthy = new Set(
      (
        await trx
          .selectFrom('transport_health')
          .select('space')
          .where('gateway', '=', gateway.kind)
          .execute()
      ).map((h) => h.space),
    );
    const due = live
      .flatMap((row) => {
        const body = bodies.get(row.id);
        if (body === undefined) return [];
        if (row.parent_outbox_id !== null && row.parentState !== 'done') return [];
        return [{ row, body }];
      })
      .sort(
        (a, b) =>
          KIND_PRIORITY[a.body.kind] - KIND_PRIORITY[b.body.kind] ||
          a.row.next_at.localeCompare(b.row.next_at) ||
          a.row.id - b.row.id,
      );

    const claims: Claim[] = [];
    const taken = new Set<SpaceId | null>();
    for (const { row, body } of due) {
      const space = KIND_SPACE[body.kind];
      if (taken.has(space)) continue;
      if (space !== null) {
        if ((nextSlotAt.get(space) ?? 0) > at) continue;
        const probedAt = lastProbeAt.get(space);
        if (unhealthy.has(space) && probedAt !== undefined && at - probedAt < HEALTH_PROBE_MS) {
          continue;
        }
      }
      let parent: DeliveredRef | null = null;
      if (row.parent_outbox_id !== null) {
        const ref = deliveredRefSchema.safeParse(JSON.parse(row.parentRef ?? 'null'));
        if (!ref.success) {
          await kill(trx, [row.id], 'parent has no delivered ref');
          continue;
        }
        parent = ref.data;
      }
      taken.add(space);
      claims.push({
        id: row.id,
        key: row.dedupe_key,
        space,
        maybeSent: row.uncertain === 1,
        attempts: row.attempts + 1,
        body,
        parent,
      });
    }
    for (const c of claims) {
      await trx
        .updateTable('outbox')
        .set((eb) => ({
          state: 'in_flight',
          attempts: eb('attempts', '+', 1),
          first_attempt_at: eb.fn.coalesce('first_attempt_at', eb.val(nowIso)),
        }))
        .where('id', '=', c.id)
        .execute();
    }
    // Doorbells go last; gateway lanes keep priority order.
    return claims.sort((a, b) => Number(a.space === null) - Number(b.space === null));
  }

  async function attempt(c: Claim): Promise<{ outcome: Outcome; error: string | null }> {
    try {
      if (c.body.kind === 'doorbell') {
        await spur.send(c.body.payload.session, c.body.payload.text);
        return { outcome: { status: 'sent' }, error: null };
      }
      const to = target(c);
      if (to === null) throw new Error('a dependent row without its parent ref');
      const request: DeliverRequest = {
        key: c.key,
        maybeSent: c.maybeSent,
        target: to,
        persona: c.body.payload.persona,
        body: renderBody(c.body.payload.key, c.body.payload.text),
      };
      return { outcome: await gateway.deliver(request), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: { status: 'retry', uncertain: true }, error: message };
    }
  }

  /** tx 2 for one row. Returns true when the space's transport failed. */
  async function record(
    trx: Trx,
    c: Claim,
    outcome: Outcome,
    error: string | null,
    at: number,
  ): Promise<boolean> {
    const nowIso = new Date(at).toISOString();
    const row = trx.updateTable('outbox').where('id', '=', c.id);
    const { body, space } = c;
    const postFailed = async (patch: { last_error: string; uncertain?: 0 | 1 }) => {
      await row.set({ state: 'post_failed', ...patch }).execute();
      await setComment(trx, body, { delivery_state: 'post_failed' });
      return false;
    };
    switch (outcome.status) {
      case 'sent':
        await row.set({ state: 'done', last_error: null }).execute();
        return false;
      case 'delivered': {
        const conversation =
          body.kind === 'feed.line.edit'
            ? c.parent?.conversation
            : (outcome.conversation ?? c.parent?.conversation);
        if (conversation === undefined) {
          return postFailed({ last_error: 'delivered without a conversation' });
        }
        const ref = { conversation, message: outcome.message, permalink: outcome.permalink };
        await row
          .set({
            state: 'done',
            last_error: null,
            external_ref: JSON.stringify(deliveredRefSchema.parse(ref)),
          })
          .execute();
        if (body.kind === 'conversation.open' || body.kind === 'feed.line') {
          const isBlock = body.kind === 'conversation.open';
          const taskId = isBlock ? body.payload.taskId : (body.payload.taskId ?? null);
          await trx
            .insertInto('conversation')
            .values({
              ref: conversation,
              gateway: gateway.kind,
              space: KIND_SPACE[body.kind],
              task_id: taskId,
              block_id: isBlock ? body.payload.blockId : null,
              purpose: isBlock ? 'block' : 'feed_line',
              state: 'open',
              root_message_ref: outcome.message,
              after_message_ref: null,
              created_at: nowIso,
              closed_at: null,
            })
            .onConflict((oc) => oc.columns(['gateway', 'ref']).doNothing())
            .execute();
        }
        if (body.kind === 'conversation.close') {
          await trx
            .updateTable('conversation')
            .set({ state: 'closed', closed_at: nowIso })
            .where('gateway', '=', gateway.kind)
            .where('ref', '=', conversation)
            .execute();
        }
        await setComment(trx, body, {
          delivery_state: 'delivered',
          conversation_ref: conversation,
          message_ref: outcome.message,
        });
        if (space !== null) {
          await trx
            .deleteFrom('transport_health')
            .where('gateway', '=', gateway.kind)
            .where('space', '=', space)
            .execute();
        }
        return false;
      }
      case 'retry': {
        const current = await trx
          .selectFrom('outbox')
          .select(['first_attempt_at', 'uncertain'])
          .where('id', '=', c.id)
          .executeTakeFirstOrThrow();
        const health =
          space === null
            ? undefined
            : await trx
                .selectFrom('transport_health')
                .select('since')
                .where('gateway', '=', gateway.kind)
                .where('space', '=', space)
                .executeTakeFirst();
        const uncertain = current.uncertain === 1 || outcome.uncertain ? 1 : 0;
        const lastError =
          error ?? (outcome.uncertain ? 'retry: outcome unknown' : 'retry: rate limited');
        const firstAt =
          current.first_attempt_at === null ? at : Date.parse(current.first_attempt_at);
        if (space !== null && health === undefined && at - firstAt >= RETRY_WINDOW_MS) {
          return postFailed({ uncertain, last_error: lastError });
        }
        await row
          .set({
            state: 'pending',
            uncertain,
            last_error: lastError,
            next_at: new Date(at + (outcome.afterMs ?? backoff(c.attempts))).toISOString(),
            // Under a health row the 30-min window is suspended until the space recovers.
            ...(health === undefined ? {} : { first_attempt_at: null }),
          })
          .execute();
        await setComment(trx, body, { delivery_state: 'pending' });
        return false;
      }
      case 'failed': {
        if (outcome.scope === 'message' || space === null) {
          return postFailed({ last_error: outcome.reason });
        }
        await trx
          .insertInto('transport_health')
          .values({ gateway: gateway.kind, space, reason: outcome.reason, since: nowIso })
          .onConflict((oc) => oc.columns(['gateway', 'space']).doNothing())
          .execute();
        await row
          .set({
            state: 'pending',
            last_error: outcome.reason,
            first_attempt_at: null,
            next_at: new Date(at + HEALTH_PROBE_MS).toISOString(),
          })
          .execute();
        await setComment(trx, body, { delivery_state: 'pending' });
        return true;
      }
    }
  }

  return {
    async recover() {
      const nowIso = now().toISOString();
      await store.transaction(async (trx) => {
        const rows = await trx
          .selectFrom('outbox')
          .select(['id', 'kind', 'payload'])
          .where('state', 'in', ['in_flight', 'post_failed'])
          .execute();
        await trx
          .updateTable('outbox')
          .set({ state: 'pending', uncertain: 1, next_at: nowIso })
          .where('state', '=', 'in_flight')
          .execute();
        await trx
          .updateTable('outbox')
          .set({ state: 'pending', first_attempt_at: null, next_at: nowIso })
          .where('state', '=', 'post_failed')
          .execute();
        for (const row of rows) {
          const body = parseBody(row);
          if (typeof body !== 'string') await setComment(trx, body, { delivery_state: 'pending' });
        }
      });
    },

    async tick() {
      const claimedAt = now().getTime();
      const claims = await store.transaction((trx) => claim(trx, claimedAt));
      for (const c of claims) {
        if (c.space === null) continue;
        lastProbeAt.set(c.space, claimedAt);
        nextSlotAt.set(c.space, claimedAt + spaceIntervalMs);
      }
      for (const c of claims) {
        const { outcome, error } = await attempt(c);
        const at = now().getTime();
        const transportFailed = await store.transaction((trx) =>
          record(trx, c, outcome, error, at),
        );
        if (transportFailed && c.space !== null) lastProbeAt.set(c.space, at);
      }
    },

    recordConnection(state, at) {
      if (state === 'up') downSince = undefined;
      else downSince ??= at.getTime();
    },
  };
}
