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

export interface CommandContext {
  readonly actor: ActorId;
  readonly at: string;
}

/** A handler names a catalog mutation; the boundary owns its schemas and grants. */
export interface Mutation<Id extends MutationId> {
  readonly id: Id;
  resolveTargets(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    actor: ActorId,
  ): Promise<readonly ResolvedTarget[]>;
  run(
    trx: Kysely<Tables>,
    input: z.output<Entry<Id>['input']>,
    ctx: CommandContext,
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
  const row = await trx
    .selectFrom('command')
    .select(['operation', 'fingerprint', 'result'])
    .where('actor', '=', input.actor)
    .where('key', '=', input.key)
    .executeTakeFirst();
  if (row !== undefined) {
    if (row.operation !== input.operation || row.fingerprint !== hash) {
      throw new CommandError('idempotency_key_mismatch', 'Use the original input or a new key.');
    }
    return parseJson(input.output, row.result);
  }
  const value = await input.run();
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
  return async (op, input, actor, key) => {
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
    let deniedHint: string | undefined;
    const at = new Date(clock.now()).toISOString();
    const result = await scanTransaction(store, (trx) =>
      replayOperation(trx, {
        actor,
        key: commandKey,
        operation: entry.id,
        fingerprintInput: input,
        output: entry.output,
        at,
        run: async () => {
          const parsedInput = parsed.data as z.output<Entry<typeof op.id>['input']>;
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
          const mode = 'mode' in parsed.data ? String(parsed.data.mode) : undefined;
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
          return op.run(trx, parsedInput, { actor, at });
        },
      }),
    );
    if (result === undefined) {
      throw new CommandError('forbidden', deniedHint ?? 'Caller is not allowed.');
    }
    return result as z.output<Entry<typeof op.id>['output']>;
  };
}

/**
 * Purges expired command keys once at `start`, then every `DAY_MS`. A failed first purge
 * rejects `start`; a failed daily purge goes to `onError`. `stop` waits for a running purge.
 */
export function commandRetention(deps: {
  store: Store;
  clock: Clock;
  retentionDays: number;
  onError: (err: unknown) => void;
}): { start(): Promise<void>; stop(): Promise<void> } {
  const { store, clock, retentionDays, onError } = deps;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> = Promise.resolve();
  // Deletes rows older than the cutoff; a row exactly at the cutoff stays.
  const run = async () => {
    const cutoff = new Date(clock.now() - retentionDays * DAY_MS).toISOString();
    await scanTransaction(store, async (trx) => {
      await trx.deleteFrom('command').where('at', '<', cutoff).execute();
    });
  };
  return {
    async start() {
      await run();
      timer = setInterval(() => {
        running = run().catch(onError);
      }, DAY_MS);
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
