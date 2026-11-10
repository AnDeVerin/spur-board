import { SCAN_PENDING, scanTransaction } from './secrets.ts';
// Delivers outbox rows: claim in one transaction, stamp the send's start, IO outside any
// transaction, record the result in another. Each claim first returns the rows a failed tick left
// in flight. The daemon calls `recover()` once on start, then `tick()` on its schedule.
import {
  SPACE_IDS,
  type ConnectionState,
  type Config,
  type DeliverRequest,
  type DeliveryResult,
  type DeliveryTarget,
  type Gateway,
  type SpaceId,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import type { Store } from '../store/store.ts';
import type { Row, Tables } from '../store/schema.ts';
import { recordRingDelivery, ringStillCurrent, ringTask, ringUndelivered } from './doorbells.ts';
import { clearItem, raiseItem, resolvedFeedBody } from './feed.ts';
import {
  deliveredRefSchema,
  KIND_PRIORITY,
  KIND_SPACE,
  OUTBOX_KINDS,
  outboxBodySchema,
  renderBody,
  rescanStoredPost,
  type DeliveredRef,
  type OutboxBody,
} from './outbox.ts';

/** Spur's side of a doorbell: deliver `text` to the session's agent. */
export interface SpurPort {
  send(session: string, text: string): Promise<void>;
}

/**
 * Spur refused a doorbell for good (a permanent 4xx): the sender stops ringing and ends the ring
 * instead of retrying it. Any other error from `send` is retried.
 */
export class SpurRejectedError extends Error {
  override name = 'SpurRejectedError';
}

export interface SenderOptions {
  store: Store;
  gateway?: Gateway;
  config: Config;
  spur: SpurPort;
  now?: () => Date;
  /** Minimum time between two deliveries into one space. */
  spaceIntervalMs?: number;
}

export interface Sender {
  /** Returns `in_flight` rows as uncertain and `post_failed` rows to `pending`. Run once on start. */
  recover(): Promise<void>;
  /**
   * Claims due rows, delivers them one by one and records each result. A call made while a tick
   * runs waits for it, then runs.
   */
  tick(signal?: AbortSignal): Promise<void>;
  /**
   * Feeds the gateway's connection events; down for over 5 min raises health for every space,
   * once per outage. `up` clears the down health. Runs between ticks, never inside one.
   */
  recordConnection(state: ConnectionState, at: Date): Promise<void>;
}

/** 1 msg/s per space: a platform limit, not an operator setting. */
const SPACE_INTERVAL_MS = 1000;
const RETRY_WINDOW_MS = 30 * 60_000;
const DOWN_THRESHOLD_MS = 5 * 60_000;
export const HEALTH_PROBE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
/** post_failed rows rescanned per `recover()` transaction: far below the scan's string limit. */
const RECOVER_BATCH = 100;

type Trx = Kysely<Tables>;
type OutboxRow = Row<'outbox'>;

interface Claim {
  id: number;
  key: string;
  space: SpaceId | null;
  maybeSent: boolean;
  firstDeliveryAt: string | null;
  attempts: number;
  body: OutboxBody;
  /** The parent's refs, for a dependent row. */
  parent: DeliveredRef | null;
}

/** `sent` and `rejected` are a doorbell's: Spur took the ring, or refused it for good. */
type Outcome = DeliveryResult | { status: 'sent' } | { status: 'rejected' };

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

/** The kinds whose rows wait in one of `spaces`. */
function kindsIn(spaces: readonly SpaceId[]) {
  return OUTBOX_KINDS.filter((kind) => {
    const space = KIND_SPACE[kind];
    return space !== null && spaces.includes(space);
  });
}

/**
 * Raises the gateway's one transport item while it has health rows and clears it once none are
 * left. Call it in the transaction that changed the rows, only when they changed.
 */
async function syncTransportItem(trx: Trx, gateway: string, at: Date): Promise<void> {
  const itemKey = `transport:${gateway}`;
  const rows = await trx
    .selectFrom('transport_health')
    .select(['reason', 'since'])
    .where('gateway', '=', gateway)
    .orderBy('since')
    .orderBy('space')
    .execute();
  const first = rows[0];
  if (first !== undefined) {
    // A permanent failure needs the operator's action, so it names the item over a lost socket.
    const permanent = rows.find((r) => r.reason !== 'down');
    const reason = permanent?.reason ?? 'connection lost';
    const text = `${gateway} delivery down since ${first.since} (${reason})`;
    const item = await raiseItem(trx, {
      itemKey,
      kind: 'transport_health',
      text,
      url: '',
      taskId: null,
      blockId: null,
      priority: 1,
      suppressFeed: true,
      at,
    });
    // raiseItem keeps an active item as it is; the item has no feed line, so its text is
    // updated in place when the rows change the reason.
    if (item.text !== text) {
      await trx.updateTable('operator_item').set({ text }).where('id', '=', item.id).execute();
    }
    return;
  }
  const active = await trx
    .selectFrom('operator_item')
    .select('id')
    .where('item_key', '=', itemKey)
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (active !== undefined) await clearItem(trx, active.id, at);
}

/**
 * Makes the next tick probe every space of `gateway` that has a health row: the probe clock is
 * set one interval back and waiting rows there become due at `at` (ISO-8601 UTC). Returns the
 * number of spaces armed; 0 when no outage is recorded.
 */
export async function retryTransport(trx: Trx, gateway: string, at: string): Promise<number> {
  const rows = await trx
    .updateTable('transport_health')
    .set({ probe_at: new Date(Date.parse(at) - HEALTH_PROBE_MS).toISOString() })
    .where('gateway', '=', gateway)
    .returning('space')
    .execute();
  const kinds = kindsIn(rows.map((row) => row.space));
  if (kinds.length === 0) return rows.length;
  await trx
    .updateTable('outbox')
    .set({ next_at: at })
    .where('state', '=', 'pending')
    .where('kind', 'in', kinds)
    .where('next_at', '>', at)
    .execute();
  return rows.length;
}

async function setComment(
  trx: Trx,
  body: OutboxBody,
  patch: Partial<Pick<Row<'comment'>, 'delivery_state' | 'conversation_ref' | 'message_ref'>>,
): Promise<void> {
  const commentId = commentOf(body);
  if (commentId === null) return;
  await trx.updateTable('comment').set(patch).where('id', '=', commentId).execute();
}

/**
 * Returns the `post_failed` rows among `ids` to `pending` with a fresh retry window, and their
 * comments to `pending`. Each stored payload is scanned again first: a row that now looks like a
 * secret goes `dead` unsent, handled as a blocked post at insert. Returns how many rows left
 * `post_failed`.
 */
export async function requeuePostFailed(
  trx: Trx,
  ids: readonly number[],
  nowIso: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const failed = await trx
    .selectFrom('outbox')
    .select(['id', 'kind', 'dedupe_key', 'payload'])
    .where('id', 'in', ids)
    .where('state', '=', 'post_failed')
    .execute();
  const clean: number[] = [];
  for (const row of failed) {
    const kind = OUTBOX_KINDS.find((candidate) => candidate === row.kind);
    const rule =
      kind === undefined ? null : await rescanStoredPost(trx, { ...row, kind }, new Date(nowIso));
    if (rule === SCAN_PENDING) continue;
    if (rule === null) {
      clean.push(row.id);
      continue;
    }
    await trx
      .updateTable('outbox')
      .set({ state: 'dead', last_error: `blocked: looks like a secret (${rule})` })
      .where('id', '=', row.id)
      .execute();
  }
  // A pending scan re-runs the whole transaction, so the count is only read once it is complete.
  if (clean.length === 0) return failed.length;
  const rows = await trx
    .updateTable('outbox')
    .set({ state: 'pending', first_attempt_at: null, next_at: nowIso })
    .where('id', 'in', clean)
    .returning(['kind', 'payload'])
    .execute();
  for (const row of rows) {
    const body = parseBody(row);
    if (typeof body !== 'string') await setComment(trx, body, { delivery_state: 'pending' });
  }
  return failed.length;
}

/**
 * Returns every `in_flight` row to `pending`: one whose send never started gives its attempt
 * back; one whose send started may be out, so it goes again at once as uncertain. Its comment
 * goes back to `pending`. Only a crash or a failed earlier tick leaves a row `in_flight`.
 */
async function releaseOrphans(trx: Trx, nowIso: string): Promise<void> {
  const rows = await trx
    .selectFrom('outbox')
    .select(['kind', 'payload'])
    .where('state', '=', 'in_flight')
    .execute();
  if (rows.length === 0) return;
  await trx
    .updateTable('outbox')
    .set((eb) => ({ state: 'pending', attempts: eb('attempts', '-', 1) }))
    .where('state', '=', 'in_flight')
    .where('attempt_started', '=', 0)
    .execute();
  await trx
    .updateTable('outbox')
    .set({ state: 'pending', uncertain: 1, next_at: nowIso })
    .where('state', '=', 'in_flight')
    .where('attempt_started', '=', 1)
    .execute();
  for (const row of rows) {
    const body = parseBody(row);
    if (typeof body !== 'string') await setComment(trx, body, { delivery_state: 'pending' });
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
      return body.payload.targetConversation === undefined
        ? parent && { kind: 'close', conversation: parent.conversation }
        : { kind: 'close', conversation: body.payload.targetConversation };
    case 'feed.line.edit':
      return parent && { kind: 'edit', message: parent.message };
    case 'doorbell':
      return null;
  }
}

export function createSender(options: SenderOptions): Sender {
  const { store, gateway, spur } = options;
  const gatewayKind = gateway?.kind ?? 'none';
  const now = options.now ?? (() => new Date());
  const spaceIntervalMs = options.spaceIntervalMs ?? SPACE_INTERVAL_MS;
  let downSince: number | undefined;
  /** Set once this outage's down rows were written; reset on `up`. */
  let downRecorded = false;
  /** The last tick started; a new tick runs after it, so two ticks never interleave. */
  let ticking: Promise<void> = Promise.resolve();

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

  /**
   * Raising or refreshing health for `spaces` suspends the 30-min window of every waiting row
   * there, so a row that retried before the outage gets a full window once the space recovers.
   */
  async function suspendWindows(trx: Trx, spaces: readonly SpaceId[]): Promise<void> {
    const kinds = kindsIn(spaces);
    if (kinds.length === 0) return;
    await trx
      .updateTable('outbox')
      .set({ first_attempt_at: null })
      .where('state', 'in', ['pending', 'in_flight'])
      .where('kind', 'in', kinds)
      .execute();
  }

  /**
   * tx 1: returns rows a failed tick left in flight, cancels stale rows, raises down-health and
   * claims at most one due row per lane.
   * `ranThreshold` says the outage's down rows were written; the caller records that after commit.
   */
  async function claim(trx: Trx, at: number): Promise<{ claims: Claim[]; ranThreshold: boolean }> {
    const nowIso = new Date(at).toISOString();
    // Ticks never overlap, so a row still in flight was left by a tick that threw.
    await releaseOrphans(trx, nowIso);
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

    let ranThreshold = false;
    // Once per outage: a delivery that later clears a space's row is not undone by a re-insert.
    if (
      gateway !== undefined &&
      !downRecorded &&
      downSince !== undefined &&
      at - downSince > DOWN_THRESHOLD_MS
    ) {
      const since = new Date(downSince).toISOString();
      const inserted = await trx
        .insertInto('transport_health')
        .values(
          SPACE_IDS.map((space) => ({
            gateway: gatewayKind,
            space,
            reason: 'down',
            since,
            // A space down for 5 min has not been probed since it went down.
            probe_at: since,
          })),
        )
        .onConflict((oc) => oc.columns(['gateway', 'space']).doNothing())
        .returning('space')
        .execute();
      await suspendWindows(trx, SPACE_IDS);
      if (inserted.length > 0) await syncTransportItem(trx, gatewayKind, new Date(at));
      ranThreshold = true;
    }

    const live = await trx
      .selectFrom('outbox')
      .leftJoin('outbox as parent', 'parent.id', 'outbox.parent_outbox_id')
      .selectAll('outbox')
      .select(['parent.state as parentState', 'parent.external_ref as parentRef'])
      .where('outbox.state', '=', 'pending')
      .where('outbox.next_at', '<=', nowIso)
      .execute();
    // A space takes one send per spaceIntervalMs and, while it has a health row, one probe per
    // HEALTH_PROBE_MS, both counted from when the last send started.
    const sentAt = new Map(
      (gateway === undefined
        ? []
        : await trx
            .selectFrom('space_slot')
            .select(['space', 'sent_at'])
            .where('gateway', '=', gatewayKind)
            .execute()
      ).map((slot) => [slot.space, Date.parse(slot.sent_at)]),
    );
    const probedAt = new Map(
      (gateway === undefined
        ? []
        : await trx
            .selectFrom('transport_health')
            .select(['space', 'probe_at'])
            .where('gateway', '=', gatewayKind)
            .execute()
      ).map((h) => [h.space, Date.parse(h.probe_at)]),
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
      if (space !== null && gateway === undefined) continue;
      if (taken.has(space)) continue;
      if (space !== null) {
        const sent = sentAt.get(space);
        if (sent !== undefined && at - sent < spaceIntervalMs) continue;
        const probed = probedAt.get(space);
        if (probed !== undefined && at - probed < HEALTH_PROBE_MS) continue;
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
        firstDeliveryAt: row.first_delivery_at,
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
          attempt_started: 0,
        }))
        .where('id', '=', c.id)
        .execute();
    }
    // Doorbells go last; gateway lanes keep priority order.
    return {
      claims: claims.sort((a, b) => Number(a.space === null) - Number(b.space === null)),
      ranThreshold,
    };
  }

  /**
   * Stamps the start of a send, just before its IO: the row's retry window if none is open and,
   * for a space, the slot of the next send and, under a health row, the probe clock. A slow
   * earlier send in the tick does not age them. The clock is read here, once the write lock is
   * held, so waiting for the lock does not age them either. Returns the stamp.
   */
  async function start(
    trx: Trx,
    c: Claim,
  ): Promise<{ at: number; firstDeliveryAt: string | null; skip: boolean }> {
    const at = now().getTime();
    const sentAtIso = new Date(at).toISOString();
    if (c.body.kind === 'feed.line' && c.body.payload.itemId !== undefined && !c.maybeSent) {
      const item = await trx
        .selectFrom('operator_item')
        .select('cleared_at')
        .where('id', '=', c.body.payload.itemId)
        .executeTakeFirst();
      if (item !== undefined && item.cleared_at !== null) {
        const edits = await trx
          .selectFrom('outbox')
          .select('id')
          .where('parent_outbox_id', '=', c.id)
          .where('kind', '=', 'feed.line.edit')
          .execute();
        await kill(trx, [c.id, ...edits.map((edit) => edit.id)], 'superseded');
        return { at, firstDeliveryAt: null, skip: true };
      }
    }
    // A ring of an archived task is dropped, uncertain or not: Spur gets no maybeSent hint.
    if (
      c.body.kind === 'doorbell' &&
      (await ringTask(trx, c.body.payload.notificationId, c.key))?.membership === 'archived'
    ) {
      await kill(trx, [c.id], 'superseded');
      return { at, firstDeliveryAt: null, skip: true };
    }
    if (c.body.kind === 'doorbell' && c.body.payload.notificationId !== undefined) {
      const status = await ringStillCurrent(
        trx,
        c.body.payload.notificationId,
        c.body.payload.session,
      );
      if (status === 'dead') {
        await kill(trx, [c.id], 'notification no longer current');
        return { at, firstDeliveryAt: null, skip: true };
      }
      if (status === 'defer') {
        await trx
          .updateTable('outbox')
          .set((eb) => ({
            state: 'pending',
            attempts: eb('attempts', '-', 1),
            next_at: new Date(at + 1000).toISOString(),
          }))
          .where('id', '=', c.id)
          .execute();
        return { at, firstDeliveryAt: null, skip: true };
      }
    }
    const firstDeliveryAt =
      c.firstDeliveryAt ?? (c.space !== null && !c.maybeSent ? sentAtIso : null);
    await trx
      .updateTable('outbox')
      .set((eb) => ({
        first_attempt_at: eb.fn.coalesce('first_attempt_at', eb.val(sentAtIso)),
        first_delivery_at: firstDeliveryAt,
        attempt_started: 1,
      }))
      .where('id', '=', c.id)
      .execute();
    const { space } = c;
    if (space === null) return { at, firstDeliveryAt, skip: false };
    await trx
      .insertInto('space_slot')
      .values({ gateway: gatewayKind, space, sent_at: sentAtIso })
      .onConflict((oc) => oc.columns(['gateway', 'space']).doUpdateSet({ sent_at: sentAtIso }))
      .execute();
    await trx
      .updateTable('transport_health')
      .set({ probe_at: sentAtIso })
      .where('gateway', '=', gatewayKind)
      .where('space', '=', space)
      .execute();
    return { at, firstDeliveryAt, skip: false };
  }

  async function attempt(
    c: Claim,
    firstDeliveryAt: string | null,
  ): Promise<{ outcome: Outcome; error: string | null }> {
    try {
      if (c.body.kind === 'doorbell') {
        await spur.send(c.body.payload.session, c.body.payload.text);
        return { outcome: { status: 'sent' }, error: null };
      }
      if (gateway === undefined) throw new Error('gateway is not configured');
      const to = target(c);
      if (to === null) throw new Error('a dependent row without its parent ref');
      const { body } = c;
      const request: DeliverRequest = {
        key: c.key,
        maybeSent: c.maybeSent,
        ...(firstDeliveryAt === null ? {} : { firstAttemptAt: new Date(firstDeliveryAt) }),
        target: to,
        persona: c.body.payload.persona,
        body:
          body.kind === 'feed.line.edit' && body.payload.resolved !== undefined
            ? resolvedFeedBody({ ...body.payload, resolved: body.payload.resolved }, options.config)
            : c.body.kind === 'feed.line' && c.body.payload.url !== undefined
              ? [
                  {
                    kind: 'paragraph',
                    children: [{ kind: 'link', url: c.body.payload.url, text: c.body.payload.key }],
                  },
                  { kind: 'quote', children: [{ kind: 'text', text: c.body.payload.text }] },
                ]
              : renderBody(c.body.payload.key, c.body.payload.text),
        ...(c.body.kind === 'feed.line' && c.body.payload.actions !== undefined
          ? { actions: c.body.payload.actions }
          : {}),
      };
      return { outcome: await gateway.deliver(request), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SpurRejectedError) {
        return { outcome: { status: 'rejected' }, error: message };
      }
      return { outcome: { status: 'retry', uncertain: true }, error: message };
    }
  }

  /** tx 2 for one row. */
  async function record(
    trx: Trx,
    c: Claim,
    outcome: Outcome,
    error: string | null,
    at: number,
    startedAt: number,
  ): Promise<void> {
    const nowIso = new Date(at).toISOString();
    const row = trx.updateTable('outbox').where('id', '=', c.id);
    const { body, space } = c;
    const postFailed = async (patch: { last_error: string; uncertain?: 0 | 1 }) => {
      await row.set({ state: 'post_failed', ...patch }).execute();
      await setComment(trx, body, { delivery_state: 'post_failed' });
    };
    /** Kills a ring Spur will not take and ends its notification. */
    const endRing = async (reason: string) => {
      await kill(trx, [c.id], reason);
      if (body.kind !== 'doorbell') return;
      await ringUndelivered(trx, {
        notificationId: body.payload.notificationId,
        outboxId: c.id,
        dedupeKey: c.key,
        session: body.payload.session,
        reason,
        at: new Date(at),
        config: options.config,
      });
    };
    switch (outcome.status) {
      case 'sent':
        await row.set({ state: 'done', last_error: null }).execute();
        if (
          body.kind === 'doorbell' &&
          body.payload.notificationId !== undefined &&
          body.payload.ring !== undefined
        ) {
          await recordRingDelivery(
            trx,
            body.payload.notificationId,
            body.payload.ring,
            body.payload.session,
            new Date(at),
            options.config,
          );
        }
        return;
      case 'delivered': {
        const conversation =
          body.kind === 'conversation.close'
            ? (body.payload.targetConversation ?? outcome.conversation ?? c.parent?.conversation)
            : body.kind === 'feed.line.edit'
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
          const closedBlock = isBlock
            ? await trx
                .selectFrom('block')
                .select(['task_id', 'state', 'unblocked_at', 'created_at'])
                .where('id', '=', body.payload.blockId)
                .executeTakeFirstOrThrow()
            : undefined;
          // The block's own task: a key merge may have moved it after this row was claimed.
          const taskId = closedBlock?.task_id ?? body.payload.taskId ?? null;
          await trx
            .insertInto('conversation')
            .values({
              ref: conversation,
              gateway: gatewayKind,
              space: KIND_SPACE[body.kind],
              task_id: taskId,
              block_id: isBlock ? body.payload.blockId : null,
              purpose: isBlock ? 'block' : 'feed_line',
              state: closedBlock?.state === 'unblocked' ? 'closed' : 'open',
              root_message_ref: outcome.message,
              after_message_ref: null,
              // The block predates any answer posted while an uncertain open awaited registration.
              created_at: closedBlock?.created_at ?? nowIso,
              closed_at:
                closedBlock?.state === 'unblocked' ? (closedBlock.unblocked_at ?? nowIso) : null,
            })
            .onConflict((oc) => oc.columns(['gateway', 'ref']).doNothing())
            .execute();
          if (isBlock) {
            const explicit = await trx
              .selectFrom('outbox')
              .select('id')
              .where('kind', '=', 'conversation.close')
              .where(sql<number>`json_extract(payload, '$.blockId')`, '=', body.payload.blockId)
              .where(sql<string>`json_extract(payload, '$.targetConversation')`, '=', conversation)
              .executeTakeFirst();
            if (explicit !== undefined) {
              await trx
                .updateTable('outbox')
                .set({ state: 'dead', last_error: 'superseded' })
                .where('parent_outbox_id', '=', c.id)
                .where('kind', '=', 'conversation.close')
                .where(
                  sql<string | null>`json_extract(payload, '$.targetConversation')`,
                  'is',
                  null,
                )
                .where('state', '=', 'pending')
                .execute();
            }
          }
        }
        if (body.kind === 'conversation.close') {
          await trx
            .updateTable('conversation')
            .set({ state: 'closed', closed_at: nowIso })
            .where('gateway', '=', gatewayKind)
            .where('ref', '=', conversation)
            .execute();
        }
        await setComment(trx, body, {
          delivery_state: 'delivered',
          conversation_ref: conversation,
          message_ref: outcome.message,
        });
        if (space !== null) {
          const cleared = await trx
            .deleteFrom('transport_health')
            .where('gateway', '=', gatewayKind)
            .where('space', '=', space)
            .returning('space')
            .execute();
          if (cleared.length > 0) await syncTransportItem(trx, gatewayKind, new Date(at));
        }
        return;
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
                .where('gateway', '=', gatewayKind)
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
        // A doorbell has no space and no health row: Spur silent for the window ends the ring.
        if (space === null && at - firstAt >= RETRY_WINDOW_MS) {
          return endRing(`no answer from Spur for 30 min: ${lastError}`);
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
        return;
      }
      case 'rejected':
        return endRing(error ?? 'rejected by Spur');
      case 'failed': {
        if (outcome.scope === 'message' || space === null) {
          return postFailed({ last_error: outcome.reason });
        }
        const raised = await trx
          .insertInto('transport_health')
          .values({
            gateway: gatewayKind,
            space,
            reason: outcome.reason,
            since: nowIso,
            probe_at: new Date(startedAt).toISOString(),
          })
          // A standing row keeps its since and the probe clock that start() stamped. A socket-down
          // row takes the permanent reason, so a reconnect does not clear a failure it cannot fix.
          .onConflict((oc) =>
            oc
              .columns(['gateway', 'space'])
              .doUpdateSet({ reason: outcome.reason })
              .where('transport_health.reason', '=', 'down'),
          )
          .returning('space')
          .execute();
        if (raised.length > 0) await syncTransportItem(trx, gatewayKind, new Date(at));
        await suspendWindows(trx, [space]);
        await row
          .set({
            state: 'pending',
            last_error: outcome.reason,
            first_attempt_at: null,
            next_at: new Date(at + HEALTH_PROBE_MS).toISOString(),
          })
          .execute();
        await setComment(trx, body, { delivery_state: 'pending' });
      }
    }
  }

  async function runTick(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const claimedAt = now().getTime();
    const { claims, ranThreshold } = await scanTransaction(store, options.config, (trx) =>
      claim(trx, claimedAt),
    );
    // Only after commit: a scan replay reruns claim() and a rolled-back pass wrote nothing.
    if (ranThreshold) downRecorded = true;
    for (const [i, c] of claims.entries()) {
      if (signal?.aborted) {
        const ids = claims.slice(i).map((c) => c.id);
        await scanTransaction(store, options.config, (trx) =>
          trx
            .updateTable('outbox')
            .set((eb) => ({ state: 'pending', attempts: eb('attempts', '-', 1) }))
            .where('id', 'in', ids)
            .where('state', '=', 'in_flight')
            .execute(),
        );
        return;
      }
      const started = await scanTransaction(store, options.config, (trx) => start(trx, c));
      if (started.skip) continue;
      // After start() commits, finish and record this attempt even if shutdown begins.
      const { outcome, error } = await attempt(c, started.firstDeliveryAt);
      const at = now().getTime();
      await scanTransaction(store, options.config, (trx) =>
        record(trx, c, outcome, error, at, started.at),
      );
    }
  }

  return {
    async recover() {
      const nowIso = now().toISOString();
      const failed = await scanTransaction(store, options.config, async (trx) => {
        await releaseOrphans(trx, nowIso);
        const rows = await trx
          .selectFrom('outbox')
          .select('id')
          .where('state', '=', 'post_failed')
          .execute();
        return rows.map((row) => row.id);
      });
      // Each batch rescans its payloads in its own transaction, so a large failed backlog stays
      // under the per-transaction scan limit and cannot stop the daemon from starting.
      for (let i = 0; i < failed.length; i += RECOVER_BATCH) {
        const batch = failed.slice(i, i + RECOVER_BATCH);
        await scanTransaction(store, options.config, (trx) =>
          requeuePostFailed(trx, batch, nowIso),
        );
      }
    },

    tick(signal?: AbortSignal) {
      const run = ticking.then(() => runTick(signal));
      // A rejected tick still lets the next one run.
      ticking = run.catch(() => undefined);
      return run;
    },

    recordConnection(state, at) {
      const run = ticking.then(async () => {
        if (state === 'down') {
          downSince ??= at.getTime();
          return;
        }
        downSince = undefined;
        downRecorded = false;
        if (gateway === undefined) return;
        // A permanent-failure row stays: only a probe that delivers clears it.
        await scanTransaction(store, options.config, async (trx) => {
          const cleared = await trx
            .deleteFrom('transport_health')
            .where('gateway', '=', gatewayKind)
            .where('reason', '=', 'down')
            .returning('space')
            .execute();
          if (cleared.length > 0) await syncTransportItem(trx, gatewayKind, at);
        });
      });
      ticking = run.catch(() => undefined);
      return run;
    },
  };
}
