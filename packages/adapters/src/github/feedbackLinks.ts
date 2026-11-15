// The links and edit times of PR feedback: each entry's URL and newest edit, and each review's
// inline comments from the review threads.
import type { PrFeedback } from '@spur-board/contracts';
import { z } from 'zod';

// An inline review comment as its thread lists it; a pending review's comment has no review.
const threadCommentWire = z.object({
  id: z.string().min(1),
  url: z.string().optional(),
  lastEditedAt: z.string().nullish(),
  pullRequestReview: z.object({ id: z.string().min(1) }).nullish(),
});
// `id` and `comments` are optional only so the committed live recordings still replay.
export const threadWire = z.object({
  id: z.string().min(1).optional(),
  isResolved: z.boolean(),
  comments: z.object({ nodes: z.array(threadCommentWire) }).optional(),
});
export type ThreadWire = z.output<typeof threadWire>;
type InlineComment = NonNullable<PrFeedback['comments']>[number];
/** The newest of the given edit times; undefined when none was edited. */
export function newestEdit(times: readonly (string | null | undefined)[]): string | undefined {
  return times.reduce<string | undefined>(
    (newest, time) =>
      time == null || (newest !== undefined && Date.parse(newest) >= Date.parse(time))
        ? newest
        : time,
    undefined,
  );
}
/** The link fields of a fact: each only when GitHub gave it, never guessed. */
export function linkOf(url: string | undefined, editedAt: string | undefined) {
  return { ...(url === undefined ? {} : { url }), ...(editedAt === undefined ? {} : { editedAt }) };
}
/** Each review's inline comments by review id, in thread order and oldest first in a thread. */
export function inlineComments(threads: readonly ThreadWire[]): Map<string, InlineComment[]> {
  const byReview = new Map<string, InlineComment[]>();
  for (const thread of threads)
    for (const node of thread.comments?.nodes ?? []) {
      const review = node.pullRequestReview?.id;
      if (review === undefined) continue;
      const list = byReview.get(review) ?? [];
      list.push({
        id: node.id,
        ...linkOf(node.url, node.lastEditedAt ?? undefined),
        ...(thread.id === undefined ? {} : { threadId: thread.id }),
      });
      byReview.set(review, list);
    }
  return byReview;
}
