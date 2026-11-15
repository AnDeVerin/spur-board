import { OPERATIONS, errorCodeOf, type ActorId, type Config } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { CommandError } from './commands.ts';
import { writeDeniedEvent } from './denied-event.ts';

type CatalogQuery = Extract<(typeof OPERATIONS)[number], { kind: 'query' }>;
type QueryId = CatalogQuery['id'];
type Entry<Id extends QueryId> = Extract<CatalogQuery, { id: Id }>;

export interface Query<Id extends QueryId> {
  readonly id: Id;
  resolveTargets(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    actor: ActorId,
  ): Promise<readonly ResolvedTarget[]>;
  /** Runs after authorization and outside the transaction; final reading reauthorizes. */
  prepare?(db: Kysely<Tables>, input: z.output<Entry<Id>['input']>, actor: ActorId): Promise<void>;
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
    const read = (prepare: boolean) =>
      store.transaction(async (trx) => {
        const targets = await query.resolveTargets(trx, parsedInput, actor);
        for (const target of targets.length === 0 ? [{ kind: 'missing' as const }] : targets) {
          const decision = authorize(entry.grants, actor, { config, target });
          if (decision.status === 'denied') {
            await writeDeniedEvent(trx, {
              config,
              actor,
              operation: entry.id,
              input: parsedInput,
              target,
              at: new Date(clock.now()).toISOString(),
            });
            return { status: 'denied' as const, hint: decision.hint };
          }
        }
        if (targets.some((target) => target.kind === 'missing')) {
          throw new CommandError('not_found', 'Check the target ID.');
        }
        if (targets.length === 0 && entry.grants !== 'any' && entry.id !== 'token.list') {
          throw new CommandError('not_found', 'Resolve an authorization target before reading.');
        }
        if (prepare) return { status: 'prepared' as const };
        const value = await query.run(trx, parsedInput, actor);
        return { status: 'done' as const, value: entry.output.parse(value) };
      });
    if (query.prepare !== undefined) {
      const preflight = await read(true);
      if (preflight.status === 'denied') throw new CommandError('forbidden', preflight.hint);
      await query.prepare(store.db, parsedInput, actor);
    }
    const result = await read(false);
    if (result.status === 'prepared') throw new Error('Query result was not read');
    if (result.status === 'denied') throw new CommandError('forbidden', result.hint);
    return result.value as z.output<Entry<typeof query.id>['output']>;
  };
}
