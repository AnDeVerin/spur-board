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

/** The first key after every skill reload key. */
const SKILL_RELOAD_KEY_END = `${SKILL_RELOAD_KEY_PREFIX.slice(0, -1)};`;

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
    .where('dedupe_key', '<', SKILL_RELOAD_KEY_END)
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

interface SkillReloadRecord {
  id: string;
  state: SkillReloadState;
  queuedAt: string | null;
}

/** The queue time a row's payload holds for `id`; an unreadable or foreign payload has none. */
function payloadQueuedAt(payload: string, id: string): string | null {
  try {
    const parsed = storedPayload.safeParse(JSON.parse(payload));
    if (parsed.success && parsed.data.session === id) return parsed.data.queuedAt ?? null;
  } catch {
    // An unreadable payload keeps its state; the reader treats a null time as no record.
  }
  return null;
}

function reloadTime(record: SkillReloadRecord): number {
  const at = record.queuedAt === null ? Number.NaN : Date.parse(record.queuedAt);
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * The reload records of the named sessions, sorted by id and state. With `version`, each
 * session's record for it; without, each session's newest record per state over every version,
 * so one session can have up to three. A session without a record is left out, and no session
 * the caller did not name is ever returned.
 */
export async function skillReloads(
  db: Store['db'],
  version: string | undefined,
  sessions: readonly string[],
): Promise<SkillReloadRecord[]> {
  const named = new Set(sessions);
  if (named.size === 0) return [];
  let records: SkillReloadRecord[];
  if (version === undefined) {
    const rows = await db
      .selectFrom('outbox')
      .select([
        'dedupe_key',
        'state',
        'payload',
        sql`json_extract(payload, '$.session')`.as('session'),
      ])
      .where('kind', '=', 'doorbell')
      .where('dedupe_key', '>=', SKILL_RELOAD_KEY_PREFIX)
      .where('dedupe_key', '<', SKILL_RELOAD_KEY_END)
      .where(sql`json_extract(payload, '$.session')`, 'in', [...named])
      .execute();
    const newest = new Map<string, SkillReloadRecord>();
    for (const row of rows) {
      const id = row.session;
      if (typeof id !== 'string' || !named.has(id) || !row.dedupe_key.endsWith(`:${id}`)) continue;
      const record = { id, state: STATES[row.state], queuedAt: payloadQueuedAt(row.payload, id) };
      const slot = `${record.state}:${id}`;
      const kept = newest.get(slot);
      if (kept === undefined || reloadTime(record) > reloadTime(kept)) newest.set(slot, record);
    }
    records = [...newest.values()];
  } else {
    const keys = new Map([...named].map((session) => [skillReloadKey(version, session), session]));
    const rows = await db
      .selectFrom('outbox')
      .select(['dedupe_key', 'state', 'payload'])
      .where('kind', '=', 'doorbell')
      .where('dedupe_key', 'in', [...keys.keys()])
      .execute();
    records = rows.flatMap((row) => {
      const id = keys.get(row.dedupe_key);
      return id === undefined
        ? []
        : [{ id, state: STATES[row.state], queuedAt: payloadQueuedAt(row.payload, id) }];
    });
  }
  const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  return records.sort((left, right) => order(left.id, right.id) || order(left.state, right.state));
}
