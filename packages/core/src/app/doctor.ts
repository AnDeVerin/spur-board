import {
  boardWideSpurProject,
  prSourceId,
  slackConfigured,
  trackerSourceId,
  type ColumnBindingSource,
  type Config,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { curatorProject } from './authorize.ts';
import type { Trx } from './board-utils.ts';
import { bestProjectSession, curatorSession } from './doorbells.ts';
import { enqueueLiveFeedLine } from './outbox.ts';

const LIVE_VERSION_KEY = 'doctor_live_version';

/** Configured adapter IDs, including repos used by more than one project. */
function doctorSources(config: Config): ReadonlySet<string> {
  return new Set([
    'spur',
    ...config.projects.flatMap((project) => [
      trackerSourceId(project),
      ...project.repos.map((repo) => prSourceId(project.id, repo)),
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

/**
 * The curator of each board project and the live session its curator blocks ring, in config
 * order. It asks the doorbells for their choice rather than keeping a copy, so the doctor cannot
 * name one session while the rings go to another.
 */
export async function curatorSessions(db: Trx, config: Config): Promise<CuratorSession[]> {
  const entries: CuratorSession[] = [];
  for (const project of config.projects) {
    entries.push({
      project: project.id,
      curator: curatorProject(config, project.id),
      session: (await curatorSession(db, config, project.id))?.id ?? null,
    });
  }
  return entries;
}

/**
 * Configured orchestrators, where each binding comes from, and the same live session selected
 * for their rings.
 */
export async function orchestratorSessions(db: Trx, config: Config) {
  const entries: {
    project: string;
    orchestrator: string;
    source: ColumnBindingSource;
    session: string | null;
    columns: string[];
  }[] = [];
  for (const project of config.projects) {
    for (const spur of project.spurProjects.filter((entry) => entry.role === 'orchestrator')) {
      entries.push({
        project: project.id,
        orchestrator: spur.name,
        source: boardWideSpurProject(config, spur.name) === undefined ? 'project' : 'board-wide',
        session: (await bestProjectSession(db, spur.name))?.id ?? null,
        columns: project.columns
          .filter(
            (column) =>
              column.orchestrator !== 'none' &&
              column.orchestrator !== 'operator' &&
              column.orchestrator === spur.name,
          )
          .map((column) => column.id),
      });
    }
  }
  return entries;
}

/**
 * Called from an accepted observation's transaction after board and item reconciliation.
 * The version marker and feed row share that transaction with the source-state update. With
 * Slack off it writes neither, so the first poll after Slack is set posts the line.
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
  if (!slackConfigured(input.config)) return;
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
    // Count what the operator can see in the feed; a quiet item has no line there.
    .where('line_outbox_id', 'is not', null)
    .executeTakeFirstOrThrow();
  const text = `spur-board is live: ${String(tasks.count)} tasks, ${String(items.count)} for you`;
  await enqueueLiveFeedLine(trx, { version: input.productVersion, text, at: new Date(input.at) });
  await trx
    .insertInto('meta')
    .values({ key: LIVE_VERSION_KEY, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}
