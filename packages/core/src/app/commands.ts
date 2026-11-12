import { scanTransaction } from './secrets.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  OPERATIONS,
  errorCodeOf,
  type ActorId,
  type Config,
  type ServerErrorCode,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';
import { withCommandKey } from './board-utils.ts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { writeDeniedEvent } from './denied-event.ts';

const DAY_MS = 86_400_000;
const TASKLESS = ['task.add', 'item.retry', 'item.close', 'token.revoke'] as const;
type CatalogMutation = Extract<(typeof OPERATIONS)[number], { kind: 'mutation' }>;
type MutationId = CatalogMutation['id'];
type Entry<Id extends MutationId> = Extract<CatalogMutation, { id: Id }>;

interface Clock {
  now(): number;
}

export class CommandError extends Error {
  readonly code: ServerErrorCode;
  readonly hint: string;
  constructor(code: ServerErrorCode, hint: string) {
    super(code);
    this.code = code;
    this.hint = hint;
  }
}

export interface CommandContext<Prepared = unknown> {
  readonly actor: ActorId;
  readonly at: string;
  /** What the handler's `prepare` returned; absent when it has none or it did not run. */
  readonly prepared?: Prepared | undefined;
}

/** A handler names a catalog mutation; the boundary owns its schemas and grants. */
export interface Mutation<Id extends MutationId, Prepared = unknown> {
  readonly id: Id;
  resolveTargets(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    actor: ActorId,
  ): Promise<readonly ResolvedTarget[]>;
  /**
   * Reads an external source before the transaction, never writes. Runs after the input and key
   * checks, only for a key with no stored command and when every resolved target is allowed; its
   * result is `ctx.prepared`.
   */
  prepare?(
    db: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    actor: ActorId,
  ): Promise<Prepared>;
  run(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    ctx: CommandContext<Prepared>,
  ): Promise<z.input<Entry<Id>['output']>>;
}

export type Apply = <Id extends MutationId>(
  op: Mutation<Id>,
  input: z.input<Entry<Id>['input']>,
  actor: ActorId,
  key?: string,
) => Promise<z.output<Entry<Id>['output']>>;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function fingerprint(id: string, input: unknown, actor: ActorId): string {
  return createHash('sha256')
    .update(canonical([id, input, actor]))
    .digest('hex');
}

function storedCommand(db: Kysely<Tables>, actor: ActorId, key: string) {
  return db
    .selectFrom('command')
    .select(['operation', 'fingerprint', 'result'])
    .where('actor', '=', actor)
    .where('key', '=', key)
    .executeTakeFirst();
}

/**
 * In-flight same-key calls per store. Keyed by the store, not the `createApply` closure:
 * `dispatchOperation` builds a new `createApply` for every request.
 */
const IN_FLIGHT = new WeakMap<Store, Map<string, Promise<unknown>>>();

/** Runs `fn` after any in-flight call on `slot` settles, so one key never runs twice at once. */
async function serialized<T>(
  inFlight: Map<string, Promise<unknown>>,
  slot: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let busy = inFlight.get(slot); busy !== undefined; busy = inFlight.get(slot)) {
    await busy.catch(() => undefined);
  }
  const call = fn();
  inFlight.set(slot, call);
  try {
    return await call;
  } finally {
    if (inFlight.get(slot) === call) inFlight.delete(slot);
  }
}

/**
 * Replays one operation within the caller's transaction. Returning undefined from run leaves
 * no command row; catalog authorization uses that path so a denial remains journal-only.
 */
export async function replayOperation<Output extends z.ZodType>(
  trx: Kysely<Tables>,
  input: {
    actor: ActorId;
    key: string;
    operation: string;
    fingerprintInput: unknown;
    output: Output;
    at: string;
    run: () => Promise<z.input<Output> | undefined>;
  },
): Promise<z.output<Output> | undefined> {
  const hash = fingerprint(input.operation, input.fingerprintInput, input.actor);
  const row = await storedCommand(trx, input.actor, input.key);
  if (row !== undefined) {
    if (row.operation !== input.operation || row.fingerprint !== hash) {
      throw new CommandError('idempotency_key_mismatch', 'Use the original input or a new key.');
    }
    return parseJson(input.output, row.result);
  }
  const value = await withCommandKey(input.key, input.run);
  if (value === undefined) return undefined;
  const resultText = toJson(input.output, value);
  await trx
    .insertInto('command')
    .values({
      actor: input.actor,
      key: input.key,
      operation: input.operation,
      fingerprint: hash,
      result: resultText,
      at: input.at,
    })
    .execute();
  return parseJson(input.output, resultText);
}

function catalogMutation(id: string): CatalogMutation {
  const entry = OPERATIONS.find((candidate) => candidate.id === id);
  if (entry?.kind !== 'mutation') throw new CommandError('usage', 'Use a catalog mutation.');
  return entry;
}

function emptyAllowed(entry: CatalogMutation): boolean {
  if (!TASKLESS.some((id) => id === entry.id)) return false;
  if (entry.grants === 'any' || entry.grants.some((rule) => rule.grant !== 'operator')) {
    throw new Error(`Taskless operation ${entry.id} must remain operator-only`);
  }
  return true;
}

/** Parse, replay, authorize, then apply one catalog mutation in one transaction. */
export function createApply(deps: { store: Store; clock: Clock; config: Config }): Apply {
  const { store, clock, config } = deps;
  const inFlight = IN_FLIGHT.get(store) ?? new Map<string, Promise<unknown>>();
  IN_FLIGHT.set(store, inFlight);
  const apply: Apply = async (op, input, actor, key) => {
    const entry = catalogMutation(op.id);
    const parsed = entry.input.safeParse(input);
    if (!parsed.success)
      throw new CommandError(errorCodeOf(parsed.error), 'Fix the operation input.');
    if (key === '' || (actor !== 'operator' && key === undefined)) {
      throw new CommandError(
        'usage',
        'Choose an idempotency key before sending an agent mutation.',
      );
    }
    const commandKey = key ?? randomUUID();
    const parsedInput = parsed.data as z.output<Entry<typeof op.id>['input']>;
    const mode = 'mode' in parsed.data ? parsed.data.mode : undefined;
    // A read-only pass outside the transaction: `prepare` runs only for a new key and a call
    // every target allows. A stored key skips it, and the transaction's replay returns the stored
    // result or refuses the mismatch. The transaction authorizes again and journals a denial.
    let prepared: unknown;
    if (
      op.prepare !== undefined &&
      (await storedCommand(store.db, actor, commandKey)) === undefined
    ) {
      const targets = await op.resolveTargets(store.db, parsedInput, actor);
      const allowed =
        targets.length > 0 &&
        targets.every(
          (target) =>
            authorize(entry.grants, actor, {
              config,
              target,
              ...(mode === undefined ? {} : { mode }),
            }).status === 'allowed',
        );
      if (allowed) prepared = await op.prepare(store.db, parsedInput, actor);
    }
    let deniedHint: string | undefined;
    const at = new Date(clock.now()).toISOString();
    const result = await scanTransaction(store, config, (trx) =>
      replayOperation(trx, {
        actor,
        key: commandKey,
        operation: entry.id,
        fingerprintInput: input,
        output: entry.output,
        at,
        run: async () => {
          const resolved = await op.resolveTargets(trx, parsedInput, actor);
          const taskless = resolved.length === 0 && emptyAllowed(entry);
          const ackIds =
            entry.id === 'inbox.ack' && 'entries' in parsed.data
              ? parsed.data.entries.map((item) => item.id)
              : undefined;
          const ackMismatch =
            ackIds !== undefined &&
            (resolved.length !== ackIds.length ||
              resolved.some((target, index) => target.id !== ackIds[index]));
          const targets: readonly ResolvedTarget[] =
            resolved.length === 0
              ? [{ kind: 'missing' }]
              : ackMismatch
                ? [...resolved, { kind: 'missing' }]
                : resolved;
          for (const target of targets) {
            const decision = authorize(entry.grants, actor, {
              config,
              target,
              ...(mode === undefined ? {} : { mode }),
            });
            if (decision.status === 'denied') {
              await writeDeniedEvent(trx, {
                config,
                actor,
                operation: entry.id,
                input: parsedInput,
                target,
                at,
              });
              deniedHint = decision.hint;
              return undefined;
            }
          }
          if (!taskless && targets.some((target) => target.kind === 'missing')) {
            throw new CommandError('not_found', 'Check the target ID.');
          }
          return op.run(
            trx,
            parsedInput,
            op.prepare === undefined ? { actor, at } : { actor, at, prepared },
          );
        },
      }),
    );
    if (result === undefined) {
      throw new CommandError('forbidden', deniedHint ?? 'Caller is not allowed.');
    }
    return result as z.output<Entry<typeof op.id>['output']>;
  };
  // A same-key call on this store waits for the one in flight, then replays its result instead
  // of polling.
  return (op, input, actor, key) =>
    op.prepare === undefined || key === undefined
      ? apply(op, input, actor, key)
      : serialized(inFlight, `${actor}\0${key}`, () => apply(op, input, actor, key));
}

/** Deletes command keys older than `retentionDays`; a key exactly at the cutoff stays. */
export async function purgeExpiredCommands(
  store: Store,
  clock: Clock,
  retentionDays: number,
): Promise<void> {
  const cutoff = new Date(clock.now() - retentionDays * DAY_MS).toISOString();
  await store.transaction(async (trx) => {
    await trx.deleteFrom('command').where('at', '<', cutoff).execute();
  });
}
