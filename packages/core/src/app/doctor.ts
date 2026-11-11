import type { Config } from '@spur-board/contracts';
import { sql } from 'kysely';
import { curatorProject } from './authorize.ts';
import { trackerSource, type Trx } from './board-utils.ts';
import { enqueueLiveFeedLine } from './outbox.ts';

const LIVE_VERSION_KEY = 'doctor_live_version';

/** Configured adapter IDs, including repos used by more than one project. */
function doctorSources(config: Config): ReadonlySet<string> {
  return new Set([
    'spur',
    ...config.projects.flatMap((project) => [
      trackerSource(project),
      ...project.repos.map((repo) => `github:${project.id}:${repo.toLowerCase()}`),
    ]),
  ]);
}

/**
 * True once every configured source that is not blind has had a complete poll in this process.
 * A blind source never completes, so it is left out rather than holding the answer false.
 */
export async function firstPollDone(
  db: Trx,
  config: Config,
  completeSince: ReadonlyMap<string, string>,
): Promise<boolean> {
  const states = await db
    .selectFrom('source_state')
    .select('source')
    .where('blind_reason', 'is not', null)
    .execute();
  const blind = new Set(states.map((state) => state.source));
  return [...doctorSources(config)].every(
    (source) => blind.has(source) || completeSince.has(source),
  );
}

/** One board project's curator and its live session; null where there is none. */
export interface CuratorSession {
  readonly project: string;
  readonly curator: string | null;
  readonly session: string | null;
}

/** Milliseconds of a stored time, or null for a missing or unreadable one. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Negative when `a` is later; a null time is the oldest. Compared, never subtracted. */
function laterFirst(a: number | null, b: number | null): number {
  const left = a ?? -Infinity;
  const right = b ?? -Infinity;
  return left > right ? -1 : left < right ? 1 : 0;
}

/**
 * The curator and live curator session of each board project, in config order. A session is
 * live while it has not ended, was not omitted by a complete poll, and is not killed, stopped or
 * completed. The latest first seen wins, then the latest activity, then the lowest id. A row with
 * an unreadable time or detail stays eligible and sorts as oldest on that time.
 */
export async function curatorSessions(db: Trx, config: Config): Promise<CuratorSession[]> {
  const curators = config.projects.map((project) => ({
    project: project.id,
    curator: curatorProject(config, project.id),
  }));
  const names = curators.flatMap((entry) => (entry.curator === null ? [] : [entry.curator]));
  const rows =
    names.length === 0
      ? []
      : await db
          .selectFrom('session_snapshot')
          .select([
            'id',
            'spur_project',
            'first_seen',
            // json_extract raises on malformed JSON; a bad row must not fail the doctor.
            sql`CASE WHEN json_valid(detail) THEN json_extract(detail, '$.lastActivityAt') END`.as(
              'last_activity_at',
            ),
          ])
          .where('spur_project', 'in', names)
          .where('ended_at', 'is', null)
          .where('absent_since', 'is', null)
          .where('state', 'not in', ['killed', 'stopped', 'completed'])
          .execute();
  const ranked = rows
    .map((row) => ({
      id: row.id,
      project: row.spur_project,
      firstSeen: instant(row.first_seen),
      lastActivity: instant(row.last_activity_at),
    }))
    .sort(
      (a, b) =>
        laterFirst(a.firstSeen, b.firstSeen) ||
        laterFirst(a.lastActivity, b.lastActivity) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return curators.map((entry) => ({
    ...entry,
    session: ranked.find((row) => row.project === entry.curator)?.id ?? null,
  }));
}

/**
 * Called from an accepted observation's transaction after board and item reconciliation.
 * The version marker and feed row share that transaction with the source-state update.
 */
export async function enqueueLiveAfterFirstPoll(
  trx: Trx,
  input: {
    config: Config;
    productVersion: string;
    completeSince: ReadonlyMap<string, string>;
    blind: ReadonlySet<string>;
    at: string;
  },
): Promise<void> {
  const required = doctorSources(input.config);
  if ([...required].some((source) => !input.completeSince.has(source) || input.blind.has(source)))
    return;

  const value = JSON.stringify(input.productVersion);
  const previous = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', LIVE_VERSION_KEY)
    .executeTakeFirst();
  if (previous?.value === value) return;

  const tasks = await trx
    .selectFrom('task')
    .select(sql<number>`count(*)`.as('count'))
    .where('membership', '!=', 'archived')
    .executeTakeFirstOrThrow();
  const items = await trx
    .selectFrom('operator_item')
    .select(sql<number>`count(*)`.as('count'))
    .where('cleared_at', 'is', null)
    .executeTakeFirstOrThrow();
  const text = `spur-board is live: ${String(tasks.count)} tasks, ${String(items.count)} for you`;
  await enqueueLiveFeedLine(trx, { version: input.productVersion, text, at: new Date(input.at) });
  await trx
    .insertInto('meta')
    .values({ key: LIVE_VERSION_KEY, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}
