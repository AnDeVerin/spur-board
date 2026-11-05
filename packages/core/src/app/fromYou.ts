import { sessionFactsSchema, type Config } from '@spur-board/contracts';
import { z } from 'zod';
import { sql } from 'kysely';
import { evaluateSessionHealth } from '../domain/health.ts';
import { fingerprint, orderItems, type ItemCandidate } from '../domain/fromYou.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Trx } from './board-utils.ts';
import { taskUrl } from './doorbells.ts';
import { clearItem, raiseItem } from './feed.ts';

const episodeSchema = z.object({ startedAt: z.number() }).nullable();

/** Reconciles every item in the caller's observation or tick transaction. */
export async function reconcileItems(
  trx: Trx,
  config: Config,
  now: number,
  spurComplete: boolean,
): Promise<void> {
  const candidates: ItemCandidate[] = [];
  const sources = await trx.selectFrom('source_state').selectAll().execute();
  const sourceById = new Map(sources.map((state) => [state.source, state]));
  for (const source of sources) {
    if (source.blind_reason === null) continue;
    candidates.push({
      key: `source:${source.source}`,
      taskId: null,
      summary: `${source.source}: ${source.blind_message ?? source.blind_reason}`,
      factAt: source.observed_at,
      source: source.source,
      priority: source.blind_reason === 'auth' || source.blind_reason === 'config' ? 2 : 4,
    });
  }
  const tasks = await trx
    .selectFrom('task')
    .selectAll()
    .where('membership', '!=', 'archived')
    .execute();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const misses = await trx.selectFrom('source_miss').selectAll().execute();
  for (const miss of misses) {
    if (miss.outcome !== 'not_found' && miss.outcome !== 'no_access' && miss.gone !== 1) continue;
    const ref = JSON.parse(miss.ref) as {
      kind: string;
      key?: string;
      id?: string;
      repo?: string;
      number?: number;
    };
    if (ref.kind === 'pr' && ref.repo !== undefined && ref.number !== undefined) {
      const links = await trx
        .selectFrom('link')
        .select('task_id')
        .where('entity', '=', 'pr')
        .where(sql<boolean>`lower(repo) = ${ref.repo.toLowerCase()}`)
        .where('number', '=', ref.number)
        .execute();
      for (const link of links) {
        const task = taskById.get(link.task_id);
        if (task === undefined) continue;
        candidates.push({
          key: `pr-outcome:${String(task.id)}:${ref.repo}#${String(ref.number)}`,
          taskId: task.id,
          summary: `${task.key}: linked pull request ${miss.outcome ?? 'gone'}`,
          factAt: sourceById.get(miss.source)?.observed_at ?? null,
          source: miss.source,
          priority: 4,
        });
      }
      continue;
    }
    if (ref.kind !== 'ticket') continue;
    const task = tasks.find(
      (entry) =>
        entry.key === ref.key &&
        (entry.manual_include === 1 || miss.outcome === 'no_access' || miss.gone === 1),
    );
    if (task === undefined) continue;
    candidates.push({
      key: `lookup:${String(task.id)}`,
      taskId: task.id,
      summary: `${task.key}: tracker returned ${miss.outcome ?? 'gone'}`,
      factAt: sourceById.get(miss.source)?.observed_at ?? null,
      source: miss.source,
      priority: 4,
    });
  }
  for (const task of tasks) {
    if (task.membership === 'out_of_filter')
      candidates.push({
        key: `filter:${String(task.id)}`,
        taskId: task.id,
        summary: `${task.key} left the tracker filter while work is still linked`,
        factAt: task.last_change_at,
        source: null,
        priority: 4,
      });
  }
  const blocks = await trx.selectFrom('block').selectAll().where('state', '=', 'open').execute();
  const blockedRoots = await trx
    .selectFrom('operator_item')
    .select('block_id')
    .where('kind', '=', 'post_blocked')
    .where('source', '=', 'conversation.open')
    .execute();
  const blockedIds = new Set(blockedRoots.map((item) => item.block_id));
  for (const block of blocks) {
    const task = taskById.get(block.task_id);
    if (task === undefined) continue;
    if (
      block.addressee_role === 'operator' &&
      block.author !== 'operator' &&
      !blockedIds.has(block.id)
    )
      candidates.push({
        key: `operator-block:${String(block.id)}`,
        taskId: task.id,
        summary: `${task.key}: ${block.reason}`,
        factAt: block.created_at,
        source: null,
        priority: 0,
      });
    if (now - Date.parse(block.created_at) >= config.thresholds.blockOpenMs)
      candidates.push({
        key: `block:${String(block.id)}`,
        taskId: task.id,
        summary: `${task.key}: block has been open for more than a day`,
        factAt: block.created_at,
        source: null,
        priority: 3,
      });
  }
  const failedDeliveries = await trx
    .selectFrom('outbox')
    .select(['id', 'kind'])
    .where('state', '=', 'post_failed')
    .execute();
  for (const delivery of failedDeliveries)
    candidates.push({
      key: `delivery:${String(delivery.id)}`,
      taskId: null,
      summary: `Delivery failed: ${delivery.kind}`,
      factAt: null,
      source: null,
      priority: 1,
      suppressFeed: delivery.kind === 'feed.line' || delivery.kind === 'feed.line.edit',
    });
  const sessionLinks = await trx
    .selectFrom('link')
    .innerJoin('session_snapshot', 'session_snapshot.id', 'link.session_id')
    .select(['link.task_id', 'link.role', 'session_snapshot.detail'])
    .where('link.entity', '=', 'session')
    .where('link.banned', '=', 0)
    .execute();
  const subjects = sessionLinks.flatMap((link) => {
    if (link.role === null || !taskById.has(link.task_id)) return [];
    const fact = parseJson(sessionFactsSchema, link.detail);
    return [{ ...fact, taskId: String(link.task_id), role: link.role }];
  });
  const prs = await trx
    .selectFrom('link')
    .leftJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select(['link.task_id', 'pr_snapshot.state'])
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .execute();
  const taskPrs: Record<string, { hasOpenPr: boolean; hasMergedPr: boolean }> = {};
  for (const task of tasks) taskPrs[String(task.id)] = { hasOpenPr: false, hasMergedPr: false };
  for (const pr of prs) {
    const state = taskPrs[String(pr.task_id)];
    if (state === undefined) continue;
    if (pr.state === 'open') state.hasOpenPr = true;
    if (pr.state === 'merged') state.hasMergedPr = true;
  }
  const previousEpisode = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'host_load_episode')
    .executeTakeFirst();
  const spur = sourceById.get('spur');
  const health = evaluateSessionHealth({
    sessions: subjects,
    tasks: taskPrs,
    spur: {
      blind: spur?.blind_reason !== null && spur !== undefined,
      observationComplete: spurComplete,
    },
    config: config.health,
    now,
    episode: previousEpisode === undefined ? null : parseJson(episodeSchema, previousEpisode.value),
  });
  await trx
    .insertInto('meta')
    .values({ key: 'host_load_episode', value: toJson(episodeSchema, health.episode) })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: toJson(episodeSchema, health.episode) }),
    )
    .execute();
  if (health.hostLoad !== null)
    candidates.push({
      key: 'host-load',
      taskId: null,
      summary: 'Host under load',
      factAt: health.episode === null ? null : new Date(health.episode.startedAt).toISOString(),
      source: 'spur',
      priority: 4,
      revision: health.episode === null ? null : String(health.episode.startedAt),
    });
  for (const flag of health.flags) {
    const task = taskById.get(Number(flag.taskId));
    if (task === undefined) continue;
    const fact = subjects.find(
      (subject) => subject.taskId === flag.taskId && subject.id === flag.sessionId,
    );
    candidates.push({
      key: `health:${String(task.id)}:${flag.sessionId}:${flag.kind}`,
      taskId: task.id,
      summary: `${task.key}: ${flag.kind.replaceAll('_', ' ')} (${flag.sessionId})`,
      factAt: fact?.healthSince ?? null,
      source: 'spur',
      priority: 4,
      revision:
        flag.kind === 'worker_vanished' ? (fact?.endedAt ?? null) : (fact?.healthSince ?? null),
    });
  }
  const ordered = orderItems(candidates);
  const seen = new Set(ordered.map((item) => item.key));
  const existing = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('kind', '=', 'board_observation')
    .where('cleared_at', 'is', null)
    .execute();
  for (const item of existing) {
    if (!seen.has(item.item_key)) await clearItem(trx, item.id, new Date(now));
  }
  for (const candidate of ordered) {
    const hash = fingerprint(candidate);
    const old = existing.find((item) => item.item_key === candidate.key);
    const dismissal = await trx
      .selectFrom('dismissal')
      .select('fingerprint')
      .where('item_key', '=', candidate.key)
      .executeTakeFirst();
    if (old !== undefined && (dismissal?.fingerprint === hash || old.fingerprint !== hash))
      await clearItem(trx, old.id, new Date(now));
    if (dismissal?.fingerprint === hash) continue;
    if (old !== undefined && old.fingerprint === hash) {
      if (old.fact_at !== candidate.factAt || old.source !== candidate.source)
        await trx
          .updateTable('operator_item')
          .set({ fact_at: candidate.factAt, source: candidate.source })
          .where('id', '=', old.id)
          .execute();
      continue;
    }
    const task = candidate.taskId === null ? null : taskById.get(candidate.taskId);
    await raiseItem(trx, {
      itemKey: candidate.key,
      kind: 'board_observation',
      text: candidate.summary,
      url: task === null || task === undefined ? 'https://github.com' : taskUrl(task, config),
      taskId: candidate.taskId,
      blockId: null,
      at: new Date(now),
      fingerprint: hash,
      factAt: candidate.factAt,
      source: candidate.source,
      priority: candidate.priority,
      suppressFeed: candidate.suppressFeed ?? false,
    });
  }
}
