import {
  actorIdSchema,
  SKILL_RELOAD_NAMED_MAX,
  sortSkillFiles,
  type Config,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import type { OutboxState } from '../store/schema.ts';
import type { Trx } from './board-utils.ts';
import type { Store } from '../store/store.ts';
import { FINISHED_STATES } from './doorbells.ts';
import { enqueueSkillReload, SKILL_RELOAD_KEY_PREFIX, skillReloadKey } from './outbox.ts';

/** An installed spur-board version: strict semver with an optional prerelease. */
export const SKILL_VERSION = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);

/** Session ids a caller already holds, checked as the session part of an agent actor ID. */
export const RELOAD_SESSIONS = z
  .array(
    z
      .string()
      .max(128)
      .refine((id) => actorIdSchema.safeParse(`agent:project/${id}`).success),
  )
  .min(1)
  .max(200);

type SkillReloadState = 'delivered' | 'pending' | 'failed';

const SKILL_RELOAD_TEXT_MAX = 600;
const SKILL_PATHS =
  '~/.claude/skills/spur-board/ (Claude Code) or $CODEX_HOME/skills/spur-board/, by default ~/.codex/skills/spur-board/ (Codex)';

/**
 * The message a live session gets after an install of `version`. With `names` it lists those
 * files, `SKILL.md` first; more than six names or a text over 600 characters asks for every file.
 */
function skillReloadText(version: string, names?: readonly string[]): string {
  const every = `spur-board skill updated to ${version}. Before your next board command, read the spur-board skill again, SKILL.md and every file in its references/ folder: ${SKILL_PATHS}.`;
  if (names === undefined || names.length === 0 || names.length > SKILL_RELOAD_NAMED_MAX) {
    return every;
  }
  const named = `spur-board skill updated to ${version}. Before your next board command, read these files of the spur-board skill again: ${sortSkillFiles(names).join(', ')}. They are under ${SKILL_PATHS}.`;
  return named.length <= SKILL_RELOAD_TEXT_MAX ? named : every;
}

/** The newest delivered reload time of each named session; pending or failed rows never count. */
async function deliveredReloads(
  trx: Trx,
  sessions: readonly string[],
): Promise<Map<string, number>> {
  const newest = new Map<string, number>();
  if (sessions.length === 0) return newest;
  const rows = await trx
    .selectFrom('outbox')
    .select([
      sql`json_extract(payload, '$.session')`.as('session'),
      sql`json_extract(payload, '$.queuedAt')`.as('queuedAt'),
    ])
    .where('kind', '=', 'doorbell')
    .where('dedupe_key', '>=', SKILL_RELOAD_KEY_PREFIX)
    .where('dedupe_key', '<', `${SKILL_RELOAD_KEY_PREFIX.slice(0, -1)};`)
    .where('state', '=', 'done')
    .where(sql`json_extract(payload, '$.session')`, 'in', [...sessions])
    .execute();
  for (const row of rows) {
    if (typeof row.session !== 'string' || typeof row.queuedAt !== 'string') continue;
    const at = Date.parse(row.queuedAt);
    if (!Number.isFinite(at)) continue;
    newest.set(row.session, Math.max(newest.get(row.session) ?? -Infinity, at));
  }
  return newest;
}

/**
 * Queues the reload message for every live session of a configured Spur project, any role.
 * With `files`, a session gets a message only when a file changed after its baseline, the later
 * of its first poll and its newest delivered reload, and the message names only those files.
 * Returns how many rows this call inserted: a session told about `version` before gets none.
 */
export async function requestSkillReload(
  store: Store,
  config: Config,
  version: string,
  at: Date,
  files?: Readonly<Record<string, string>>,
): Promise<{ queued: number }> {
  const projects = [
    ...new Set(config.projects.flatMap((project) => project.spurProjects.map((spur) => spur.name))),
  ];
  if (projects.length === 0) return { queued: 0 };
  const changes = Object.entries(files ?? {}).map(([name, changedAt]) => ({
    name,
    changedAt: Date.parse(changedAt),
  }));
  return store.transaction(async (trx) => {
    const sessions = await trx
      .selectFrom('session_snapshot')
      .select(['id', 'first_seen'])
      .where('spur_project', 'in', projects)
      .where('ended_at', 'is', null)
      .where('absent_since', 'is', null)
      .where('state', 'not in', FINISHED_STATES)
      .orderBy('id')
      .execute();
    const delivered =
      files === undefined
        ? new Map<string, number>()
        : await deliveredReloads(
            trx,
            sessions.map((session) => session.id),
          );
    let queued = 0;
    for (const session of sessions) {
      let text: string;
      if (files === undefined) text = skillReloadText(version);
      else {
        const firstSeen = Date.parse(session.first_seen);
        const baseline = Math.max(
          Number.isFinite(firstSeen) ? firstSeen : -Infinity,
          delivered.get(session.id) ?? -Infinity,
        );
        const names = changes
          .filter((change) => change.changedAt > baseline)
          .map((change) => change.name);
        if (names.length === 0) continue;
        text = skillReloadText(version, names);
      }
      if (await enqueueSkillReload(trx, { session: session.id, version, text, at })) queued += 1;
    }
    return { queued };
  });
}

const STATES: Record<OutboxState, SkillReloadState> = {
  done: 'delivered',
  pending: 'pending',
  in_flight: 'pending',
  dead: 'failed',
  post_failed: 'failed',
};

const storedPayload = z.looseObject({ session: z.string(), queuedAt: z.string().optional() });

/**
 * The reload record of each named session for `version`, sorted by id. A session without a
 * record is left out, and no session the caller did not name is ever returned.
 */
export async function skillReloads(
  db: Store['db'],
  version: string,
  sessions: readonly string[],
): Promise<{ id: string; state: SkillReloadState; queuedAt: string | null }[]> {
  const keys = new Map(sessions.map((session) => [skillReloadKey(version, session), session]));
  if (keys.size === 0) return [];
  const rows = await db
    .selectFrom('outbox')
    .select(['dedupe_key', 'state', 'payload'])
    .where('kind', '=', 'doorbell')
    .where('dedupe_key', 'in', [...keys.keys()])
    .execute();
  const records = rows.flatMap((row) => {
    const id = keys.get(row.dedupe_key);
    if (id === undefined) return [];
    let queuedAt: string | null = null;
    try {
      const payload = storedPayload.safeParse(JSON.parse(row.payload));
      if (payload.success && payload.data.session === id) queuedAt = payload.data.queuedAt ?? null;
    } catch {
      // An unreadable payload keeps its state; the reader treats a null time as no record.
    }
    return [{ id, state: STATES[row.state], queuedAt }];
  });
  return records.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
