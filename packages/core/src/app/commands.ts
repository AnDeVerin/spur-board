import type { ActorId } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import { parseJson, toJson } from '../store/json.ts';
import type { Tables } from '../store/schema.ts';
import type { Store } from '../store/store.ts';

const DAY_MS = 86_400_000;

interface Clock {
  now(): number;
}

/** Who runs a command and when; `at` is the ISO-8601 UTC time read inside the transaction. */
export interface CommandContext {
  readonly actor: ActorId;
  readonly at: string;
}

/**
 * A mutation `apply` can run. `id`, `kind` and `output` match a catalog entry, so a handler
 * is the entry spread with its `run`. `run` writes only through `trx` and does no IO.
 */
export interface Mutation<O extends z.ZodType, I> {
  readonly id: string;
  readonly kind: 'mutation';
  readonly output: O;
  run(trx: Kysely<Tables>, input: I, ctx: CommandContext): Promise<z.input<O>>;
}

export type Apply = <O extends z.ZodType, I>(
  op: Mutation<O, I>,
  input: I,
  actor: ActorId,
  key: string,
) => Promise<z.output<O>>;

/**
 * Builds `apply`. In one transaction it looks up `(actor, key)` in `command`: a hit returns
 * the stored result and writes nothing; a miss runs `op` and stores its result. A rejection
 * from `run` rolls back the effect and stores no key, so a retry is evaluated again.
 */
export function createApply(deps: { store: Store; clock: Clock }): Apply {
  const { store, clock } = deps;
  return (op, input, actor, key) =>
    store.transaction(async (trx) => {
      const at = new Date(clock.now()).toISOString();
      const row = await trx
        .selectFrom('command')
        .select('result')
        .where('actor', '=', actor)
        .where('key', '=', key)
        .executeTakeFirst();
      if (row !== undefined) return parseJson(op.output, row.result);
      const value = await op.run(trx, input, { actor, at });
      const text = toJson(op.output, value);
      await trx
        .insertInto('command')
        .values({ actor, key, operation: op.id, fingerprint: null, result: text, at })
        .execute();
      return parseJson(op.output, text);
    });
}

/** Deletes `command` rows older than `days` before `now`; a row exactly at the cutoff stays. */
async function purge(store: Store, now: number, days: number): Promise<void> {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  await store.transaction(async (trx) => {
    await trx.deleteFrom('command').where('at', '<', cutoff).execute();
  });
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
  const run = () => purge(store, clock.now(), retentionDays);
  return {
    async start() {
      await run();
      timer = setInterval(() => {
        running = run().catch(onError);
      }, DAY_MS);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
