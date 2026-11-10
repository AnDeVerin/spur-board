import { OPERATIONS, type ActorId, type Config, type OperationId } from '@spur-board/contracts';
import type { z } from 'zod';
import type { Store } from '../store/store.ts';
import { createApply, CommandError, type Mutation } from './commands.ts';
import { createQuery, type Query } from './queries.ts';

type CatalogEntry = (typeof OPERATIONS)[number];
type MutationId = Extract<CatalogEntry, { kind: 'mutation' }>['id'];
type QueryId = Extract<CatalogEntry, { kind: 'query' }>['id'];
type MutationEntry = Extract<CatalogEntry, { kind: 'mutation' }>;
type QueryEntry = Extract<CatalogEntry, { kind: 'query' }>;

/** One handler per catalog operation; `createOperationRegistry` returns this total map. */
export type OperationHandlers = {
  [Id in OperationId]: Id extends QueryId
    ? Query<Id>
    : Id extends MutationId
      ? Mutation<Id>
      : never;
};

/** What transports accept: a partial map, so `dispatchOperation` answers `not_implemented`. */
export type OperationRegistry = Partial<OperationHandlers>;

/** One app-layer dispatch for local HTTP and gateway interactions. */
export async function dispatchOperation(
  deps: { store: Store; clock: { now(): number }; config: Config; registry: OperationRegistry },
  id: OperationId,
  input: unknown,
  actor: ActorId,
  key?: string,
): Promise<unknown> {
  const operation = OPERATIONS.find((entry) => entry.id === id);
  const handler = deps.registry[id];
  if (operation === undefined || handler === undefined || handler.id !== id) {
    throw new CommandError(
      'not_implemented',
      `Operation ${id} is not available in this daemon build. Ask the operator to update the daemon.`,
    );
  }
  return operation.kind === 'query'
    ? createQuery(deps)(handler as Query<QueryId>, input as z.input<QueryEntry['input']>, actor)
    : createApply(deps)(
        handler as Mutation<MutationId>,
        input as z.input<MutationEntry['input']>,
        actor,
        key,
      );
}
