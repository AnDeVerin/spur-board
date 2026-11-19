import { BOARD_TICK_MS } from '@spur-board/contracts';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { Tables } from '../store/schema.ts';

type StatusOutput = z.output<typeof statusOutputSchema>;
type SourceView = StatusOutput['sources'][number];
type ServiceRow = StatusOutput['services'][number];

/** The daemon row is degraded after this long without a completed board tick. */
const DAEMON_STALL_MS = 2 * BOARD_TICK_MS;

/** Service of each source id prefix; sources with any other prefix get no services row. */
const SOURCE_SERVICES: Readonly<Record<string, string>> = {
  github: 'github',
  'github-issues': 'github',
  spur: 'spur',
  jira: 'jira',
};

const STATE_RANK = { healthy: 0, degraded: 1, failing: 2 } as const;

/** The latest or oldest of `values`, or null when any is null. */
function pickTime(values: readonly (string | null)[], pick: 'latest' | 'oldest'): string | null {
  let chosen: string | null = null;
  for (const value of values) {
    if (value === null) return null;
    if (chosen === null || Date.parse(value) > Date.parse(chosen) === (pick === 'latest'))
      chosen = value;
  }
  return chosen;
}

/** One source's health: failing when blind, degraded while not fully usable, else healthy. */
function sourceHealth(source: SourceView): Pick<ServiceRow, 'state' | 'reason'> {
  if (source.blindReason !== null) {
    const message = source.message === null ? '' : `: ${source.message}`;
    return {
      state: 'failing',
      reason: `${source.source} blind (${source.blindReason})${message}`,
    };
  }
  const degraded = (reason: string) => ({ state: 'degraded' as const, reason });
  // A source the runner pauses for a rate limit names the pause first: while paused it does not
  // poll, so it cannot complete, warm up or turn fresh. No time: the runner's wake time is its
  // own (a budget pause lasts until the reset or one interval, whichever is later; a throttle
  // until its retry time or a backoff), so the stored budget's resetAt can be wrong.
  if (source.waitsForBudget) return degraded(`${source.source} waits for its rate budget`);
  // The runner does not reload lastCompleteAt, so a restarted source can read null while it
  // completed in an earlier run: name it warming up until its first complete poll.
  if (source.lastCompleteAt === null)
    return degraded(`${source.source} ${source.warmingUp ? 'warming up' : 'never completed'}`);
  if (source.stale) return degraded(`${source.source} stale`);
  if (source.warmingUp) return degraded(`${source.source} warming up`);
  return { state: 'healthy', reason: null };
}

/**
 * One health row per service: the daemon, each gateway (board-wide), then github, spur and jira
 * rolled up from the given sources only.
 */
export function services(input: {
  now: number;
  daemon: StatusOutput['daemon'];
  transport: StatusOutput['transport'];
  /** End of the last recorded outage of each gateway: its newest cleared transport item. */
  outageEnds: ReadonlyMap<string, string>;
  sources: readonly SourceView[];
}): ServiceRow[] {
  const { now, daemon } = input;
  const lastTick = daemon.lastDispatchAt ?? daemon.startedAt;
  const stalled = now - Date.parse(lastTick) > DAEMON_STALL_MS;
  const rows: ServiceRow[] = [
    {
      service: 'daemon',
      state: stalled ? 'degraded' : 'healthy',
      since: stalled ? null : daemon.startedAt,
      lastGoodAt: daemon.lastDispatchAt,
      reason: stalled ? `no board tick completed since ${lastTick}` : null,
    },
  ];
  for (const gateway of input.transport) {
    const ended = input.outageEnds.get(gateway.gateway);
    rows.push(
      gateway.state === 'down'
        ? {
            service: gateway.gateway,
            state: 'failing',
            since: gateway.since,
            lastGoodAt: null,
            reason: gateway.reason,
          }
        : {
            service: gateway.gateway,
            state: 'healthy',
            since:
              ended !== undefined && Date.parse(ended) > Date.parse(daemon.startedAt)
                ? ended
                : daemon.startedAt,
            lastGoodAt: null,
            reason: null,
          },
    );
  }
  for (const service of ['github', 'spur', 'jira']) {
    const members = input.sources.filter(
      (source) => SOURCE_SERVICES[source.source.split(':')[0] ?? ''] === service,
    );
    if (members.length === 0) continue;
    const health = members.map(sourceHealth);
    const worst = health.reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a));
    rows.push({
      service,
      state: worst.state,
      since:
        worst.state === 'healthy'
          ? pickTime(
              members.map((source) => source.healthySince),
              'latest',
            )
          : null,
      lastGoodAt: pickTime(
        members.map((source) => source.observedAt),
        'oldest',
      ),
      reason: worst.reason,
    });
  }
  return rows;
}

/** End of each gateway's last recorded outage: the clear time of its newest transport item. */
export async function readOutageEnds(db: Kysely<Tables>): Promise<Map<string, string>> {
  const items = await db
    .selectFrom('operator_item')
    .select(['item_key', 'cleared_at'])
    .where('item_key', 'like', 'transport:%')
    .orderBy('raise_no')
    .execute();
  // The newest raise of each gateway's item wins: its clear ends the last recorded outage.
  const outageEnds = new Map<string, string>();
  for (const item of items) {
    const gateway = item.item_key.slice('transport:'.length);
    if (item.cleared_at === null) outageEnds.delete(gateway);
    else outageEnds.set(gateway, item.cleared_at);
  }
  return outageEnds;
}
