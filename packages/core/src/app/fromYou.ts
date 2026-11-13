import {
  parseActorId,
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  type ColumnId,
  type Config,
} from '@spur-board/contracts';
import { z } from 'zod';
import { sql } from 'kysely';
import {
  evaluateSessionHealth,
  type SessionHealthFlag,
  type SessionHealthFlagKind,
} from '../domain/health.ts';
import {
  BLOCK_ITEM_KINDS,
  fingerprint,
  ITEM_POLICY,
  orderItems,
  RECONCILED_KINDS,
  type ItemCandidate,
  type ItemKind,
} from '../domain/fromYou.ts';
import { parseJson, toJson } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import { closeBlockIfOpen, openSystemBlock } from './blocks.ts';
import { taskUrl, ticketDone, type Trx } from './board-utils.ts';
import { clearItem, raiseItem } from './feed.ts';
import type { RaiseItemInput } from './item-raise.ts';
import { quietTurns, stuckTurnAfterMs } from './turns.ts';

const episodeSchema = z.object({ startedAt: z.number() }).nullable();

const ENDED_WORKER_LABELS: Partial<Record<SessionHealthFlagKind, string>> = {
  worker_completed: 'worker ended (completed), no PR',
  worker_killed: 'worker ended (killed), no PR',
  worker_vanished: 'worker vanished, no PR',
  worker_lost: 'worker ended during its open turn',
};

/** Health flags only the operator can resolve; each opens an operator block. */
const ANOMALY_FLAGS: ReadonlySet<SessionHealthFlagKind> = new Set([
  'stuck_worker',
  'stuck_orchestrator',
  'needs_input',
  'worker_completed',
  'worker_lost',
]);

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
    // A stale tracker shows as a status flag only; stale Spur also blinds worker health.
    if (source.blind_reason === 'stale' && source.source !== 'spur') continue;
    candidates.push({
      key: `source:${source.source}`,
      kind: 'board_observation',
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
    // A linked PR or ticket raises an item only once the runner counts it gone.
    if (miss.gone !== 1) continue;
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
          kind: 'board_observation',
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
    const task = tasks.find((entry) => entry.key === ref.key);
    if (task === undefined) continue;
    candidates.push({
      key: `lookup:${String(task.id)}`,
      kind: 'board_observation',
      taskId: task.id,
      summary: `${task.key}: tracker returned ${miss.outcome ?? 'gone'}`,
      factAt: sourceById.get(miss.source)?.observed_at ?? null,
      source: miss.source,
      priority: 4,
    });
  }
  const blocks = await trx.selectFrom('block').selectAll().where('state', '=', 'open').execute();
  const blockedRoots = await trx
    .selectFrom('operator_item')
    .select('block_id')
    .where('kind', '=', 'post_blocked' satisfies ItemKind)
    .where('source', '=', 'conversation.open')
    .execute();
  const blockedIds = new Set(blockedRoots.map((item) => item.block_id));
  // A ledger block is the surface of its own item; it raises no block item besides.
  const ledgerRoots = await trx
    .selectFrom('operator_item')
    .select('block_id')
    .where('kind', 'in', BLOCK_ITEM_KINDS)
    .where('cleared_at', 'is', null)
    .execute();
  const ledgerIds = new Set(ledgerRoots.map((item) => item.block_id));
  for (const block of blocks) {
    const task = taskById.get(block.task_id);
    if (task === undefined || ledgerIds.has(block.id)) continue;
    if (
      block.addressee_role === 'operator' &&
      block.author !== 'operator' &&
      !blockedIds.has(block.id)
    )
      candidates.push({
        key: `operator-block:${String(block.id)}`,
        kind: 'board_observation',
        taskId: task.id,
        summary: `${task.key}: ${block.reason}`,
        factAt: block.created_at,
        source: null,
        priority: 0,
      });
    if (now - Date.parse(block.created_at) >= config.thresholds.blockOpenMs)
      candidates.push({
        key: `block:${String(block.id)}`,
        kind: 'board_observation',
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
      kind: 'post_failed',
      taskId: null,
      summary: `Delivery failed: ${delivery.kind}`,
      factAt: null,
      source: null,
      priority: ITEM_POLICY.post_failed.priority,
    });
  const spur = sourceById.get('spur');
  const spurBlind = spur !== undefined && spur.blind_reason !== null;
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
  const liveSessionTasks = new Set(
    subjects.filter((subject) => subject.endedAt === null).map((subject) => subject.taskId),
  );
  const prs = await trx
    .selectFrom('link')
    .leftJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select([
      'link.task_id',
      'link.repo',
      'link.number',
      'pr_snapshot.state',
      'pr_snapshot.source',
      'pr_snapshot.observed_at',
      'pr_snapshot.detail',
    ])
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .execute();
  const taskPrs: Record<
    string,
    { hasOpenPr: boolean; hasMergedPr: boolean; turnSessions: string[] }
  > = {};
  for (const task of tasks)
    taskPrs[String(task.id)] = { hasOpenPr: false, hasMergedPr: false, turnSessions: [] };
  for (const pr of prs) {
    const state = taskPrs[String(pr.task_id)];
    if (state === undefined) continue;
    if (pr.state === 'open') state.hasOpenPr = true;
    if (pr.state === 'merged') state.hasMergedPr = true;
  }
  const workerTurns = await trx
    .selectFrom('turn')
    .select(['task_id', 'acked_by'])
    .where('role', '=', 'worker')
    .where('closed_at', 'is', null)
    .where('acked_at', 'is not', null)
    .execute();
  for (const turn of workerTurns) {
    const holder = turn.acked_by === null ? null : parseActorId(turn.acked_by);
    if (holder?.actor === 'agent')
      taskPrs[String(turn.task_id)]?.turnSessions.push(holder.actorRef.session);
  }
  for (const task of tasks) {
    const state = taskPrs[String(task.id)];
    if (state === undefined || state.hasOpenPr || state.hasMergedPr) continue;
    const closed = prs
      .filter((pr) => pr.task_id === task.id && pr.state === 'closed')
      .map((pr) => ({ ...pr, ref: `${pr.repo ?? ''}#${String(pr.number)}` }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const first = closed[0];
    if (first === undefined) continue;
    const refs = closed.map((pr) => pr.ref);
    // Each closure episode gets its own revision: a reopen and close again moves updatedAt.
    const episodes = closed.map((pr) =>
      pr.detail === null ? pr.ref : `${pr.ref}@${parseJson(prFactsSchema, pr.detail).updatedAt}`,
    );
    candidates.push({
      key: `pr-closed:${String(task.id)}`,
      kind: 'anomaly',
      taskId: task.id,
      summary: `${task.key}: linked pull request ${refs.join(', ')} closed without merge, no open PR`,
      factAt: first.observed_at,
      source: first.source,
      priority: 4,
      revision: episodes.join(','),
    });
  }
  const tickets = await trx
    .selectFrom('ticket_snapshot')
    .select(['task_id', 'status', 'detail', 'source'])
    .execute();
  const unpolledTickets: string[] = [];
  for (const task of tasks) {
    const state = taskPrs[String(task.id)];
    const project = config.projects.find((entry) => entry.id === task.project);
    const ticket = tickets.find((entry) => entry.task_id === task.id);
    // A done ticket with live work and no merge is the operator's to settle, not a filter change.
    const closedWhileLive =
      state !== undefined &&
      project !== undefined &&
      ticket !== undefined &&
      ticketDone(project, ticket.status) &&
      (state.hasOpenPr || liveSessionTasks.has(String(task.id))) &&
      !state.hasMergedPr;
    if (task.membership === 'out_of_filter' && !closedWhileLive)
      candidates.push({
        key: `filter:${String(task.id)}`,
        kind: 'board_observation',
        taskId: task.id,
        summary: `${task.key} left the tracker filter while work is still linked`,
        factAt: task.last_change_at,
        source: null,
        priority: 4,
      });
    if (!closedWhileLive) continue;
    const { updatedAt } = parseJson(ticketFactsSchema, ticket.detail);
    // Wait for GitHub to report after the close, so a close by a merge is never taken for one.
    const polled = project.repos.every((repo) => {
      const repoSource = sourceById.get(`github:${project.id}:${repo.toLowerCase()}`);
      return (
        repoSource !== undefined &&
        repoSource.blind_reason === null &&
        repoSource.last_complete_at !== null &&
        Date.parse(repoSource.last_complete_at) > Date.parse(updatedAt)
      );
    });
    const key = `ticket-closed:${String(task.id)}`;
    // An open anomaly outlasts a blind or lagging GitHub; only observed facts end it.
    if (!polled) {
      unpolledTickets.push(key);
      continue;
    }
    candidates.push({
      key,
      kind: 'anomaly',
      taskId: task.id,
      summary: `${task.key}: ticket closed while work is live and no PR merged`,
      factAt: updatedAt,
      source: ticket.source,
      priority: 4,
      revision: updatedAt,
    });
  }
  const previousEpisode = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'host_load_episode')
    .executeTakeFirst();
  const health = evaluateSessionHealth({
    sessions: subjects,
    tasks: taskPrs,
    spur: {
      blind: spurBlind,
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
  for (const flag of health.flags) {
    const task = taskById.get(Number(flag.taskId));
    if (task === undefined) continue;
    const fact = subjects.find(
      (subject) => subject.taskId === flag.taskId && subject.id === flag.sessionId,
    );
    const endedLabel = ENDED_WORKER_LABELS[flag.kind];
    // A session waiting on its own board question already has the operator's attention.
    const asking =
      flag.kind === 'needs_input' &&
      fact !== undefined &&
      blocks.some((block) => {
        const author = parseActorId(block.author);
        return (
          block.task_id === task.id &&
          author?.actor === 'agent' &&
          author.actorRef.project === fact.spurProject &&
          author.actorRef.session === fact.id
        );
      });
    candidates.push({
      key: healthKey(task.id, flag),
      kind:
        ANOMALY_FLAGS.has(flag.kind) && !asking
          ? 'anomaly'
          : flag.kind === 'worker_killed'
            ? 'worker_ended'
            : 'board_observation',
      taskId: task.id,
      summary: `${task.key}: ${endedLabel ?? flag.kind.replaceAll('_', ' ')} (${flag.sessionId})`,
      factAt: fact?.healthSince ?? null,
      source: 'spur',
      priority: 4,
      revision: endedLabel === undefined ? (fact?.healthSince ?? null) : (fact?.endedAt ?? null),
    });
  }
  if (!spurBlind) {
    const flagged = new Set(
      [...health.flags, ...health.held]
        .filter((flag) => ANOMALY_FLAGS.has(flag.kind))
        .map((flag) => flag.sessionId),
    );
    const threshold = stuckTurnAfterMs(config);
    for (const { turn, sessionId, ended, quietSince, reminder } of await quietTurns(trx)) {
      const task = taskById.get(turn.task_id);
      if (task === undefined || quietSince === null || flagged.has(sessionId)) continue;
      const quiet = Date.parse(quietSince);
      const reminded =
        reminder !== undefined &&
        reminder.rings >= 1 &&
        reminder.acked_at !== null &&
        now >= Math.max(Date.parse(reminder.acked_at), quiet) + threshold;
      // A failed reminder counts only once the current quiet period reaches the threshold.
      const unreached =
        reminder !== undefined && reminder.exhausted_at !== null && now >= quiet + threshold;
      if (!reminded && !unreached && !(ended && now >= quiet + threshold)) continue;
      candidates.push({
        key: `stuck-turn:${String(turn.id)}`,
        kind: 'anomaly',
        taskId: task.id,
        summary: `${task.key}: turn T${String(turn.id)} taken by ${sessionId} has no submit or question`,
        factAt: quietSince,
        source: 'spur',
        priority: 4,
        revision: turn.acked_at,
      });
    }
  }
  const ordered = orderItems(candidates);
  const seen = new Set([...ordered.map((item) => item.key), ...unpolledTickets]);
  for (const flag of health.held) {
    const task = taskById.get(Number(flag.taskId));
    if (task !== undefined) seen.add(healthKey(task.id, flag));
  }
  const existing = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('kind', 'in', RECONCILED_KINDS)
    .where('cleared_at', 'is', null)
    .execute();
  // A host-load episode holds the error block of a session still in error, not a recovered one.
  const stillInError = new Set(
    health.hostLoad === null
      ? []
      : subjects
          .filter(
            (subject) =>
              subject.endedAt === null && subject.health === 'error' && subject.role !== 'other',
          )
          .map((subject) =>
            healthKey(Number(subject.taskId), {
              taskId: subject.taskId,
              sessionId: subject.id,
              kind: subject.role === 'worker' ? 'stuck_worker' : 'stuck_orchestrator',
            }),
          ),
  );
  for (const item of existing) {
    if (item.kind !== ('anomaly' satisfies ItemKind)) continue;
    // Spur-derived blocks wait out a blind Spur, and error blocks a host-load episode.
    if ((spurBlind && item.source === 'spur') || stillInError.has(item.item_key))
      seen.add(item.item_key);
  }
  for (const item of existing) {
    if (!seen.has(item.item_key)) await clearReconciled(trx, item, new Date(now));
  }
  for (const candidate of ordered) {
    const hash = fingerprint(candidate);
    const old = existing.find((item) => item.item_key === candidate.key);
    const dismissal = await trx
      .selectFrom('dismissal')
      .select('fingerprint')
      .where('item_key', '=', candidate.key)
      .executeTakeFirst();
    // A kind change re-raises the item, so a row raised before the kind existed takes its policy.
    const kept = old !== undefined && old.fingerprint === hash && old.kind === candidate.kind;
    if (old !== undefined && (dismissal?.fingerprint === hash || !kept))
      await clearReconciled(trx, old, new Date(now));
    if (dismissal?.fingerprint === hash) continue;
    if (kept) {
      if (old.fact_at !== candidate.factAt || old.source !== candidate.source)
        await trx
          .updateTable('operator_item')
          .set({ fact_at: candidate.factAt, source: candidate.source })
          .where('id', '=', old.id)
          .execute();
      continue;
    }
    const task = candidate.taskId === null ? null : taskById.get(candidate.taskId);
    const input = {
      itemKey: candidate.key,
      kind: candidate.kind,
      text: candidate.summary,
      url: task === null || task === undefined ? 'https://github.com' : taskUrl(task, config),
      at: new Date(now),
      fingerprint: hash,
      factAt: candidate.factAt,
      source: candidate.source,
      priority: candidate.priority,
    };
    if (ITEM_POLICY[candidate.kind].block && task !== null && task !== undefined)
      await raiseAnomaly(trx, config, task, input);
    else await raiseItem(trx, { ...input, taskId: candidate.taskId, blockId: null });
  }
}

/**
 * Raises a ledger item with the operator block it stands for. An active item of the key is
 * returned as it is, so a repeated raise opens no second block.
 */
async function raiseAnomaly(
  trx: Trx,
  config: Config,
  task: Row<'task'>,
  input: Omit<RaiseItemInput, 'taskId' | 'blockId'>,
): Promise<Row<'operator_item'>> {
  const active = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', '=', input.itemKey)
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (active !== undefined) return active;
  const prefix = `${task.key}: `;
  const block = await openSystemBlock(trx, {
    task,
    reason: input.text.startsWith(prefix) ? input.text.slice(prefix.length) : input.text,
    at: input.at.toISOString(),
    config,
  });
  return raiseItem(trx, { ...input, taskId: task.id, blockId: block.id });
}

/** Clears a reconciled item; a ledger item's open block is withdrawn by the board first. */
async function clearReconciled(trx: Trx, item: Row<'operator_item'>, at: Date): Promise<void> {
  if (item.block_id !== null) {
    const ctx = { actor: 'system' as const, at: at.toISOString() };
    await closeBlockIfOpen(trx, item.block_id, ctx, 'withdrawn', 'condition ended');
  }
  await clearItem(trx, item.id, at);
}

/**
 * Raises the cycle-limit block of a task's column, once while it is open. The operator's close
 * of the block or its item is the reset: a later call opens a new block.
 */
export async function raiseCycleLimit(
  trx: Trx,
  input: { task: Row<'task'>; column: ColumnId; at: Date; config: Config },
): Promise<Row<'operator_item'>> {
  const { task, column, at, config } = input;
  return raiseAnomaly(trx, config, task, {
    itemKey: `cycle-limit:${String(task.id)}:${column}`,
    kind: 'cycle_limit',
    text: `${task.key}: reached the cycle limit in ${column}`,
    url: taskUrl(task, config),
    at,
  });
}

function healthKey(taskId: number, flag: SessionHealthFlag): string {
  return `health:${String(taskId)}:${flag.sessionId}:${flag.kind}`;
}
