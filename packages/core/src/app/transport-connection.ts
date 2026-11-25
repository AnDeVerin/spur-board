import { z } from 'zod';
import type { Trx } from './board-utils.ts';

const KEY_PREFIX = 'transport_connection:';

/** The last connection event of one gateway: `up` at its connect, `down` at its drop. */
const connectionSchema = z.strictObject({
  state: z.enum(['up', 'down']),
  at: z.iso.datetime(),
});
export type ConnectionRecord = z.output<typeof connectionSchema>;

/** Stores the gateway's last connection event; `at` becomes ISO-8601 UTC. */
export async function writeConnection(
  trx: Trx,
  gateway: string,
  state: ConnectionRecord['state'],
  at: Date,
): Promise<void> {
  const value = JSON.stringify({ state, at: at.toISOString() });
  await trx
    .insertInto('meta')
    .values({ key: `${KEY_PREFIX}${gateway}`, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

/** Each gateway's connection record; a malformed value reads as no record. */
export async function readConnections(db: Trx): Promise<Map<string, ConnectionRecord>> {
  const rows = await db
    .selectFrom('meta')
    .select(['key', 'value'])
    .where('key', 'like', `${KEY_PREFIX}%`)
    .execute();
  const records = new Map<string, ConnectionRecord>();
  for (const row of rows) {
    // `_` in the pattern matches any character.
    if (!row.key.startsWith(KEY_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const record = connectionSchema.safeParse(parsed);
    if (record.success) records.set(row.key.slice(KEY_PREFIX.length), record.data);
  }
  return records;
}
