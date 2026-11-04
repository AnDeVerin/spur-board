import {
  EVENT_VERSION,
  eventPayloadSchemas,
  parseActorId,
  type ActorId,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toJson } from '../store/json.ts';
import type { Tables } from '../store/schema.ts';
import type { ResolvedTarget } from './authorize.ts';

const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });

/** Persist an authorization refusal through the caller's transaction. */
export async function writeDeniedEvent(
  trx: Kysely<Tables>,
  actor: ActorId,
  operation: string,
  target: ResolvedTarget,
  at: string,
): Promise<void> {
  const parsed = parseActorId(actor);
  if (parsed === null) throw new Error('Invalid actor');
  await trx
    .insertInto('event')
    .values({
      at,
      project: target.kind === 'found' ? target.value.project : 'board',
      task_id: target.kind === 'found' ? (target.value.task?.id ?? null) : null,
      kind: 'operation_denied',
      actor: parsed.actor,
      actor_ref: parsed.actor === 'agent' ? toJson(actorRefSchema, parsed.actorRef) : null,
      payload: toJson(eventPayloadSchemas.operation_denied, {
        operation,
        reason: 'Caller does not match the operation grants.',
      }),
      v: EVENT_VERSION,
      request_id: null,
    })
    .execute();
}
