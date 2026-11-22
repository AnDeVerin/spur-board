import { hostUsageLevel } from '@spur-board/contracts/browser';
import { z } from 'zod';
import type { ItemCandidate } from '../domain/fromYou.ts';
import type { Store } from '../store/store.ts';
import type { Trx } from './board-utils.ts';

const HOST_DISK_KEY = 'host-disk:';
const META_KEY = 'host_disk';
const GIB = 2 ** 30;

/** The volumes of one host sample, as the daemon reports them in `status.get` `host`. */
export interface HostDiskSample {
  sampledAt: string;
  volumes: readonly { mount: string; usedPercent: number; availableBytes: number }[];
}

/**
 * Per mount: the run of samples in a row at the error level, when the open episode began (null
 * when none is open) and the latest reading.
 */
const stateSchema = z.record(
  z.string(),
  z.strictObject({
    streak: z.number().int().nonnegative(),
    since: z.iso.datetime().nullable(),
    usedPercent: z.number(),
    availableBytes: z.number(),
    sampledAt: z.iso.datetime(),
  }),
);
type HostDiskState = z.output<typeof stateSchema>;

/** The stored state; a missing or malformed value reads as empty. */
async function readState(trx: Trx): Promise<HostDiskState> {
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', META_KEY)
    .executeTakeFirst();
  if (row === undefined) return {};
  try {
    const parsed = stateSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Records one host sample's volumes. Two samples in a row at the error level open an episode; a
 * sample below the warn level ends it. A mount missing from the sample keeps its entry.
 */
export async function recordHostDisk(store: Store, sample: HostDiskSample): Promise<void> {
  await store.transaction(async (trx) => {
    const state = await readState(trx);
    for (const volume of sample.volumes) {
      const level = hostUsageLevel(volume.usedPercent);
      const previous = state[volume.mount];
      const streak = level === 'error' ? (previous?.streak ?? 0) + 1 : 0;
      let since = previous?.since ?? null;
      if (level === 'ok') since = null;
      else if (streak >= 2 && since === null) since = sample.sampledAt;
      state[volume.mount] = {
        streak,
        since,
        usedPercent: volume.usedPercent,
        availableBytes: volume.availableBytes,
        sampledAt: sample.sampledAt,
      };
    }
    const value = JSON.stringify(stateSchema.parse(state));
    await trx
      .insertInto('meta')
      .values({ key: META_KEY, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
  });
}

/**
 * One item per volume with an open episode. The fingerprint hashes the mount and the episode
 * start, so the item and its feed line stay while the shown numbers follow the latest sample.
 */
export async function hostDiskItems(trx: Trx): Promise<ItemCandidate[]> {
  const state = await readState(trx);
  return Object.entries(state).flatMap(([mount, entry]) =>
    entry.since === null
      ? []
      : [
          {
            key: `${HOST_DISK_KEY}${mount}`,
            kind: 'board_observation' as const,
            taskId: null,
            summary: `host disk ${mount}: ${String(Math.floor(entry.usedPercent))}% used, ${(entry.availableBytes / GIB).toFixed(1)} GiB free`,
            hashedSummary: `host disk ${mount}`,
            factAt: entry.sampledAt,
            source: null,
            priority: 4,
            revision: entry.since,
          },
        ],
  );
}
