import type { ActorId, Config } from '@spur-board/contracts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { createBlockMutations } from './blocks.ts';
import { createMembershipMutations } from './membership.ts';
import type { OperationRegistry } from './operations.ts';
import type { Query } from './queries.ts';
import { getStatus } from './status.ts';

function projectTarget(project: string): ResolvedTarget {
  return {
    kind: 'found',
    value: { project, task: null, block: null, workers: [] },
  };
}

function visibleProjects(config: Config, actor: ActorId): ReadonlySet<string> {
  return new Set(
    config.projects
      .filter(
        (project) =>
          authorize([{ grant: 'operator' }, { grant: 'project-agent' }], actor, {
            config,
            target: projectTarget(project.id),
          }).status === 'allowed',
      )
      .map((project) => project.id),
  );
}

/** Concrete handlers shared by the daemon's HTTP and inbound transports. */
export function createOperationRegistry(deps: {
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
}): OperationRegistry {
  const { config, clock, completeSince } = deps;
  const membership = createMembershipMutations(config);
  const blocks = createBlockMutations(config);
  const status: Query<'status.get'> = {
    id: 'status.get',
    resolveTargets(_trx, input, actor) {
      const visible = visibleProjects(config, actor);
      const projects =
        input.project === undefined
          ? config.projects.filter((project) => visible.has(project.id))
          : config.projects.filter((project) => project.id === input.project);
      return Promise.resolve(
        projects.length === 0
          ? [{ kind: 'missing' as const }]
          : projects.map((project) => projectTarget(project.id)),
      );
    },
    run(trx, input, actor) {
      return getStatus(
        { store: { db: trx }, config, clock, completeSince },
        input.project,
        visibleProjects(config, actor),
      );
    },
  };
  return {
    'status.get': status,
    'task.add': membership.add,
    'task.archive': membership.archive,
    'block.ask': blocks.ask,
    'block.create': blocks.create,
    'block.escalate': blocks.escalate,
    'block.answer': blocks.answer,
    'block.unblock': blocks.unblock,
    'comment.add': blocks.add,
    'comment.edit': blocks.edit,
    'inbox.ack': blocks.ack,
  };
}
