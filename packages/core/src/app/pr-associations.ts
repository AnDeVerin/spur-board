import {
  prFactsSchema,
  prSourceId,
  type Config,
  type PrEntityRef,
  type PrFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Row } from '../store/schema.ts';
import { parseJson, toJson } from '../store/json.ts';
import { emit, type Trx } from './board-utils.ts';

// A shared snapshot stores the latest facts; each source must first apply its own project links.
const prPollingSchema = z.strictObject({
  state: z.enum(['merged', 'closed']),
  headSha: prFactsSchema.shape.headSha,
  recheckAt: z.iso.datetime().nullable(),
  ticketKeys: prFactsSchema.shape.ticketKeys.optional(),
});
export const prPollingKey = (source: string, ref: PrEntityRef): string =>
  `pr-poll:${source}:pr:${ref.repo.toLowerCase()}#${String(ref.number)}`;
export function readPrPolling(
  value: string | undefined,
): z.output<typeof prPollingSchema> | undefined {
  if (value === undefined) return;
  try {
    const parsed = prPollingSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
export async function savePrPolling(
  trx: Trx,
  source: string,
  fact: Pick<PrFacts, 'repo' | 'number' | 'state' | 'headSha'> &
    Partial<Pick<PrFacts, 'ticketKeys'>>,
  recheckAt: string | null,
  preserve = false,
): Promise<void> {
  const key = prPollingKey(source, { kind: 'pr', repo: fact.repo, number: fact.number });
  if (fact.state !== 'merged' && fact.state !== 'closed') {
    await trx.deleteFrom('meta').where('key', '=', key).execute();
    return;
  }
  if (preserve) {
    const saved = await trx
      .selectFrom('meta')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    const previous = readPrPolling(saved?.value);
    if (previous !== undefined) {
      if (
        previous.ticketKeys === undefined &&
        previous.state === fact.state &&
        previous.headSha === fact.headSha &&
        fact.ticketKeys !== undefined
      )
        await trx
          .updateTable('meta')
          .set({ value: toJson(prPollingSchema, { ...previous, ticketKeys: fact.ticketKeys }) })
          .where('key', '=', key)
          .execute();
      return;
    }
  }
  const value = toJson(prPollingSchema, {
    state: fact.state,
    headSha: fact.headSha,
    recheckAt,
    ticketKeys: fact.ticketKeys,
  });
  await trx
    .insertInto('meta')
    .values({ key, value })
    .onConflict((oc) =>
      preserve ? oc.column('key').doNothing() : oc.column('key').doUpdateSet({ value }),
    )
    .execute();
}

/** The PR was merged before the reopen; a tie counts the merge. */
export function mergedBefore(fact: PrFacts, reopenedAt: string | null): boolean {
  return (
    fact.state === 'merged' &&
    reopenedAt !== null &&
    Date.parse(fact.mergedAt ?? fact.updatedAt) < Date.parse(reopenedAt)
  );
}

export async function linkPrToTask(
  trx: Trx,
  task: Row<'task'>,
  fact: PrFacts,
  at: string,
): Promise<void> {
  const linked = await trx
    .selectFrom('link')
    .selectAll()
    .where('task_id', '=', task.id)
    .where('entity', '=', 'pr')
    .where(sql<boolean>`lower(repo) = ${fact.repo.toLowerCase()}`)
    .where('number', '=', fact.number)
    .executeTakeFirst();
  if (linked === undefined) {
    const active = await trx
      .selectFrom('link')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('entity', '=', 'pr')
      .where('pr_state', '=', 'active')
      .where('banned', '=', 0)
      .where('pr_open', '=', 1)
      .executeTakeFirst();
    const state = fact.state !== 'open' || active === undefined ? 'active' : 'conflict';
    await trx
      .insertInto('link')
      .values({
        task_id: task.id,
        entity: 'pr',
        repo: fact.repo,
        number: fact.number,
        pr_state: state,
        session_id: null,
        role: null,
        source: 'branch',
        banned: 0,
        created_at: at,
        ticket_key: null,
        pr_open: fact.state === 'open' ? 1 : 0,
        // First seen merged after a reopen it predates: hidden like the links the reopen hid.
        reopen_hidden_at: mergedBefore(fact, task.reopened_at) ? at : null,
      })
      .execute();
    await emit(trx, 'link_added', task.project, task.id, at, {
      entity: 'pr',
      repo: fact.repo,
      pr: fact.number,
      state,
      source: 'branch',
      facts: fact,
    });
  }
}

/** Reuse locally observed source associations when a task arrives after its PR. */
export async function reconcileTaskPrs(
  trx: Trx,
  config: Config,
  taskId: number,
  at: string,
): Promise<void> {
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  if (task.membership === 'archived' || task.manual_exclude === 1) return;
  const project = config.projects.find((entry) => entry.id === task.project);
  if (project === undefined) return;
  const snapshots = await trx.selectFrom('pr_snapshot').selectAll().execute();
  for (const row of snapshots) {
    const repo = project.repos.find((repo) => repo.toLowerCase() === row.repo.toLowerCase());
    if (repo === undefined) continue;
    const fact = parseJson(prFactsSchema, row.detail);
    const source = prSourceId(project.id, repo);
    const saved = await trx
      .selectFrom('meta')
      .select('value')
      .where('key', '=', prPollingKey(source, { kind: 'pr', repo: row.repo, number: row.number }))
      .executeTakeFirst();
    const processed = readPrPolling(saved?.value);
    const keys =
      row.source === source
        ? fact.ticketKeys
        : processed?.state === fact.state && processed.headSha === fact.headSha
          ? processed.ticketKeys
          : undefined;
    if (keys?.includes(task.key)) await linkPrToTask(trx, task, { ...fact, ticketKeys: keys }, at);
  }
}
