import {
  buildCatalogSnapshot,
  columnTurnTimings,
  COLUMNS,
  OPERATIONS,
  resolveWebOrigin,
  roleCanUseOperation,
  type Config,
  type PrPoller,
} from '@spur-board/contracts';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import type { z } from 'zod';
import { authorize, projectTarget } from './authorize.ts';
import { createBlockMutations } from './blocks.ts';
import { createColumnsQuery } from './columns.ts';
import { createItemMutations, type ReapplyInbound } from './items.ts';
import { createLinkMutations } from './links.ts';
import { createMembershipMutations } from './membership.ts';
import { createOperatorInbox } from './operator-inbox.ts';
import type { OperationHandlers } from './operations.ts';
import type { Query } from './queries.ts';
import { getStatus } from './status.ts';
import { createTaskQueries, projectTargets, visibleProjects } from './task-queries.ts';
import { tokenListQuery, tokenRevokeMutation } from './tokens.ts';
import { createTurnMutations } from './turn-commands.ts';

const catalog = await buildCatalogSnapshot(OPERATIONS);

/**
 * `<baseUrl>/browse/` of a Jira tracker, without userinfo, query or fragment; null for a tracker
 * whose keys do not append to one prefix, as GitHub Issues.
 */
function ticketBrowseBase(tracker: Config['projects'][number]['tracker']): string | null {
  if (tracker.type !== 'jira') return null;
  const url = new URL(tracker.baseUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/browse/`;
  return url.href;
}

/** Concrete handlers shared by the daemon's HTTP and inbound transports. */
export function createOperationRegistry(deps: {
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
  /** When each source became usable in this daemon run, reported by `status.get` `sources`. */
  healthySince?: ReadonlyMap<string, string>;
  /** Read at operation time: the last cached host sample, or null before the first. */
  hostMetrics?: () => z.output<typeof statusOutputSchema>['host'];
  /** Configured chat gateway kinds, reported by `status.get` `transport`. */
  gateways?: readonly string[];
  /** Read at operation time: inbound is built after the registry and may be absent. */
  reapplyInbound?: () => ReapplyInbound | undefined;
  /** Read at operation time: the adapter runner starts after the registry and may be absent. */
  prPoller?: () => PrPoller['pollPr'] | undefined;
  /** Product version of the running daemon, reported by `status.get` `daemon`. */
  productVersion?: string;
  /** Read at operation time: when the last board tick completed, or null before the first. */
  lastDispatchAt?: () => string | null;
  /**
   * Read at operation time: the origin the bound web listener answers on. Absent means resolve it
   * from config, which knows no origin for `web.port: 0`.
   */
  webOrigin?: () => string | undefined;
}): OperationHandlers {
  const { config, clock, completeSince, gateways } = deps;
  const startedAt = new Date(clock.now()).toISOString();
  const productVersion = deps.productVersion ?? 'unknown';
  const lastDispatchAt = deps.lastDispatchAt ?? (() => null);
  const webOrigin =
    deps.webOrigin ?? (() => (config.web.port === 0 ? undefined : resolveWebOrigin(config.web)));
  const items = createItemMutations(deps);
  const membership = createMembershipMutations(config);
  const links = createLinkMutations(config, { prPoller: deps.prPoller });
  const blocks = createBlockMutations(config);
  const taskQueries = createTaskQueries({
    config,
    clock,
    completeSince,
    prPoller: deps.prPoller,
  });
  const turns = createTurnMutations({ config, prPoller: deps.prPoller, completeSince });
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
  const configGet: Query<'config.get'> = {
    id: 'config.get',
    resolveTargets(_trx, input, actor) {
      return Promise.resolve(projectTargets(config, input.project, actor));
    },
    run(_trx, input, actor) {
      const visible = visibleProjects(config, actor);
      return Promise.resolve({
        projects: config.projects
          .filter(
            (project) =>
              visible.has(project.id) &&
              (input.project === undefined || input.project === project.id),
          )
          .map((project) => ({
            id: project.id,
            columns: project.columns
              .filter((column) => column.enabled)
              .map((column) => {
                const named =
                  column.orchestrator === 'none' || column.orchestrator === 'operator'
                    ? undefined
                    : project.spurProjects.find((spur) => spur.name === column.orchestrator);
                const group = COLUMNS.find((c) => c.id === column.id)?.group ?? null;
                const timings = columnTurnTimings(config, project.id, column.id);
                return {
                  id: column.id,
                  executor: {
                    kind:
                      column.orchestrator === 'operator'
                        ? ('operator' as const)
                        : named?.role === 'curator'
                          ? ('curator' as const)
                          : named !== undefined
                            ? ('orchestrator' as const)
                            : column.id === 'external-review'
                              ? ('dispatcher' as const)
                              : ('worker' as const),
                    name: named?.name ?? null,
                  },
                  ...(group === null ? {} : { group }),
                  ...(timings === null
                    ? {}
                    : {
                        quietTurnAfterMs: timings.quietTurnAfterMs,
                        noRecipientAfterMs: timings.noRecipientAfterMs,
                      }),
                };
              }),
            dispatcher: { mode: project.dispatcher.mode },
            spurProjects: project.spurProjects.map((spur) => ({
              name: spur.name,
              role: spur.role,
              displayName: spur.displayName ?? spur.name,
            })),
            ticketBrowseBase: ticketBrowseBase(project.tracker),
            checksGate: project.checksGate,
          })),
        web: {
          publicOrigin: webOrigin() ?? null,
          spurUiOrigin: config.web.spurUiOrigin ?? null,
        },
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
        {
          store: { db: trx },
          config,
          clock,
          completeSince,
          gateways,
          daemon: { version: productVersion, startedAt, lastDispatchAt: lastDispatchAt() },
          healthySince: deps.healthySince,
          host: deps.hostMetrics?.(),
        },
        {
          project: input.project,
          visibleProjects: visibleProjects(config, actor),
          includeBoardItems:
            authorize([{ grant: 'operator' }], actor, { config, target: { kind: 'missing' } })
              .status === 'allowed',
          operatorProjects: new Set(
            config.projects
              .filter(
                (project) =>
                  authorize([{ grant: 'operator' }], actor, {
                    config,
                    target: projectTarget(project.id),
                  }).status === 'allowed',
              )
              .map((project) => project.id),
          ),
          detail: input.detail,
        },
      );
    },
  };
  return {
    'schema.get': schema,
    'status.get': status,
    'config.get': configGet,
    'columns.describe': createColumnsQuery(config),
    'task.get': taskQueries.get,
    'task.history': taskQueries.history,
    'inbox.get': taskQueries.inbox,
    'inbox.operator': createOperatorInbox({ config, clock }),
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
    'block.followup': blocks.followup,
    'block.unblock': blocks.unblock,
    'comment.add': blocks.add,
    'comment.edit': blocks.edit,
    'inbox.ack': blocks.ack,
    'project.ask': blocks.projectAsk,
    'item.retry': items.retry,
    'item.close': items.close,
    'task.submit': turns.submit,
    'task.return': turns.return,
    'task.move': turns.move,
  };
}
