import { sourceCursorSchema, type SourceCursor } from '@spur-board/contracts';
import { z } from 'zod';

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)));
// GitHub returns a null author for a deleted account.
export const discoveryNodeWire = z.object({
  number: z.int().positive(),
  updatedAt: timestamp,
  author: z.object({ login: z.string() }).nullable(),
});
export const baselineNodeWire = z.object({ updatedAt: timestamp });
type DiscoveryNode = z.output<typeof discoveryNodeWire>;
type BaselineNode = z.output<typeof baselineNodeWire>;

export interface Discovery {
  numbers: number[];
  cursor?: SourceCursor;
}
export function latestUpdatedAt(
  nodes: readonly BaselineNode[],
  previous: SourceCursor | undefined,
): SourceCursor | undefined {
  let high = previous;
  for (const node of nodes) {
    const updated = sourceCursorSchema.parse(node.updatedAt);
    if (high === undefined || Date.parse(updated) > Date.parse(high)) high = updated;
  }
  return high;
}
/** The high-water cursor is an ISO timestamp. Equal timestamps are revisited. */
export function discover(
  nodes: readonly DiscoveryNode[],
  previous: SourceCursor | undefined,
  login: string,
): Discovery {
  let high = previous;
  const numbers = new Set<number>();
  for (const node of nodes) {
    const updated = sourceCursorSchema.parse(node.updatedAt);
    const updatedMs = Date.parse(updated);
    if (high === undefined || updatedMs > Date.parse(high)) high = updated;
    if (previous !== undefined && updatedMs < Date.parse(previous)) continue;
    if (node.author?.login.toLowerCase() !== login.toLowerCase()) continue;
    numbers.add(node.number);
  }
  return { numbers: [...numbers], ...(high === undefined ? {} : { cursor: high }) };
}
/** Pages are sorted newest first; older nodes end the scan, while ties must be revisited. */
export function pastCursor(
  nodes: readonly Pick<DiscoveryNode, 'updatedAt'>[],
  previous: SourceCursor | undefined,
): boolean {
  const oldest = nodes.at(-1);
  if (previous === undefined || oldest === undefined) return false;
  return Date.parse(oldest.updatedAt) < Date.parse(previous);
}
export function nextPage(connection: {
  nodes: readonly unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}): string | undefined {
  const { hasNextPage, endCursor } = connection.pageInfo;
  if (!hasNextPage) return undefined;
  if (!endCursor) throw new Error('Malformed GitHub pagination');
  return endCursor;
}
