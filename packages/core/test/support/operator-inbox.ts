import { configSchema, type ActorId } from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import type { Store } from '../../src/index.ts';
import type { Tables } from '../../src/store/schema.ts';

// Fixtures of the operator inbox tests: rows written straight to the store, times before `NOW`.

type Trx = Kysely<Tables>;

const NOW = Date.parse('2026-11-04T08:00:00.000Z');
export const clock = { now: () => NOW };
/** `minutes` before now, ISO 8601. */
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
export const HOUR = 60;

const base = {
  projects: [
    {
      id: 'first',
      tracker: { type: 'github-issues', repo: 'o/first', label: 'board' },
      repos: ['o/first'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'first-worker', role: 'worker' },
        { name: 'first-ops', role: 'operator' },
        { name: 'first-curator', role: 'curator' },
        { name: 'first-orch', role: 'orchestrator' },
      ],
      columns: [
        { id: 'todo', orchestrator: 'none' },
        { id: 'dev', orchestrator: 'none' },
        { id: 'review', orchestrator: 'first-orch' },
        { id: 'done', orchestrator: 'none' },
      ],
    },
    {
      id: 'second',
      tracker: { type: 'github-issues', repo: 'o/second', label: 'board' },
      repos: ['o/second'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'second-worker', role: 'worker' }],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
};
/** `first` has its own operator; the board-wide `hq` serves `second` and the board. */
export const mixed = configSchema.parse({
  ...base,
  spurProjects: [{ name: 'hq', role: 'operator' }],
});
/** No board-wide operator: `first-ops` acts only on `first`; `second` and the board have only the token. */
export const ownOnly = configSchema.parse(base);

export async function task(
  trx: Trx,
  input: { project: string; key: string; membership?: 'active' | 'archived' },
): Promise<number> {
  const row = await trx
    .insertInto('task')
    .values({
      project: input.project,
      tracker_kind: 'github-issues',
      tracker_id: input.key,
      key: input.key,
      membership: input.membership ?? 'active',
      archive_reason: input.membership === 'archived' ? 'manual' : null,
      column: 'dev',
      shadow_column: null,
      created_at: ago(48 * HOUR),
      last_change_at: null,
      terminal_at: null,
      archive_slot_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function item(
  trx: Trx,
  input: {
    key: string;
    kind: string;
    text?: string;
    url?: string;
    taskId?: number | null;
    blockId?: number | null;
    raisedAt?: string;
    clearedAt?: string | null;
    raiseNo?: number;
    /** The inbound event stored for a retry. */
    inboundEvent?: object;
  },
): Promise<string> {
  const row = await trx
    .insertInto('operator_item')
    .values({
      item_key: input.key,
      raise_no: input.raiseNo ?? 1,
      kind: input.kind,
      text: input.text ?? `${input.kind} happened`,
      url: input.url ?? '',
      task_id: input.taskId ?? null,
      block_id: input.blockId ?? null,
      raised_at: input.raisedAt ?? ago(3 * HOUR),
      cleared_at: input.clearedAt ?? null,
      line_outbox_id: null,
      inbound_event_json:
        input.inboundEvent === undefined ? null : JSON.stringify(input.inboundEvent),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return `I${String(row.id)}`;
}

export async function block(
  trx: Trx,
  input: {
    taskId?: number | null;
    project?: string | null;
    addressee?: 'operator' | 'worker';
    addresseeSpurProject?: string | null;
    author?: string;
    reason?: string;
    createdAt?: string;
    unblockedAt?: string | null;
  },
): Promise<number> {
  const closed = input.unblockedAt !== undefined && input.unblockedAt !== null;
  const row = await trx
    .insertInto('block')
    .values({
      task_id: input.taskId ?? null,
      project: input.project ?? null,
      type: 'needs_input',
      reason: input.reason ?? 'Which API version?',
      author: (input.author ?? 'agent:first-worker/s1') as ActorId,
      addressee_role: input.addressee ?? 'operator',
      addressee_spur_project: input.addresseeSpurProject ?? null,
      target_column: null,
      state: closed ? 'unblocked' : 'open',
      outcome: closed ? 'reason' : null,
      outcome_reason: null,
      repeat_of: null,
      unblocked_by: closed ? 'operator' : null,
      unblocked_at: input.unblockedAt ?? null,
      created_at: input.createdAt ?? ago(2 * HOUR),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function turn(
  trx: Trx,
  input: {
    taskId: number;
    role?: 'operator' | 'worker';
    reason?: string;
    createdAt?: string;
    closedAt?: string | null;
    seq?: number;
  },
): Promise<string> {
  const closedAt = input.closedAt ?? null;
  const row = await trx
    .insertInto('turn')
    .values({
      task_id: input.taskId,
      column: 'ready-to-merge',
      epoch: 1,
      seq: input.seq ?? 1,
      role: input.role ?? 'operator',
      reason: input.reason ?? 'The pull request is ready to merge.',
      handed: '[]',
      acked_by: null,
      acked_at: null,
      closed_at: closedAt,
      closed_reason: closedAt === null ? null : 'moved',
      created_at: input.createdAt ?? ago(4 * HOUR),
      head_sha: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return `T${String(row.id)}`;
}

export async function failedPost(
  trx: Trx,
  input: {
    kind: string;
    payload: object;
    dedupeKey?: string;
    raisedAt?: string;
    externalRef?: string;
    parentId?: number;
    clearedAt?: string;
  },
): Promise<string> {
  const row = await trx
    .insertInto('outbox')
    .values({
      kind: input.kind,
      dedupe_key: input.dedupeKey ?? `${input.kind}:${JSON.stringify(input.payload)}`,
      payload: JSON.stringify(input.payload),
      state: 'post_failed',
      next_at: ago(0),
      last_error: 'gateway refused',
      external_ref: input.externalRef ?? null,
      parent_outbox_id: input.parentId ?? null,
      first_attempt_at: null,
      first_delivery_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return item(trx, {
    key: `delivery:${String(row.id)}`,
    kind: 'post_failed',
    text: `Delivery failed: ${input.kind}`,
    ...(input.clearedAt === undefined ? {} : { clearedAt: input.clearedAt }),
    ...(input.raisedAt === undefined ? {} : { raisedAt: input.raisedAt }),
  });
}

export async function notification(trx: Trx, taskId: number, blockId: number): Promise<number> {
  const row = await trx
    .insertInto('notification')
    .values({
      source_key: `block:${String(blockId)}:worker`,
      kind: 'block',
      task_id: taskId,
      block_id: blockId,
      role: 'worker',
      next_at: ago(0),
      created_at: ago(0),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function sourceState(
  trx: Trx,
  source: string,
  blind: { reason: string; message: string | null } | null,
): Promise<void> {
  await trx
    .insertInto('source_state')
    .values({
      source,
      last_complete_at: null,
      blind_reason: blind?.reason ?? null,
      blind_message: blind?.message ?? null,
      cursor: null,
      observed_at: null,
      budget_remaining: null,
      budget_limit: null,
      budget_reset_at: null,
    })
    .execute();
}

/**
 * Writes `from..to` sets of every entry source: items open and cleared, operator blocks open and
 * closed, an agent block with its board item, operator turns open and closed, failed deliveries
 * owned through the payload, a notification and a comment, and a blind source.
 */
export async function seedEveryKind(store: Store, from: number, to: number): Promise<void> {
  await store.transaction(async (trx) => {
    for (let n = from; n <= to; n += 1) {
      const project = n % 2 === 0 ? 'first' : 'second';
      const own = await task(trx, { project, key: `o/${project}#${String(n)}` });
      const other = await task(trx, { project, key: `o/${project}#${String(n + 1000)}` });
      await item(trx, { key: `inbound:${String(n)}`, kind: 'inbound_failure', taskId: own });
      await item(trx, {
        key: `inbound:${String(n)}:old`,
        kind: 'inbound_failure',
        taskId: own,
        clearedAt: ago(HOUR),
      });
      const operatorBlock = await block(trx, { taskId: own });
      await block(trx, { taskId: own, unblockedAt: ago(HOUR) });
      const agentBlock = await block(trx, { taskId: own, addressee: 'worker' });
      await item(trx, {
        key: `block:${String(agentBlock)}`,
        kind: 'board_observation',
        taskId: own,
      });
      await item(trx, {
        key: `operator-block:${String(operatorBlock)}`,
        kind: 'board_observation',
        taskId: own,
      });
      await turn(trx, { taskId: own });
      await turn(trx, { taskId: other, closedAt: ago(HOUR) });
      await failedPost(trx, { kind: 'conversation.open', payload: { taskId: own } });
      await failedPost(trx, {
        kind: 'doorbell',
        payload: { notificationId: await notification(trx, own, agentBlock) },
      });
      const comment = await trx
        .insertInto('comment')
        .values({
          task_id: own,
          block_id: null,
          author: 'operator',
          text: 'Ping.',
          conversation_ref: null,
          message_ref: null,
          acked_revision: null,
          created_at: ago(0),
          delivery_state: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await failedPost(trx, {
        kind: 'doorbell',
        payload: {},
        dedupeKey: `doorbell:comment:${String(comment.id)}:1`,
      });
      await sourceState(trx, `jira:p${String(n)}`, { reason: 'auth', message: null });
      await item(trx, { key: `source:jira:p${String(n)}`, kind: 'board_observation' });
    }
  });
}
