import { actorIdSchema, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import type { OutboxState } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { FINISHED_STATES } from './doorbells.ts';
import { enqueueSkillReload, skillReloadKey } from './outbox.ts';

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

/** The fixed message a live session gets after an install of `version`. */
function skillReloadText(version: string): string {
  return `spur-board skill updated to ${version}. Before your next board command, read the spur-board skill file again: ~/.claude/skills/spur-board/SKILL.md (Claude Code) or $CODEX_HOME/skills/spur-board/SKILL.md, by default ~/.codex/skills/spur-board/SKILL.md (Codex).`;
}

/**
 * Queues the reload message for every live session of a configured Spur project, any role.
 * Returns how many rows this call inserted: a session told about `version` before gets none.
 */
export async function requestSkillReload(
  store: Store,
  config: Config,
  version: string,
  at: Date,
): Promise<{ queued: number }> {
  const projects = [
    ...new Set(config.projects.flatMap((project) => project.spurProjects.map((spur) => spur.name))),
  ];
  if (projects.length === 0) return { queued: 0 };
  const text = skillReloadText(version);
  return store.transaction(async (trx) => {
    const sessions = await trx
      .selectFrom('session_snapshot')
      .select('id')
      .where('spur_project', 'in', projects)
      .where('ended_at', 'is', null)
      .where('absent_since', 'is', null)
      .where('state', 'not in', FINISHED_STATES)
      .orderBy('id')
      .execute();
    let queued = 0;
    for (const session of sessions) {
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
