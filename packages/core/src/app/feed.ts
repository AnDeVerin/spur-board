import {
  parseActorId,
  userIdSchema,
  type ActorId,
  type Config,
  type RichText,
  type RichTextInline,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { Row, Tables } from '../store/schema.ts';
import { fingerprint } from '../domain/fromYou.ts';
import { isOperator } from './authorize.ts';
import { TASKLESS_FEED_KEY, journal, raiseItemWith, type RaiseItemInput } from './item-raise.ts';
import { enqueueFeedEdit, enqueueFeedLine, type FeedEditPayload } from './outbox.ts';

/** The struck summary is capped so the edit stays one message part. */
const MAX_SUMMARY = 500;

/** Counts code points, so the cut never splits a surrogate pair. */
function capSummary(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_SUMMARY ? text : `${points.slice(0, MAX_SUMMARY - 1).join('')}…`;
}

type Trx = Kysely<Tables>;

/** Raise one item generation. A repeated raise of an active key is idempotent. */
export async function raiseItem(trx: Trx, input: RaiseItemInput): Promise<Row<'operator_item'>> {
  return raiseItemWith(trx, input, enqueueFeedLine);
}

/**
 * Clear an item once; the edit waits for its line and is cancelled with a stale pending line.
 * The journal names `actor`, `system` unless an actor's action cleared it.
 */
export async function clearItem(
  trx: Trx,
  itemId: number,
  at: Date,
  actor: ActorId = 'system',
): Promise<void> {
  const current = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();
  if (current.cleared_at !== null) return;
  const item = await trx
    .updateTable('operator_item')
    .set({ cleared_at: at.toISOString() })
    .where('id', '=', itemId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await journal(trx, item, 'from_you_cleared', at, undefined, actor);
  if (item.line_outbox_id === null) return;
  const task =
    item.task_id === null
      ? null
      : await trx
          .selectFrom('task')
          .select('key')
          .where('id', '=', item.task_id)
          .executeTakeFirstOrThrow();
  await enqueueFeedEdit(trx, {
    itemKey: item.item_key,
    raise: item.raise_no,
    lineId: item.line_outbox_id,
    key: task?.key ?? TASKLESS_FEED_KEY,
    taskId: item.task_id,
    summary: capSummary(item.text),
    url: item.url,
    by: actor,
    at,
  });
}

/**
 * Dismiss an item as `actor`: record its fingerprint, so `reconcileItems` raises it again only
 * when the fingerprint changes, then clear it. An item raised before fingerprints were stored is
 * fingerprinted from its key, text and source.
 */
export async function dismissItem(
  trx: Trx,
  item: Row<'operator_item'>,
  actor: ActorId,
  at: Date,
): Promise<void> {
  const hash =
    item.fingerprint ??
    fingerprint({ key: item.item_key, summary: item.text, source: item.source, revision: null });
  const dismissedAt = at.toISOString();
  await trx
    .insertInto('dismissal')
    .values({
      item_key: item.item_key,
      fingerprint: hash,
      dismissed_by: actor,
      dismissed_at: dismissedAt,
    })
    .onConflict((oc) =>
      oc
        .column('item_key')
        .doUpdateSet({ fingerprint: hash, dismissed_by: actor, dismissed_at: dismissedAt }),
    )
    .execute();
  await clearItem(trx, item.id, at, actor);
}

function resolvedLine(by: ActorId, at: string, config: Config): RichTextInline[] {
  const parsed = parseActorId(by);
  if (parsed === null || parsed.actor === 'system') {
    return [{ kind: 'text', text: '✓ Resolved: condition ended' }];
  }
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.digest.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
  const who: RichTextInline =
    parsed.actor === 'agent' && !isOperator(by, config)
      ? { kind: 'text', text: `${parsed.actorRef.project}/${parsed.actorRef.session}` }
      : { kind: 'mention', user: userIdSchema.parse(config.operator.slack) };
  return [{ kind: 'text', text: '✓ Resolved by ' }, who, { kind: 'text', text: ` at ${time}` }];
}

/** A cleared line: its key line, the struck summary and who resolved it when; no actions. */
export function resolvedFeedBody(
  payload: FeedEditPayload & { resolved: NonNullable<FeedEditPayload['resolved']> },
  config: Config,
): RichText {
  const { key, url, text, resolved } = payload;
  return [
    {
      kind: 'paragraph',
      children: [
        url === undefined ? { kind: 'text', text: key } : { kind: 'link', url, text: key },
      ],
    },
    { kind: 'quote', children: [{ kind: 'strike', text }] },
    { kind: 'paragraph', children: resolvedLine(resolved.by, resolved.at, config) },
  ];
}
