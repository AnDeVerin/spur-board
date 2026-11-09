import type { Config } from '@spur-board/contracts';
import { sql } from 'kysely';
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
