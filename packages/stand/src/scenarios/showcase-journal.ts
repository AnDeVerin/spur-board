// The showcase's backdated journal (`showcase.ts`): no operation sets when a task entered its
// column, so one listed direct write spreads each task's events over the hours before the seed.
import { issueKey } from './helpers.ts';
import type { Board } from './index.ts';

/** A task's plan: how long before the seed its journal starts and it entered its column. */
interface Spread {
  number: number;
  enteredAgo: number;
  since: number;
}

const SHOWCASE_REMAP_NOTE =
  'journal times spread before the seed: no operation sets when a task entered its column (#894); closed blocks and their comments move with their events, open blocks, turns and notifications keep seed times';

const ENTRY_KINDS = new Set(['task_moved', 'task_manually_moved', 'task_mirror_moved']);

/**
 * The index of the event the status read takes as the entry into `column`: the latest move to it,
 * or the task's first `task_added` while its `at` is the task's `created_at`
 * (`readStatusColumnEntries` in `packages/core/src/app/status-views.ts`).
 */
function entryIndex(
  events: readonly { kind: string; payload: string; at: string }[],
  column: string,
  createdAt: string,
): number {
  const firstAdded = events.findIndex(({ kind }) => kind === 'task_added');
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { kind, payload, at } = events[i] ?? { kind: '', payload: '{}', at: '' };
    const parsed = JSON.parse(payload) as { to?: unknown; column?: unknown; shadow?: unknown };
    if (kind === 'task_added' && i === firstAdded && at === createdAt && parsed.column === column)
      return i;
    if (parsed.to !== column) continue;
    if (kind === 'task_mirror_moved' && parsed.shadow != null) continue;
    if (ENTRY_KINDS.has(kind) || (kind === 'task_corrected' && parsed.shadow === false)) return i;
  }
  return -1;
}

/**
 * Spreads each task's journal over its plan: the events before the column entry from `since` to
 * `enteredAgo` before `now`, the entry at `enteredAgo`, and the later ones up to a fifth of
 * `enteredAgo` before `now`, all in id order. `created_at` moves with the first `task_added`.
 * A closed block moves with its events: `created_at` to its `block_opened`, `unblocked_at` to its
 * `block_unblocked` (the answered-via read joins them on that time), the opening comment with the
 * block and each other comment of its thread to its `comment_added`. An open block keeps its seed
 * `created_at`, which the `block:` item reads, and so do its comments, turns and notifications,
 * which the doorbells read.
 */
export async function remapJournal(
  board: Board,
  tasks: readonly Spread[],
  now: number,
): Promise<void> {
  await board.direct(SHOWCASE_REMAP_NOTE, async (db) => {
    for (const { number, enteredAgo, since } of tasks) {
      const task = await db
        .selectFrom('task')
        .select(['id', 'column', 'created_at'])
        .where('project', '=', 'stand')
        .where('key', '=', issueKey(number))
        .executeTakeFirstOrThrow();
      const events = await db
        .selectFrom('event')
        .select(['id', 'kind', 'payload', 'at'])
        .where('task_id', '=', task.id)
        .orderBy('id')
        .execute();
      const entry = entryIndex(events, task.column, task.created_at);
      if (entry < 0) throw new Error(`no entry event of ${issueKey(number)} into ${task.column}`);
      const entryAt = now - enteredAgo;
      const start = now - since;
      const after = events.length - entry - 1;
      const times = events.map((_, i) =>
        i < entry
          ? start + ((entryAt - start) * i) / entry
          : i === entry
            ? entryAt
            : entryAt + ((enteredAgo * 0.8) / after) * (i - entry),
      );
      const firstAdded = events.findIndex(
        ({ kind, at }) => kind === 'task_added' && at === task.created_at,
      );
      const iso = times.map((time) => new Date(Math.round(time)).toISOString());
      for (const [i, event] of events.entries())
        await db
          .updateTable('event')
          .set({ at: iso[i] ?? '' })
          .where('id', '=', event.id)
          .executeTakeFirstOrThrow();
      if (firstAdded >= 0)
        await db
          .updateTable('task')
          .set({ created_at: iso[firstAdded] ?? '' })
          .where('id', '=', task.id)
          .executeTakeFirstOrThrow();
      // The new time of each event by `<kind> <block or comment id>`, the last one winning.
      const moved = new Map(
        events.map(({ kind, payload }, i) => {
          const { block, comment } = JSON.parse(payload) as { block?: unknown; comment?: unknown };
          return [`${kind} ${String(comment ?? block)}`, iso[i] ?? ''];
        }),
      );
      const movedAt = (name: string): string => {
        const at = moved.get(name);
        if (at === undefined) throw new Error(`showcase: no ${name} event`);
        return at;
      };
      const closed = await db
        .selectFrom('block')
        .select(['id', 'author', 'reason'])
        .where('task_id', '=', task.id)
        .where('state', '!=', 'open')
        .execute();
      for (const block of closed) {
        const opened = movedAt(`block_opened B${String(block.id)}`);
        await db
          .updateTable('block')
          .set({
            created_at: opened,
            unblocked_at: movedAt(`block_unblocked B${String(block.id)}`),
          })
          .where('id', '=', block.id)
          .executeTakeFirstOrThrow();
        const comments = await db
          .selectFrom('comment')
          .select(['id', 'author', 'text'])
          .where('block_id', '=', block.id)
          .orderBy('id')
          .execute();
        // `block.ask` writes the opening comment first, with the block's author and reason. It
        // keeps the block's time, as the thread hides it only while it does (`withoutBlockOpenings`
        // in `packages/core/src/app/task-queries.ts`); a fixed clock gives every reply that time
        // too, so the opening is told by identity, not time.
        for (const [i, { id, author, text }] of comments.entries()) {
          const at =
            i === 0 && author === block.author && text === block.reason
              ? opened
              : movedAt(`comment_added C${String(id)}`);
          await db
            .updateTable('comment')
            .set({ created_at: at })
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        }
      }
    }
  });
}
