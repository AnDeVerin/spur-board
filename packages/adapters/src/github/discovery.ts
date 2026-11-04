import { sourceCursorSchema, type SourceCursor } from '@spur-board/contracts';
import { list, record, string, type Json, type RecordValue } from './client.ts';

export interface Discovery {
  numbers: number[];
  cursor?: SourceCursor;
}
/** The high-water cursor is an ISO timestamp. Equal timestamps are revisited. */
export function discover(
  nodes: readonly RecordValue[],
  previous: SourceCursor | undefined,
  login: string,
): Discovery {
  let high = previous;
  const numbers = new Set<number>();
  for (const node of nodes) {
    const updated = sourceCursorSchema.parse(string(node.updatedAt));
    const updatedMs = Date.parse(updated);
    if (Number.isNaN(updatedMs)) throw new Error('Malformed GitHub updatedAt');
    if (high === undefined || updatedMs > Date.parse(high)) high = updated;
    if (previous !== undefined && updatedMs < Date.parse(previous)) continue;
    const author = record(node.author);
    if (typeof author.login !== 'string' || author.login.toLowerCase() !== login.toLowerCase())
      continue;
    const number = node.number;
    if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return { numbers: [...numbers], ...(high === undefined ? {} : { cursor: high }) };
}
export function discoveryNodes(connection: Json | undefined): RecordValue[] {
  return list(record(connection).nodes).map(record);
}
export function nextPage(connection: Json | undefined): string | undefined {
  const info = record(record(connection).pageInfo);
  if (info.hasNextPage === false) return undefined;
  if (
    info.hasNextPage !== true ||
    typeof info.endCursor !== 'string' ||
    info.endCursor.length === 0
  ) {
    throw new Error('Malformed GitHub pagination');
  }
  return string(info.endCursor);
}
