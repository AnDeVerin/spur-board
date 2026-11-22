import {
  parseActorId,
  userIdSchema,
  type ActorId,
  type BlockType,
  type Config,
  type RichText,
  type RichTextBlock,
  type RichTextInline,
} from '@spur-board/contracts';
import type { Row } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import { fingerprint, itemLineText, OPERATOR_BLOCK_KEY } from '../domain/fromYou.ts';
import { isOperator } from './authorize.ts';
import { TASKLESS_FEED_KEY, journal, raiseItemWith, type RaiseItemInput } from './item-raise.ts';
import {
  enqueueFeedEdit,
  enqueueFeedLine,
  promoteWorkerDoorbells,
  type FeedEditPayload,
  type FeedLinePayload,
} from './outbox.ts';

/** The struck summary is capped so the edit stays one message part. */
const MAX_SUMMARY = 500;

/**
 * Cuts `text` to `max` code points, so the cut never splits a surrogate pair; a cut text ends
 * with `…`.
 */
export function capPoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Raise one item generation. A repeated raise of an active key is idempotent. An operator block's
 * line carries the block's type, and its `thread.parent` row holds the line until it is delivered.
 */
export async function raiseItem(
  trx: Trx,
  input: RaiseItemInput,
  thread: { parent: number | null; blockType: BlockType } | null = null,
): Promise<Row<'operator_item'>> {
  return raiseItemWith(trx, input, (t, line) =>
    thread === null
      ? enqueueFeedLine(t, line)
      : enqueueFeedLine(t, { ...line, blockType: thread.blockType }, thread.parent),
  );
}

/**
 * Whether the course check `item` forwarded a note: a worker `answer` notification on its block.
 * The note's first ring then releases the held rings (`releaseAfterCourseNote`).
 */
async function courseNoted(trx: Trx, item: Row<'operator_item'>): Promise<boolean> {
  if (item.block_id === null) return false;
  const note = await trx
    .selectFrom('notification')
    .select('id')
    .where('block_id', '=', item.block_id)
    .where('role', '=', 'worker')
    .where('kind', '=', 'answer')
    .executeTakeFirst();
  return note !== undefined;
}

/**
 * Clear an item once; the edit waits for its line and is cancelled with a stale pending line.
 * A course check cleared without a note moves the worker's held rings on its task that wait in
 * the outbox to the front, so they keep their order.
 * The journal names `actor`, `system` unless an actor's action cleared it. `writeEdit`, when
 * given, writes the line's edit instead of the resolved one.
 */
export async function clearItem(
  trx: Trx,
  itemId: number,
  at: Date,
  actor: ActorId = 'system',
  writeEdit?: (item: Row<'operator_item'>, lineId: number) => Promise<unknown>,
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
  if (item.kind === 'course_check' && item.task_id !== null && !(await courseNoted(trx, item)))
    await promoteWorkerDoorbells(trx, item.task_id, at);
  if (item.line_outbox_id === null) return;
  if (writeEdit !== undefined) {
    await writeEdit(item, item.line_outbox_id);
    return;
  }
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
    summary: capPoints(itemLineText(item), MAX_SUMMARY),
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

/** `HH:MM`, or `YYYY-MM-DD HH:MM` with `date`, in the digest time zone. */
function feedTime(at: string, config: Config, date = false): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.digest.tz,
    ...(date ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const time = `${part('hour')}:${part('minute')}`;
  return date ? `${part('year')}-${part('month')}-${part('day')} ${time}` : time;
}

/** Who acted, for a non-system actor: an agent by its session, else the operator's mention. */
function actorInline(
  by: ActorId,
  parsed: NonNullable<ReturnType<typeof parseActorId>>,
  config: Config,
): RichTextInline {
  return parsed.actor === 'agent' && !isOperator(by, config, null)
    ? { kind: 'text', text: `${parsed.actorRef.project}/${parsed.actorRef.session}` }
    : { kind: 'mention', user: userIdSchema.parse(config.operator.slack) };
}

function resolvedLine(by: ActorId, at: string, config: Config): RichTextInline[] {
  const parsed = parseActorId(by);
  if (parsed === null || parsed.actor === 'system') {
    return [{ kind: 'text', text: '✓ Resolved: condition ended' }];
  }
  return [
    { kind: 'text', text: '✓ Resolved by ' },
    actorInline(by, parsed, config),
    { kind: 'text', text: ` at ${feedTime(at, config)}` },
  ];
}

/**
 * A feed line: its key, linked when it has a url, then its segments, or its text, as a quote. An
 * operator block's line says what Close does right under the key, so a long reason cannot push the
 * warning off the message with the Close button. Under its delivered `thread` it links the
 * thread, and for a question says that a reply there answers it; a reply to any other block type
 * is refused. A line queued before the block type was stored names no type.
 */
export function feedLineBody(
  payload: Pick<FeedLinePayload, 'key' | 'url' | 'text' | 'segments' | 'blockType'> & {
    itemKey?: string;
  },
  thread?: { permalink: string } | null,
): RichText {
  const { key, url, text, segments, itemKey, blockType } = payload;
  const body: RichTextBlock[] = [
    {
      kind: 'paragraph',
      children: [
        url === undefined ? { kind: 'text', text: key } : { kind: 'link', url, text: key },
      ],
    },
  ];
  if (itemKey?.startsWith(OPERATOR_BLOCK_KEY) === true) {
    const block = `B${itemKey.slice(OPERATOR_BLOCK_KEY.length)}`;
    const close =
      blockType === 'needs_input'
        ? `Close closes ${block} without an answer.`
        : blockType === undefined
          ? `Close unblocks ${block} without an answer.`
          : `Close unblocks ${block}.`;
    const link: RichTextInline | null =
      thread == null ? null : { kind: 'link', url: thread.permalink, text: `the ${block} thread` };
    // A paragraph, not context: Slack leaves context out of the text screen readers read.
    body.push({
      kind: 'paragraph',
      children:
        link === null
          ? [{ kind: 'text', text: close }]
          : blockType === 'needs_input'
            ? [
                { kind: 'text', text: 'Reply in ' },
                link,
                { kind: 'text', text: ` to answer it. ${close}` },
              ]
            : [{ kind: 'text', text: 'See ' }, link, { kind: 'text', text: `. ${close}` }],
    });
  }
  body.push({ kind: 'quote', children: segments ?? [{ kind: 'text', text }] });
  return body;
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

/** An approved operator token's card: name, folder, created and approved times, who revoked it. */
export function tokenCardBody(
  card: NonNullable<FeedEditPayload['tokenCard']>,
  config: Config,
): RichText {
  const body = [
    { kind: 'paragraph', children: [{ kind: 'text', text: `Operator token ${card.name}` }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: `Folder: ${card.folder}` }] },
    {
      kind: 'paragraph',
      children: [
        {
          kind: 'text',
          text: `Created ${feedTime(card.createdAt, config, true)} · Approved ${feedTime(card.approvedAt, config, true)}`,
        },
      ],
    },
  ] satisfies RichText;
  if (card.revoked === undefined) return body;
  const { by, at } = card.revoked;
  const parsed = parseActorId(by);
  const time = feedTime(at, config);
  return [
    ...body,
    {
      kind: 'paragraph',
      children:
        parsed === null || parsed.actor === 'system'
          ? [{ kind: 'text', text: `Revoked at ${time}` }]
          : [
              { kind: 'text', text: 'Revoked by ' },
              actorInline(by, parsed, config),
              { kind: 'text', text: ` at ${time}` },
            ],
    },
  ];
}
