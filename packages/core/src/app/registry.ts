import {
  buildCatalogSnapshot,
  OPERATIONS,
  type ActorId,
  type Config,
  type Grant,
} from '@spur-board/contracts';
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

const ROLE_GRANTS: Record<'operator' | 'worker' | 'orchestrator', ReadonlySet<Grant>> = {
  operator: new Set(['operator', 'block-addressee', 'block-author']),
  worker: new Set(['project-agent', 'task-worker', 'block-addressee', 'block-author']),
  orchestrator: new Set([
    'project-agent',
    'column-orchestrator',
    'block-addressee',
    'block-author',
  ]),
};
const catalog = await buildCatalogSnapshot(OPERATIONS);

/** Concrete handlers shared by the daemon's HTTP and inbound transports. */
export function createOperationRegistry(deps: {
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
}): OperationRegistry {
  const { config, clock, completeSince } = deps;
  const membership = createMembershipMutations(config);
  const blocks = createBlockMutations(config);
  const schema: Query<'schema.get'> = {
    id: 'schema.get',
    resolveTargets() {
      return Promise.resolve([]);
    },
    run(_trx, input) {
      const role = input.role;
      return Promise.resolve({
        version: catalog.version,
        operations: catalog.operations
          .filter(
            (operation) =>
              role === undefined ||
              operation.grants === 'any' ||
              operation.grants.some((rule) => ROLE_GRANTS[role].has(rule.grant)),
          )
          .map((operation) => ({
            id: operation.id,
            kind: operation.kind,
            description: operation.description,
            grants:
              operation.grants === 'any'
                ? ('any' as const)
                : operation.grants.map((rule) => ({
                    grant: rule.grant,
                    ...(rule.mode === undefined ? {} : { mode: rule.mode }),
                    ...(rule.blockTypes === undefined ? {} : { blockTypes: [...rule.blockTypes] }),
                  })),
            errors: [...operation.errors],
            cli: {
              ...operation.cli,
              args: [...operation.cli.args],
              modes: operation.cli.modes?.map((mode) => ({ ...mode })) ?? null,
            },
            mcp: { ...operation.mcp },
            inputSchema: operation.input,
            outputSchema: operation.output,
          })),
      });
    },
  };
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
    'schema.get': schema,
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
