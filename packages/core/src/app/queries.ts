import {
  OPERATIONS,
  buildCatalogSnapshot,
  errorCodeOf,
  type ActorId,
  type Config,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { CommandError } from './commands.ts';
import { writeDeniedEvent } from './denied-event.ts';

type CatalogQuery = Extract<(typeof OPERATIONS)[number], { kind: 'query' }>;
type SchemaEntry = Extract<CatalogQuery, { id: 'schema.get' }>;
type QueryId = CatalogQuery['id'];
type Entry<Id extends QueryId> = Extract<CatalogQuery, { id: Id }>;

export interface Query<Id extends QueryId> {
  readonly id: Id;
  resolveTargets(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
  ): Promise<readonly ResolvedTarget[]>;
  run(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    actor: ActorId,
  ): Promise<z.input<Entry<Id>['output']>>;
}

export type QueryRun = <Id extends QueryId>(
  query: Query<Id>,
  input: z.input<Entry<Id>['input']>,
  actor: ActorId,
) => Promise<z.output<Entry<Id>['output']>>;

/** Serve the catalog through the same authorization and response path as other queries. */
export function createSchemaQuery(): Query<'schema.get'> {
  const operation = OPERATIONS.find((entry): entry is SchemaEntry => entry.id === 'schema.get');
  if (operation === undefined) throw new Error('schema.get is missing from the catalog.');
  const snapshot = buildCatalogSnapshot(OPERATIONS);
  return {
    id: 'schema.get',
    resolveTargets: () => Promise.resolve([]),
    async run(_trx, input) {
      const catalog = await snapshot;
      const grantsByRole = {
        operator: ['operator'],
        worker: ['project-agent', 'task-worker', 'block-addressee', 'block-author'],
        orchestrator: ['project-agent', 'column-orchestrator', 'block-addressee', 'block-author'],
      } as const;
      const grants: readonly string[] = input.role === undefined ? [] : grantsByRole[input.role];
      return operation.output.parse({
        version: catalog.version,
        operations: catalog.operations
          .filter(
            (operation) =>
              input.role === undefined ||
              operation.grants === 'any' ||
              operation.grants.some((rule) => grants.includes(rule.grant)),
          )
          .map((operation) => ({
            id: operation.id,
            kind: operation.kind,
            description: operation.description,
            grants: operation.grants,
            errors: operation.errors,
            cli: operation.cli,
            mcp: operation.mcp,
            inputSchema: operation.input,
            outputSchema: operation.output,
          })),
      });
    },
  };
}

/** Authorize a catalog query against current state before reading its result. */
export function createQuery(deps: {
  store: Store;
  clock: { now(): number };
  config: Config;
}): QueryRun {
  const { store, clock, config } = deps;
  return async (query, input, actor) => {
    const entry = OPERATIONS.find((candidate) => candidate.id === query.id);
    if (entry?.kind !== 'query') throw new CommandError('usage', 'Use a catalog query.');
    const parsed = entry.input.safeParse(input);
    if (!parsed.success)
      throw new CommandError(errorCodeOf(parsed.error), 'Fix the operation input.');
    const parsedInput = parsed.data as z.output<Entry<typeof query.id>['input']>;
    const result = await store.transaction(async (trx) => {
      const targets = await query.resolveTargets(trx, parsedInput);
      for (const target of targets.length === 0 ? [{ kind: 'missing' as const }] : targets) {
        const decision = authorize(entry.grants, actor, { config, target });
        if (decision.status === 'denied') {
          await writeDeniedEvent(trx, actor, entry.id, target, new Date(clock.now()).toISOString());
          return { status: 'denied' as const, hint: decision.hint };
        }
      }
      if (targets.some((target) => target.kind === 'missing')) {
        throw new CommandError('not_found', 'Check the target ID.');
      }
      if (targets.length === 0 && entry.grants !== 'any') {
        throw new CommandError('not_found', 'Resolve an authorization target before reading.');
      }
      const value = await query.run(trx, parsedInput, actor);
      return { status: 'done' as const, value: entry.output.parse(value) };
    });
    if (result.status === 'denied') throw new CommandError('forbidden', result.hint);
    return result.value as z.output<Entry<typeof query.id>['output']>;
  };
}
