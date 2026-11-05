import {
  EVENT_VERSION,
  RESERVED_PROJECT,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
  type Config,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toJson } from '../store/json.ts';
import type { Tables } from '../store/schema.ts';
import type { ResolvedTarget } from './authorize.ts';
import { projectForKey } from './board-utils.ts';

const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });

/**
 * The journal project of a denial with no resolved target, in order: the configured project
 * the input's `task` key or `project` names; else the only configured project listing the agent
 * actor's Spur project; else `RESERVED_PROJECT`. Never throws.
 */
export function deniedProject(config: Config, actor: ActorId, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const hints = input as { task?: unknown; project?: unknown };
    if (typeof hints.task === 'string') {
      const project = projectForKey(config, hints.task);
      if (project !== null) return project.id;
    }
    if (typeof hints.project === 'string') {
      const named = hints.project;
      if (config.projects.some((project) => project.id === named)) return named;
    }
  }
  const parsed = parseActorId(actor);
  if (parsed?.actor === 'agent') {
    const owners = config.projects.filter((project) =>
      project.spurProjects.some((spur) => spur.name === parsed.actorRef.project),
    );
    if (owners.length === 1 && owners[0] !== undefined) return owners[0].id;
  }
  return RESERVED_PROJECT;
}

/** Persist an authorization refusal through the caller's transaction. */
export async function writeDeniedEvent(
  trx: Kysely<Tables>,
  denial: {
    config: Config;
    actor: ActorId;
    operation: string;
    input: unknown;
    target: ResolvedTarget;
    at: string;
  },
): Promise<void> {
  const { config, actor, operation, input, target, at } = denial;
  const parsed = parseActorId(actor);
  if (parsed === null) throw new Error('Invalid actor');
  await trx
    .insertInto('event')
    .values({
      at,
      project: target.kind === 'found' ? target.value.project : deniedProject(config, actor, input),
      task_id: target.kind === 'found' ? (target.value.task?.id ?? null) : null,
      kind: 'operation_denied',
      actor: parsed.actor,
      actor_ref: parsed.actor === 'agent' ? toJson(actorRefSchema, parsed.actorRef) : null,
      payload: toJson(eventPayloadSchemas.operation_denied, {
        operation,
        reason: 'Caller does not match the operation grants.',
      }),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}
