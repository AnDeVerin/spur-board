import {
  buildCatalogSnapshot,
  OPERATIONS,
  roleCanUseOperation,
  type Config,
} from '@spur-board/contracts';
import { authorize } from './authorize.ts';
import { createBlockMutations } from './blocks.ts';
import { createLinkMutations } from './links.ts';
import { createMembershipMutations } from './membership.ts';
import type { OperationRegistry } from './operations.ts';
import type { Query } from './queries.ts';
import { getStatus } from './status.ts';
import { createTaskQueries, projectTargets, visibleProjects } from './task-queries.ts';
import { tokenListQuery, tokenRevokeMutation } from './tokens.ts';

const catalog = await buildCatalogSnapshot(OPERATIONS);

/** Concrete handlers shared by the daemon's HTTP and inbound transports. */
export function createOperationRegistry(deps: {
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
}): OperationRegistry {
  const { config, clock, completeSince } = deps;
  const membership = createMembershipMutations(config);
  const links = createLinkMutations(config);
  const blocks = createBlockMutations(config);
  const taskQueries = createTaskQueries(config);
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
          .filter((operation) => role === undefined || roleCanUseOperation(operation, role))
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
      return Promise.resolve(projectTargets(config, input.project, actor));
    },
    run(trx, input, actor) {
      return getStatus(
        { store: { db: trx }, config, clock, completeSince },
        input.project,
        visibleProjects(config, actor),
        authorize([{ grant: 'operator' }], actor, { config, target: { kind: 'missing' } })
          .status === 'allowed',
      );
    },
  };
  return {
    'schema.get': schema,
    'status.get': status,
    'task.get': taskQueries.get,
    'task.history': taskQueries.history,
    'inbox.get': taskQueries.inbox,
    'token.list': tokenListQuery(clock),
    'token.revoke': tokenRevokeMutation,
    'task.add': membership.add,
    'task.archive': membership.archive,
    'link.add': links.add,
    'link.remove': links.remove,
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
