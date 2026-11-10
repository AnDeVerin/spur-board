import { RESERVED_PROJECT, parseActorId, type ActorId, type Config } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { Tables } from '../store/schema.ts';
import type { ResolvedTarget } from './authorize.ts';
import { emit, projectForKey } from './board-utils.ts';

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
  await emit(
    trx,
    'operation_denied',
    target.kind === 'found' ? target.value.project : deniedProject(config, actor, input),
    target.kind === 'found' ? (target.value.task?.id ?? null) : null,
    at,
    { operation, reason: 'Caller does not match the operation grants.' },
    actor,
  );
}
