import {
  columnTurnTimings,
  entityRefSchema,
  parseActorId,
  prFactsSchema,
  prSourceId,
  sessionFactsSchema,
  SPUR_REQUEST_TIMEOUT,
  ticketFactsSchema,
  type ColumnId,
  type Config,
  type SessionFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { sql } from 'kysely';
import {
  evaluateSessionHealth,
  type SessionHealthFlag,
  type SessionHealthFlagKind,
  type TaskPrState,
} from '../domain/health.ts';
import {
  BLOCK_ITEM_KINDS,
  BLOCK_KEY,
  CONVERSATION_KEY,
  DEFAULT_BRANCH_KEY,
  fingerprint,
  ITEM_POLICY,
  itemBlockRef,
  NO_SESSION_KEY,
  noSessionSummary,
  OPERATOR_BLOCK_KEY,
  orderItems,
  RECONCILED_KINDS,
  REVIEW_RULE_KEY,
  SOURCE_KEY,
  type ItemCandidate,
  type ItemKind,
} from '../domain/fromYou.ts';
import { parseJson, toJson, type WarnSkipped } from '../store/json.ts';
import type { Row } from '../store/schema.ts';
import { closeBlockIfOpen, openSystemBlock } from './blocks.ts';
import {
  eligibleMerges,
  latest,
  mergedTicket,
  seenOpenSince,
  parseDefaultBranch,
  parsePr,
  pastReopenFloor,
  taskUrl,
  ticketDone,
  type Trx,
} from './board-utils.ts';
import { clearItem, raiseItem } from './feed.ts';
import { blockThread } from './outbox.ts';
import {
  bestProjectSession,
  curatorSession,
  earliestTime,
  LINKED_FINISHED_STATES,
  linkedSession,
  moveBlockToAddressee,
  selectNotificationRecipient,
} from './doorbells.ts';
import { curatorProject } from './authorize.ts';
import { TASKLESS_ITEM_URL, type RaiseItemInput } from './item-raise.ts';
import { externalQuietItems } from './external-quiet.ts';
import { hostDiskItems } from './host-disk.ts';
import { reviewRuleItems } from './review-rule.ts';
import { projectSubject, taskSubject, type BlockSubject } from './subject.ts';
import { quietTurns, stuckTurnAfterMs } from './quiet-turns.ts';
import { restingHolders, turnWaitItems } from './turn-waits.ts';
import { closeTurns } from './turns.ts';

const episodeSchema = z.object({ startedAt: z.number() }).nullable();
const stallEpisodeSchema = z.object({
  session: z.string().nullable(),
  health: z.string().nullable(),
  since: z.string().nullable(),
  revision: z.int().min(1),
});
const stallObservationSchema = z.object({
  blind: z.boolean(),
  observedAt: z.string().nullable(),
  resumedAt: z.number().nullable(),
});

const ENDED_WORKER_LABELS: Partial<Record<SessionHealthFlagKind, string>> = {
  worker_completed: 'worker ended (completed)',
  worker_killed: 'worker ended (killed)',
  worker_vanished: 'worker vanished',
};

/** Health flags only the operator can resolve; each opens an operator block. */
const ANOMALY_FLAGS: ReadonlySet<SessionHealthFlagKind> = new Set([
  'stuck_worker',
  'stuck_orchestrator',
  'needs_input',
  'worker_completed',
]);

/**
 * The item for an open operator conversation with a ring that waits for a live session of its
 * Spur project, or undefined while a session can take it or nothing waits.
 */
async function conversationWaiting(
  trx: Trx,
  config: Config,
  block: Row<'block'>,
  subject: BlockSubject,
): Promise<ItemCandidate | undefined> {
  const spur = block.addressee_spur_project;
  if (spur === null) return undefined;
  const ring = await trx
    .selectFrom('notification')
    .select('id')
    .where('block_id', '=', block.id)
    .where('kind', 'in', ['block', 'answer'])
    .where('acked_at', 'is', null)
    .where('exhausted_at', 'is', null)
    .executeTakeFirst();
  if (ring === undefined || (await bestProjectSession(trx, spur)) !== undefined) return undefined;
  const shortName =
    config.projects.flatMap((project) => project.spurProjects).find((entry) => entry.name === spur)
      ?.shortName ?? spur;
  return {
    key: `${CONVERSATION_KEY}${String(block.id)}`,
    kind: 'conversation_waiting',
    taskId: subject.task?.id ?? null,
    summary: `${subject.key}: message to @${shortName} waits for a live ${spur} session`,
    factAt: block.created_at,
    source: null,
    priority: ITEM_POLICY.conversation_waiting.priority,
  };
}

/**
 * When the last of `rows` stopped being a session a ring could reach, in milliseconds; -Infinity
 * for none. A row stopped at the earliest of its stored end, absence and finish, so later
 * timestamps of the same gap do not move it. A linked orchestrator stays a recipient while absent
 * or errored or completed, so only its end or a linked finished state counts. A row that stopped
 * when first seen never was a recipient and counts for nothing.
 */
function lastLoss(
  rows: readonly Pick<
    Row<'session_snapshot'>,
    'ended_at' | 'absent_since' | 'finished_at' | 'first_seen' | 'state'
  >[],
  linked: boolean,
) {
  let last = -Infinity;
  for (const row of rows) {
    const loss = earliestTime(
      linked
        ? [row.ended_at, LINKED_FINISHED_STATES.includes(row.state) ? row.finished_at : null]
        : [row.ended_at, row.absent_since, row.finished_at],
    );
    const ms = loss === undefined ? NaN : Date.parse(loss);
    if (ms > Date.parse(row.first_seen) && ms > last) last = ms;
  }
  return last;
}

/**
 * One `no-session:<project>:<column>` item per named-orchestrator column whose untaken turns
 * have rung with no live session to take them for `noRecipientAfterMs`. A ring's wait runs from
 * the later of its creation and the moment the last session that could take it stopped being a
 * recipient (`lastLoss`): one of the column's Spur project, or one linked to the task as
 * orchestrator. The
 * column's earliest wait start is the item's `factAt`; the summary carries no count or age, so a
 * new waiting turn or a later reconcile raises nothing again.
 */
async function turnsWithoutSession(
  trx: Trx,
  config: Config,
  now: number,
  taskById: ReadonlyMap<number, Row<'task'>>,
): Promise<ItemCandidate[]> {
  const rings = await trx
    .selectFrom('notification')
    .innerJoin('turn', 'turn.id', 'notification.turn_id')
    .select([
      'notification.id',
      'notification.kind',
      'notification.task_id',
      'notification.block_id',
      'notification.role',
      'notification.author_session',
      'notification.created_at',
      'turn.id as turn_id',
      'turn.task_id as turn_task_id',
      'turn.column',
    ])
    .where('notification.kind', '=', 'turn')
    .where('notification.acked_at', 'is', null)
    .where('notification.exhausted_at', 'is', null)
    .where('turn.closed_at', 'is', null)
    .where('turn.acked_at', 'is', null)
    .where(sql<boolean>`turn.role = 'orchestrator:' || turn."column"`)
    .execute();
  // Oldest ring first by instant, then by turn id; an unreadable ring time counts for nothing.
  const dated = rings
    .map((ring) => ({ ring, at: Date.parse(ring.created_at) }))
    .filter(({ at }) => !Number.isNaN(at))
    .sort((left, right) => left.at - right.at || left.ring.turn_id - right.ring.turn_id);
  const spurGone = new Map<string, number>();
  const linkedGone = new Map<number, number>();
  const columns = new Map<
    string,
    {
      task: Row<'task'>;
      spur: string;
      afterMs: number;
      earliest: number;
      oldest: (typeof rings)[number];
    }
  >();
  for (const { ring, at } of dated) {
    const task = taskById.get(ring.turn_task_id);
    if (task === undefined) continue;
    const timings = columnTurnTimings(config, task.project, ring.column);
    if (timings === null) continue;
    if ((await selectNotificationRecipient(trx, ring, config)) !== undefined) continue;
    const spur = timings.orchestrator;
    let gone = spurGone.get(spur);
    if (gone === undefined) {
      gone = lastLoss(
        await trx
          .selectFrom('session_snapshot')
          .select(['ended_at', 'absent_since', 'finished_at', 'first_seen', 'state'])
          .where('spur_project', '=', spur)
          .where((eb) =>
            eb.or([
              eb('ended_at', 'is not', null),
              eb('absent_since', 'is not', null),
              eb('finished_at', 'is not', null),
            ]),
          )
          .execute(),
        false,
      );
      spurGone.set(spur, gone);
    }
    let linked = linkedGone.get(task.id);
    if (linked === undefined) {
      linked = lastLoss(
        await trx
          .selectFrom('link')
          .innerJoin('session_snapshot', 'session_snapshot.id', 'link.session_id')
          .select([
            'session_snapshot.ended_at',
            'session_snapshot.absent_since',
            'session_snapshot.finished_at',
            'session_snapshot.first_seen',
            'session_snapshot.state',
          ])
          .where('link.task_id', '=', task.id)
          .where('link.entity', '=', 'session')
          .where('link.role', '=', 'orchestrator')
          .where('link.banned', '=', 0)
          .execute(),
        true,
      );
      linkedGone.set(task.id, linked);
    }
    const since = Math.max(at, gone, linked);
    const key = `${NO_SESSION_KEY}${task.project}:${ring.column}`;
    const group = columns.get(key);
    if (group === undefined)
      columns.set(key, {
        task,
        spur,
        afterMs: timings.noRecipientAfterMs,
        earliest: since,
        oldest: ring,
      });
    else group.earliest = Math.min(group.earliest, since);
  }
  return [...columns].flatMap(([key, { task, spur, afterMs, earliest, oldest }]) =>
    now - earliest < afterMs
      ? []
      : [
          {
            key,
            kind: 'board_observation' as const,
            taskId: task.id,
            summary: noSessionSummary({
              project: task.project,
              column: oldest.column,
              spur,
              turn: oldest.turn_id,
              ringAt: oldest.created_at,
            }),
            factAt: new Date(earliest).toISOString(),
            source: null,
            priority: 4,
          },
        ],
  );
}

/**
 * Reconciles every item in the caller's observation or tick transaction. It first closes each
 * Done wrap-up turn whose holder session ended (`closeEndedDoneTurns`), so no stall item is
 * raised for it, and, while Spur is current, each untaken one left with no recipient
 * (`closeUnaddressedDoneTurns`).
 */
export async function reconcileItems(
  trx: Trx,
  config: Config,
  now: number,
  spurComplete: boolean,
  warnSkipped?: WarnSkipped,
  /** Fresh complete Spur batch after startup or an expired observation interval. */
  spurContinuityStartAt?: number,
): Promise<void> {
  const sources = await trx.selectFrom('source_state').selectAll().execute();
  const sourceById = new Map(sources.map((state) => [state.source, state]));
  const spur = sourceById.get('spur');
  const spurBlind = spur !== undefined && spur.blind_reason !== null;
  const spurExpired =
    spur?.last_complete_at != null &&
    now >
      Date.parse(spur.last_complete_at) +
        config.adapters.spur.intervalMs * config.thresholds.staleMultiplier;
  await closeEndedDoneTurns(trx, new Date(now));
  if (!(spurBlind || !spurComplete || spurExpired))
    await closeUnaddressedDoneTurns(trx, config, new Date(now));
  const candidates: ItemCandidate[] = [];
  for (const source of sources) {
    if (source.blind_reason === null) continue;
    // A stale tracker shows as a status flag only; stale Spur also blinds worker health.
    if (source.blind_reason === 'stale' && source.source !== 'spur') continue;
    candidates.push({
      key: `${SOURCE_KEY}${source.source}`,
      kind: 'board_observation',
      taskId: null,
      summary: `${source.source}: ${source.blind_message ?? source.blind_reason}`,
      ...(source.source === 'spur' &&
        source.blind_reason === 'stale' &&
        source.failure_code === SPUR_REQUEST_TIMEOUT && { hashedSummary: SPUR_REQUEST_TIMEOUT }),
      factAt: source.observed_at,
      source: source.source,
      priority: source.blind_reason === 'auth' || source.blind_reason === 'config' ? 2 : 4,
    });
  }
  // A configured repository whose default-branch head is red; a repo dropped from config clears.
  for (const project of config.projects)
    for (const repo of project.repos) {
      const source = prSourceId(project.id, repo);
      const branch = parseDefaultBranch(sourceById.get(source)?.default_branch);
      if (branch?.state !== 'red') continue;
      const check = branch.check === null ? 'a failing check' : branch.check;
      const run = branch.url === null ? '' : ` (run ${branch.url})`;
      candidates.push({
        key: `${DEFAULT_BRANCH_KEY}${source}`,
        kind: 'board_observation',
        taskId: null,
        summary: `${repo}: ${branch.branch} is red since ${branch.sha.slice(0, 7)} (${check}): fix ${branch.branch} before merging more${run}`,
        // The episode start keeps the item; each red read confirms it.
        factAt: branch.confirmedAt,
        source,
        priority: 2,
        revision: branch.since,
        ...(branch.url === null ? {} : { url: branch.url }),
      });
    }
  const tasks = await trx
    .selectFrom('task')
    .selectAll()
    .where('membership', '!=', 'archived')
    .execute();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const endedHolders = await endedTurnItems(
    trx,
    taskById,
    candidates,
    new Date(now),
    sourceById.get('spur')?.last_complete_at ?? null,
  );
  const misses = await trx.selectFrom('source_miss').selectAll().execute();
  for (const miss of misses) {
    // A linked PR or ticket raises an item only once the runner counts it gone.
    if (miss.gone !== 1) continue;
    const parsed = entityRefSchema.safeParse(JSON.parse(miss.ref));
    if (!parsed.success) {
      warnSkipped?.('source_miss', 'ref', `${miss.source} ${miss.ref_key}`, parsed.error);
      continue;
    }
    const ref = parsed.data;
    if (ref.kind === 'pr') {
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
  // A project-level block has no task: it is named by its project.
  const subjectOf = (block: Row<'block'>): BlockSubject | undefined => {
    if (block.task_id === null)
      return block.project === null ? undefined : projectSubject(block.project);
    const task = taskById.get(block.task_id);
    return task === undefined ? undefined : taskSubject(task);
  };
  for (const block of blocks) {
    const subject = subjectOf(block);
    if (subject === undefined || ledgerIds.has(block.id)) continue;
    const taskId = subject.task?.id ?? null;
    if (
      block.addressee_role === 'operator' &&
      block.author !== 'operator' &&
      !blockedIds.has(block.id)
    )
      candidates.push({
        key: `${OPERATOR_BLOCK_KEY}${String(block.id)}`,
        kind: 'board_observation',
        taskId,
        summary: `${subject.key}: ${block.reason}`,
        factAt: block.created_at,
        source: null,
        priority: 0,
      });
    if (block.addressee_spur_project !== null) {
      const waiting = await conversationWaiting(trx, config, block, subject);
      if (waiting !== undefined) candidates.push(waiting);
    }
    if (now - Date.parse(block.created_at) >= config.thresholds.blockOpenMs)
      candidates.push({
        key: `${BLOCK_KEY}${String(block.id)}`,
        kind: 'board_observation',
        taskId,
        summary: `${subject.key}: block has been open for more than a day`,
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
      'link.id',
      'link.task_id',
      'link.repo',
      'link.number',
      'link.pr_state',
      'pr_snapshot.state',
      'pr_snapshot.source',
      'pr_snapshot.observed_at',
      'pr_snapshot.merged_seen_at',
      'pr_snapshot.detail',
    ])
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .where(pastReopenFloor)
    .execute();
  const tickets = new Map(
    (
      await trx
        .selectFrom('ticket_snapshot')
        .select(['task_id', 'status', 'detail', 'source', 'observed_at', 'last_read_at'])
        .execute()
    ).map((ticket) => [ticket.task_id, ticket]),
  );
  const taskPrs: Record<string, TaskPrState> = {};
  for (const task of tasks) {
    const project = config.projects.find((entry) => entry.id === task.project);
    const ticket = tickets.get(task.id);
    taskPrs[String(task.id)] = {
      hasOpenPr: false,
      hasMergedPr: false,
      prCompleteAt: prCompleteAt(project, sourceById),
      ticketDone:
        project !== undefined && ticket !== undefined && ticketDone(project, ticket.status),
    };
  }
  // When a closed PR closed. Facts stored by an earlier version carry no close time; their last
  // change stands in for it.
  const closeTime = (pr: (typeof prs)[number]) => {
    const facts = pr.detail === null ? null : parseJson(prFactsSchema, pr.detail);
    return facts === null ? NaN : Date.parse(facts.closedAt ?? facts.updatedAt);
  };
  // Each task's newest merge time over merged links of any kind, the closure timing: closes before
  // it are superseded, and its grace holds the pr-closed item. Null when no merged PR's detail is
  // readable.
  const mergedAt = new Map<number, string | null>();
  // Idle waits for an issue read after the newest visible merge, including conflict links.
  const mergedSeenAt = new Map<number, string | null>();
  // Each task's newest stored merge time (`newestMergeAt`): a ticket edited before it waits.
  const newestMerge = new Map<number, string | null>();
  // Each task's merged PR as the inbox judges it: the newest link among its `eligibleMerges`, the
  // same PR the dispatcher's `taskMergedPr` picks; `at` is null when its detail is unreadable.
  const judged = new Map<
    number,
    { id: number; facts: ReturnType<typeof parsePr>; at: string | null; ref: string }
  >();
  type Merged = (typeof prs)[number] & { facts: ReturnType<typeof parsePr>; at: string | null };
  const mergedByTask = new Map<number, Merged[]>();
  for (const pr of prs) {
    const state = taskPrs[String(pr.task_id)];
    if (state === undefined) continue;
    if (pr.state === 'open') state.hasOpenPr = true;
    if (pr.state !== 'merged') continue;
    mergedSeenAt.set(pr.task_id, latest([mergedSeenAt.get(pr.task_id), pr.merged_seen_at]));
    const facts = parsePr(pr.detail ?? undefined);
    const at = facts === null ? null : (facts.mergedAt ?? facts.updatedAt);
    const newest = mergedAt.get(pr.task_id) ?? null;
    if (newest === null || (at !== null && Date.parse(at) >= Date.parse(newest)))
      mergedAt.set(pr.task_id, at);
    const bucket = mergedByTask.get(pr.task_id);
    if (bucket === undefined) mergedByTask.set(pr.task_id, [{ ...pr, facts, at }]);
    else bucket.push({ ...pr, facts, at });
  }
  for (const [taskId, merged] of mergedByTask)
    for (const pr of eligibleMerges(merged)) {
      newestMerge.set(taskId, latest([newestMerge.get(taskId), pr.facts?.mergedAt]));
      const current = judged.get(taskId);
      if (current === undefined || pr.id > current.id)
        judged.set(taskId, {
          id: pr.id,
          facts: pr.facts,
          at: pr.at,
          ref: `${pr.repo ?? ''}#${String(pr.number)}`,
        });
    }
  // Each task's pr-closed item when it has no open PR: its PRs closed unmerged, less those closed
  // before the newest merge of any link kind, which superseded them, even beside an active merge. It
  // is held until every repo completed a poll since the last close, so a replacement PR is seen
  // first. A raised one also ends the merged PR's suppression below, so the two always agree.
  const prClosed = new Map<
    number,
    { held: true; key: string } | { held: false; item: ItemCandidate; closedAt: number }
  >();
  for (const task of tasks) {
    const state = taskPrs[String(task.id)];
    if (state === undefined || state.hasOpenPr) continue;
    const mergedSince = Date.parse(mergedAt.get(task.id) ?? '');
    const closed = prs
      .filter((pr) => pr.task_id === task.id && pr.state === 'closed')
      .map((pr) => ({
        ...pr,
        ref: `${pr.repo ?? ''}#${String(pr.number)}`,
        closedAt: closeTime(pr),
      }))
      .filter((pr) => !(pr.closedAt < mergedSince))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const first = closed[0];
    if (first === undefined) continue;
    const closedAt = Math.max(...closed.map((pr) => pr.closedAt));
    const key = `pr-closed:${String(task.id)}`;
    // After a merge it is also held until the tracker saw the ticket open past the merge's grace,
    // so a ticket the merge edits and then closes raises nothing.
    const project = config.projects.find((entry) => entry.id === task.project);
    const inMergeGrace =
      Number.isFinite(mergedSince) &&
      project !== undefined &&
      !seenOpenSince(project, config, tickets.get(task.id), task.manual_include === 1, mergedSince);
    if (inMergeGrace || state.prCompleteAt === null || !(state.prCompleteAt >= closedAt)) {
      prClosed.set(task.id, { held: true, key });
      continue;
    }
    const refs = closed.map((pr) => pr.ref);
    // Projects sharing a repo overwrite the snapshot's source, so the task's own repo source names it.
    prClosed.set(task.id, {
      held: false,
      closedAt,
      item: {
        key,
        kind: 'anomaly',
        taskId: task.id,
        summary: `${task.key}: linked pull request ${refs.join(', ')} closed without merge, no open PR`,
        factAt: first.observed_at,
        source: prSourceId(task.project, first.repo ?? ''),
        priority: 4,
        revision: refs.join(','),
      },
    });
  }
  // Tasks whose ticket reopened after the judged merge, with the clause their worker-end item names.
  const reopened = new Map<number, string>();
  // Tasks whose merged PR suppresses alerts only while their pr-closed item is held, as when a repo
  // is blind: their shown alerts hold as they are, and nothing new is raised.
  const liftHeld = new Set<number>();
  for (const [taskId, { facts, at, ref }] of judged) {
    const state = taskPrs[String(taskId)];
    const task = taskById.get(taskId);
    if (state === undefined || task === undefined) continue;
    const project = config.projects.find((entry) => entry.id === task.project);
    // A merged PR counts as finished work unless the ticket changed after it and is not done: a
    // split task back in Dev is watched like any task without a PR. A raised pr-closed item also
    // ends it once the ticket is seen still not done one tracker interval after the newest merge,
    // the grace in which a close the merge triggers may still be polled.
    const ticket = tickets.get(taskId);
    // The newest stored merge decides; without one, the PR's interval fallback (`mergedTicket`).
    const storedMerge = latest([facts?.mergedAt, newestMerge.get(taskId)]);
    const judgement =
      facts === null || project === undefined
        ? 'unconfirmed'
        : mergedTicket(project, config, ticket, task.manual_include === 1, {
            ...facts,
            ...(storedMerge === null ? {} : { mergedAt: storedMerge }),
          });
    const closure = prClosed.get(taskId);
    // The tracker evidence a closure lift needs, raised or held.
    const seenOpen =
      project !== undefined &&
      seenOpenSince(
        project,
        config,
        ticket,
        task.manual_include === 1,
        Date.parse(mergedAt.get(taskId) ?? ''),
      );
    const followUpClosed = closure?.held === false && seenOpen;
    state.hasMergedPr =
      at === null ||
      project === undefined ||
      (judgement !== 'reopened' &&
        judgement !== 'open' &&
        (judgement === 'done' || !followUpClosed));
    // No ticket status in the text: the item fingerprint hashes it, and a move between two
    // non-done statuses must not raise the item again.
    if (judgement === 'reopened') reopened.set(taskId, `; PR ${ref} merged, ticket reopened`);
    // A held lift keeps its alerts only while the tracker still sees the ticket open.
    if (state.hasMergedPr && seenOpen && closure?.held === true) liftHeld.add(taskId);
  }
  const heldKeys: string[] = [];
  for (const task of tasks) {
    const closure = prClosed.get(task.id);
    if (closure === undefined) continue;
    const key = closure.held ? closure.key : closure.item.key;
    if (taskPrs[String(task.id)]?.hasMergedPr !== false) {
      if (liftHeld.has(task.id)) heldKeys.push(key);
    } else if (closure.held) heldKeys.push(key);
    else candidates.push(closure.item);
  }
  for (const task of tasks) {
    const state = taskPrs[String(task.id)];
    const project = config.projects.find((entry) => entry.id === task.project);
    const ticket = tickets.get(task.id);
    // A done ticket with live work and no merge is the operator's to settle, not a filter change.
    const closedWhileLive =
      state !== undefined &&
      project !== undefined &&
      ticket !== undefined &&
      ticketDone(project, ticket.status) &&
      (state.hasOpenPr || liveSessionTasks.has(String(task.id))) &&
      // A merge of any link state, a conflict link's included, may be what closed the ticket.
      !state.hasMergedPr &&
      !prs.some((pr) => pr.task_id === task.id && pr.state === 'merged');
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
    const polledAt = state.prCompleteAt;
    const polled = polledAt !== null && polledAt > Date.parse(updatedAt);
    const key = `ticket-closed:${String(task.id)}`;
    // An open anomaly outlasts a blind or lagging GitHub; only observed facts end it.
    if (!polled) {
      heldKeys.push(key);
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
      revision: 'closed',
    });
  }
  // Startup snapshots and source recovery can retain an old healthSince. New alerts need a fresh
  // observed interval; an already-open or dismissed episode keeps its established identity.
  const observationRow = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'turn_stall_observation')
    .executeTakeFirst();
  const previousObservation =
    observationRow === undefined
      ? { blind: false, observedAt: null, resumedAt: null }
      : parseJson(stallObservationSchema, observationRow.value);
  const observation =
    spurBlind || !spurComplete || spurExpired
      ? {
          ...previousObservation,
          blind: true,
          observedAt: spurComplete ? (spur?.observed_at ?? null) : null,
        }
      : spurContinuityStartAt !== undefined
        ? { blind: false, observedAt: spur?.observed_at ?? null, resumedAt: spurContinuityStartAt }
        : previousObservation.blind &&
            spur?.observed_at != null &&
            spur.observed_at !== previousObservation.observedAt
          ? { blind: false, observedAt: spur.observed_at, resumedAt: Date.parse(spur.observed_at) }
          : previousObservation;
  if (JSON.stringify(observation) !== JSON.stringify(previousObservation))
    await trx
      .insertInto('meta')
      .values({ key: 'turn_stall_observation', value: toJson(stallObservationSchema, observation) })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: toJson(stallObservationSchema, observation) }),
      )
      .execute();
  const stallBlind = observation.blind;
  const stallExecutors = new Map<string, string>();
  // Diagnose turns separately from delivery: a stopped session cannot receive a ring.
  const stalled = new Set<string>();
  const stallHeld = new Set<string>();
  const turns = await trx.selectFrom('turn').selectAll().where('closed_at', 'is', null).execute();
  for (const turn of turns) {
    const task = taskById.get(turn.task_id);
    if (task === undefined || turn.role === 'operator') continue;
    const holder = turn.acked_by === null ? null : parseActorId(turn.acked_by);
    let executor =
      holder?.actor === 'agent'
        ? await trx
            .selectFrom('session_snapshot')
            .selectAll()
            .where('id', '=', holder.actorRef.session)
            .executeTakeFirst()
        : turn.acked_at === null
          ? await selectNotificationRecipient(
              trx,
              { task_id: task.id, role: turn.role, author_session: null },
              config,
            )
          : undefined;
    if (executor === undefined && turn.acked_at === null) {
      const project = config.projects.find((entry) => entry.id === task.project);
      const target = project?.columns.find((entry) => entry.id === turn.column)?.orchestrator;
      executor = await stoppedExecutor(trx, task.id, turn.role, target);
    }
    if (executor === undefined || executor.ended_at !== null || executor.absent_since !== null) {
      await observeTurnEpisode(trx, turn.id, null);
      continue;
    }
    if (turn.role === 'worker') {
      const removed = await trx
        .selectFrom('link')
        .select('id')
        .where('task_id', '=', task.id)
        .where('session_id', '=', executor.id)
        .where('banned', '=', 1)
        .executeTakeFirst();
      if (removed !== undefined) {
        await observeTurnEpisode(trx, turn.id, null);
        continue;
      }
    }
    const parsed = sessionFactsSchema.safeParse(JSON.parse(executor.detail));
    if (!parsed.success) {
      await observeTurnEpisode(trx, turn.id, null);
      continue;
    }
    const fact = parsed.data;
    if (holder?.actor === 'agent' && holder.actorRef.project !== fact.spurProject) {
      await observeTurnEpisode(trx, turn.id, null);
      continue;
    }
    const episode = await observeTurnEpisode(trx, turn.id, fact);
    const episodeSince = episode.since ?? fact.healthSince;
    if (!['needs_input', 'error', 'rate_limited', 'stopped'].includes(fact.health)) continue;
    const healthStart = Math.max(Date.parse(turn.created_at), Date.parse(episodeSince));
    if (!Number.isFinite(healthStart)) continue;
    stalled.add(`${String(task.id)}:${fact.id}`);
    const key = `turn-stall:${String(turn.id)}:${fact.id}:${fact.health}:${episodeSince}:${String(episode.revision)}`;
    stallHeld.add(key);
    const previous = await trx
      .selectFrom('operator_item')
      .select(['text', 'cleared_at', 'block_id'])
      .where('item_key', '=', key)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const activeBlock =
      previous?.cleared_at === null
        ? blocks.find((block) => block.id === previous.block_id)
        : undefined;
    // The curator can change while this block is open, including while new alerts wait.
    if (
      activeBlock?.addressee_role === 'curator' &&
      (await curatorSession(trx, config, task.project))?.id === fact.id
    )
      await moveBlockToAddressee(trx, {
        task,
        block: activeBlock,
        to: 'operator',
        reason: 'The selected curator is the stalled executor.',
        ctx: { actor: 'system', at: new Date(now).toISOString() },
        config,
      });
    const since =
      previous?.cleared_at === null
        ? healthStart
        : Math.max(healthStart, observation.resumedAt ?? healthStart);
    if (stallBlind || now - since < config.health.turnStallAfterMs) continue;
    stallExecutors.set(key, fact.id);
    const questions = blocks
      .filter((block) => {
        const author = parseActorId(block.author);
        return (
          block.task_id === task.id &&
          author?.actor === 'agent' &&
          author.actorRef.project === fact.spurProject &&
          author.actorRef.session === fact.id
        );
      })
      .map((block) => `B${String(block.id)}`);
    const quota =
      fact.health === 'rate_limited'
        ? `; quota name unavailable; reset ${fact.rateLimitResetAt ?? 'unknown'}`
        : '';
    // Opening evidence remains frozen across later polls and observation gaps.
    candidates.push({
      key,
      kind: 'anomaly',
      taskId: task.id,
      summary:
        previous?.text ??
        `${task.key}: turn T${String(turn.id)} executor ${fact.id} remains ${fact.health} since ${episodeSince}; turn-relative elapsed ${String(now - since)} ms${since > healthStart ? `; continuous observation since ${new Date(since).toISOString()}` : ''}${quota}${questions.length === 0 ? '' : `; open executor questions: ${questions.join(', ')}`}`,
      factAt: episodeSince,
      source: 'spur',
      priority: 4,
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
  // While a held pr-closed item keeps the merged PR suppressing, the ended-worker items the task
  // would show without that suppression hold as they are; health decides the other conditions.
  if (liftHeld.size > 0) {
    const lifted = evaluateSessionHealth({
      sessions: subjects,
      tasks: Object.fromEntries(
        Object.entries(taskPrs).map(([id, state]) => [
          id,
          liftHeld.has(Number(id)) ? { ...state, hasMergedPr: false } : state,
        ]),
      ),
      spur: { blind: spurBlind, observationComplete: spurComplete },
      config: config.health,
      now,
      episode:
        previousEpisode === undefined ? null : parseJson(episodeSchema, previousEpisode.value),
    });
    for (const flag of [...lifted.flags, ...lifted.held])
      if (liftHeld.has(Number(flag.taskId)) && ENDED_WORKER_LABELS[flag.kind] !== undefined)
        heldKeys.push(healthKey(Number(flag.taskId), flag));
  }
  await trx
    .insertInto('meta')
    .values({ key: 'host_load_episode', value: toJson(episodeSchema, health.episode) })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: toJson(episodeSchema, health.episode) }),
    )
    .execute();
  // Done and holders resting on their turns raise or hold no idle item.
  const resting = await restingHolders(trx, config, now);
  const skipIdle = (task: Row<'task'>, flag: SessionHealthFlag) =>
    flag.kind === 'worker_idle' &&
    (task.column === 'done' || resting.has(`${flag.taskId}:${flag.sessionId}`));
  // A worker stopped without an end time on a Done task whose untaken wrap-up closed with no
  // recipient left (`closeUnaddressedDoneTurns`) has nothing left to answer: the retained Spur
  // health of its last state raises and holds no stuck or input flag. Before that close the
  // open turn kept the session in `stalled`.
  const turnTasks = new Set(turns.map((turn) => turn.task_id));
  // Only the latest turn of the current Done visit counts: a later wrap-up, taken or not, starts
  // over, so an older close cannot withdraw a newer alert.
  const latestDoneTurns = new Map(
    (
      await trx
        .selectFrom('turn')
        .innerJoin('task', 'task.id', 'turn.task_id')
        .select(['turn.task_id', 'turn.acked_at', 'turn.role', 'turn.closed_reason'])
        .where('turn.column', '=', 'done')
        .where('task.column', '=', 'done')
        .whereRef('turn.epoch', '=', 'task.column_epoch')
        .orderBy('turn.id')
        .execute()
    ).map((turn) => [turn.task_id, turn]),
  );
  const unaddressedDone = new Set(
    [...latestDoneTurns.values()]
      .filter(
        (turn) =>
          turn.closed_reason === 'moved' && turn.acked_at === null && turn.role === 'worker',
      )
      .map((turn) => turn.task_id),
  );
  // Only the worker the stall scan would have diagnosed that turn against: another linked
  // worker's alert was never held by it.
  const addressed = new Set<string>();
  for (const taskId of unaddressedDone) {
    if (!taskById.has(taskId) || turnTasks.has(taskId)) continue;
    const session = await stoppedExecutor(trx, taskId, 'worker', undefined);
    if (session !== undefined) addressed.add(`${String(taskId)}:${session.id}`);
  }
  const stoppedInDone = new Set(
    subjects
      .filter(
        (subject) =>
          subject.role === 'worker' &&
          subject.lifecycle === 'stopped' &&
          subject.endedAt === null &&
          addressed.has(`${subject.taskId}:${subject.id}`),
      )
      .map((subject) => `${subject.taskId}:${subject.id}`),
  );
  const stoppedRetained = (flag: { kind: string; taskId: string; sessionId: string }) =>
    ['stuck_worker', 'needs_input'].includes(flag.kind) &&
    stoppedInDone.has(`${flag.taskId}:${flag.sessionId}`);
  for (const flag of health.flags) {
    const task = taskById.get(Number(flag.taskId));
    if (
      task === undefined ||
      endedHolders.has(`${flag.taskId}:${flag.sessionId}`) ||
      skipIdle(task, flag) ||
      stoppedRetained(flag)
    )
      continue;
    if (flag.kind === 'worker_idle' && task.tracker_kind === 'github-issues') {
      const merged = mergedSeenAt.get(task.id);
      const read = tickets.get(task.id)?.last_read_at;
      if (merged != null && (read == null || Date.parse(read) <= Date.parse(merged))) {
        heldKeys.push(healthKey(task.id, flag));
        continue;
      }
    }
    const fact = subjects.find(
      (subject) => subject.taskId === flag.taskId && subject.id === flag.sessionId,
    );
    if (
      ['stuck_worker', 'stuck_orchestrator', 'needs_input'].includes(flag.kind) &&
      stalled.has(`${flag.taskId}:${flag.sessionId}`)
    )
      continue;
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
      summary: `${task.key}: ${
        endedLabel === undefined
          ? flag.kind.replaceAll('_', ' ')
          : `${endedLabel}${reopened.get(task.id) ?? ', no PR'}`
      } (${flag.sessionId})`,
      // The text an earlier version showed, so a dismissal holds when the PR clause changes.
      ...(endedLabel === undefined
        ? {}
        : { hashedSummary: `${task.key}: ${endedLabel}, no PR (${flag.sessionId})` }),
      // An ended worker's "no PR" holds while Spur keeps completing polls.
      factAt:
        endedLabel === undefined
          ? (fact?.healthSince ?? null)
          : (spur?.last_complete_at ?? fact?.endedAt ?? null),
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
    for (const { turn, sessionId, ended, quietSince, reminder, delivered } of await quietTurns(
      trx,
    )) {
      const task = taskById.get(turn.task_id);
      if (ended || task === undefined || quietSince === null || flagged.has(sessionId)) continue;
      const threshold = stuckTurnAfterMs(config, task.project, turn);
      const quiet = Date.parse(quietSince);
      const reminded =
        reminder !== undefined &&
        delivered &&
        reminder.acked_at !== null &&
        now >= Math.max(Date.parse(reminder.acked_at), quiet) + threshold;
      // A failed reminder counts only once the current quiet period reaches the threshold.
      const unreached =
        reminder !== undefined && reminder.exhausted_at !== null && now >= quiet + threshold;
      if (!reminded && !unreached) continue;
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
  // Stale or unobserved Spur holds the no-session items it shows and raises none.
  if (spurBlind || !spurComplete || spurExpired) {
    const held = await trx
      .selectFrom('operator_item')
      .select('item_key')
      .where('item_key', 'like', `${NO_SESSION_KEY}%`)
      .where('cleared_at', 'is', null)
      .execute();
    heldKeys.push(...held.map((item) => item.item_key));
  } else candidates.push(...(await turnsWithoutSession(trx, config, now, taskById)));
  candidates.push(...(await reviewRuleItems(trx, config, now, tasks)));
  const quiet = await externalQuietItems(trx, config, now, tasks, sourceById);
  candidates.push(...quiet.candidates);
  heldKeys.push(...quiet.held);
  candidates.push(...(await turnWaitItems(trx, config, taskById)));
  candidates.push(...(await hostDiskItems(trx)));
  const ordered = orderItems(candidates);
  const seen = new Set([...ordered.map((item) => item.key), ...heldKeys]);
  for (const flag of health.held) {
    const task = taskById.get(Number(flag.taskId));
    if (
      task === undefined ||
      endedHolders.has(`${flag.taskId}:${flag.sessionId}`) ||
      skipIdle(task, flag) ||
      stoppedRetained(flag)
    )
      continue;
    if (!stalled.has(`${flag.taskId}:${flag.sessionId}`)) seen.add(healthKey(task.id, flag));
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
              subject.endedAt === null &&
              subject.health === 'error' &&
              subject.role !== 'other' &&
              !stalled.has(`${subject.taskId}:${subject.id}`) &&
              !stoppedInDone.has(`${subject.taskId}:${subject.id}`),
          )
          .map((subject) =>
            healthKey(Number(subject.taskId), {
              taskId: subject.taskId,
              sessionId: subject.id,
              kind: subject.role === 'worker' ? 'stuck_worker' : 'stuck_orchestrator',
            }),
          ),
  );
  // A done ticket ends an ended worker's item even while Spur is blind.
  const spurHeld = spurBlind
    ? await blindHeldKeys(
        trx,
        subjects.filter(
          (subject) =>
            !endedHolders.has(`${subject.taskId}:${subject.id}`) &&
            !(subject.endedAt !== null && taskPrs[subject.taskId]?.ticketDone === true),
        ),
      )
    : new Set<string>();
  if (stallBlind) for (const key of stallHeld) spurHeld.add(key);
  for (const item of existing) {
    if (item.kind !== ('anomaly' satisfies ItemKind)) continue;
    // Spur-derived blocks wait out a blind Spur, and error blocks a host-load episode.
    if ((item.source === 'spur' && spurHeld.has(item.item_key)) || stillInError.has(item.item_key))
      seen.add(item.item_key);
  }
  for (const item of existing) {
    if (!seen.has(item.item_key)) await clearReconciled(trx, item, new Date(now));
  }
  // A closure ends when its PR or ticket stops being closed, and a review-rule dismissal when its
  // stretch ends: a clean read, a state with its own reason, a new head or the task leaving
  // External Review. The next closure or stretch raises anew.
  const closures = await trx
    .selectFrom('dismissal')
    .select('item_key')
    .where((eb) =>
      eb.or([
        eb('item_key', 'like', 'pr-closed:%'),
        eb('item_key', 'like', 'ticket-closed:%'),
        eb('item_key', 'like', `${REVIEW_RULE_KEY}%`),
      ]),
    )
    .execute();
  const ended = closures.map((row) => row.item_key).filter((key) => !seen.has(key));
  if (ended.length > 0) await trx.deleteFrom('dismissal').where('item_key', 'in', ended).execute();
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
      // A hashed summary keeps the item while its shown text changes: show the current text.
      if (
        old.fact_at !== candidate.factAt ||
        old.source !== candidate.source ||
        old.text !== candidate.summary
      )
        await trx
          .updateTable('operator_item')
          .set({ fact_at: candidate.factAt, source: candidate.source, text: candidate.summary })
          .where('id', '=', old.id)
          .execute();
      // Its open block shows the same text in the inbox; the refresh notifies no one.
      const task = candidate.taskId === null ? undefined : taskById.get(candidate.taskId);
      if (
        candidate.hashedSummary !== undefined &&
        old.text !== candidate.summary &&
        old.block_id !== null &&
        task !== undefined
      )
        await trx
          .updateTable('block')
          .set({ reason: blockReason(task, candidate.summary) })
          .where('id', '=', old.block_id)
          .where('state', '=', 'open')
          .execute();
      continue;
    }
    const task = candidate.taskId === null ? null : taskById.get(candidate.taskId);
    const input = {
      itemKey: candidate.key,
      kind: candidate.kind,
      text: candidate.summary,
      url:
        candidate.url ??
        (task === null || task === undefined ? TASKLESS_ITEM_URL : taskUrl(task, config)),
      at: new Date(now),
      fingerprint: hash,
      factAt: candidate.factAt,
      source: candidate.source,
      priority: candidate.priority,
    };
    if (ITEM_POLICY[candidate.kind].block && task !== null && task !== undefined)
      await raiseAnomaly(trx, config, task, input, stallExecutors.get(candidate.key));
    else {
      // An operator block's line waits for its thread, so it can link it.
      const blockId = candidate.key.startsWith(OPERATOR_BLOCK_KEY)
        ? itemBlockRef({ item_key: candidate.key, block_id: null })
        : undefined;
      const thread = blockId === undefined ? null : await blockThread(trx, blockId);
      await raiseItem(trx, { ...input, taskId: candidate.taskId, blockId: null }, thread);
    }
  }
}

/**
 * Start of the oldest last complete poll over the project's GitHub sources, or null while any is
 * missing, blind or never complete: a replacement PR can be in any of the project's repos.
 */
function prCompleteAt(
  project: Config['projects'][number] | undefined,
  sourceById: ReadonlyMap<string, Row<'source_state'>>,
): number | null {
  if (project === undefined) return null;
  let oldest = Infinity;
  for (const repo of project.repos) {
    const source = sourceById.get(prSourceId(project.id, repo));
    if (source === undefined || source.blind_reason !== null || source.last_complete_at === null)
      return null;
    oldest = Math.min(oldest, Date.parse(source.last_complete_at));
  }
  return oldest;
}

/**
 * Raises a ledger item with the operator block it stands for. An active item of the key is
 * returned as it is, so a repeated raise opens no second block.
 */
/** The reason of an item's block: the item text without its task key prefix. */
function blockReason(task: Row<'task'>, text: string): string {
  const prefix = `${task.key}: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

async function raiseAnomaly(
  trx: Trx,
  config: Config,
  task: Row<'task'>,
  input: Omit<RaiseItemInput, 'taskId' | 'blockId'>,
  executorId?: string,
): Promise<Row<'operator_item'>> {
  const active = await trx
    .selectFrom('operator_item')
    .selectAll()
    .where('item_key', '=', input.itemKey)
    .where('cleared_at', 'is', null)
    .executeTakeFirst();
  if (active !== undefined) return active;
  const toCurator =
    input.itemKey.startsWith('turn-stall:') &&
    curatorProject(config, task.project) !== null &&
    (await curatorSession(trx, config, task.project))?.id !== executorId;
  const block = await openSystemBlock(trx, {
    task,
    reason: blockReason(task, input.text),
    at: input.at.toISOString(),
    config,
    ...(toCurator ? { addressee: 'curator' as const } : {}),
  });
  return raiseItem(trx, { ...input, taskId: task.id, blockId: block.id });
}

/** Clears a reconciled item; a ledger item's open block is withdrawn by the board first. */
async function clearReconciled(
  trx: Trx,
  item: Row<'operator_item'>,
  at: Date,
  reason = 'condition ended',
): Promise<void> {
  if (item.block_id !== null) {
    const ctx = { actor: 'system' as const, at: at.toISOString() };
    await closeBlockIfOpen(trx, item.block_id, ctx, 'withdrawn', reason);
  }
  await clearItem(trx, item.id, at);
}

/**
 * Closes, as `moved`, each taken Done wrap-up turn of an unarchived Done task whose agent holder
 * session ended, and withdraws the stall items of that turn and holder with a reason naming both.
 * The holder can no longer submit, so a stall block on its turn would never clear.
 */
async function closeEndedDoneTurns(trx: Trx, at: Date): Promise<void> {
  const turns = await trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .select(['turn.id', 'turn.task_id', 'turn.acked_by'])
    .where('turn.closed_at', 'is', null)
    .where('turn.acked_at', 'is not', null)
    .where('turn.role', '!=', 'operator')
    .where('turn.column', '=', 'done')
    .where('task.column', '=', 'done')
    .where('task.membership', '!=', 'archived')
    .orderBy('turn.id')
    .execute();
  for (const turn of turns) {
    const holder = turn.acked_by === null ? undefined : parseActorId(turn.acked_by);
    if (holder?.actor !== 'agent') continue;
    const sessionId = holder.actorRef.session;
    const session = await trx
      .selectFrom('session_snapshot')
      .select('ended_at')
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (session === undefined || session.ended_at === null) continue;
    await closeTurns(trx, { taskId: turn.task_id, reason: 'moved', at });
    const keys = [
      `stuck-turn:${String(turn.id)}`,
      `health:${String(turn.task_id)}:${sessionId}:worker_lost`,
    ];
    const items = await trx
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'in', keys)
      .where('cleared_at', 'is', null)
      .execute();
    const reason = `turn T${String(turn.id)} closed: its holder ${sessionId} ended in Done`;
    for (const item of items) await clearReconciled(trx, item, at, reason);
  }
}

/**
 * Closes, as `moved`, each untaken worker-role Done wrap-up turn of an unarchived Done task when
 * no recipient is left: no live worker session is linked to the task and Done has no
 * orchestrator. The caller runs it only while Spur is current, so a missed session end does not
 * close a turn a live worker still holds.
 */
async function closeUnaddressedDoneTurns(trx: Trx, config: Config, at: Date): Promise<void> {
  const turns = await trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .select(['turn.task_id', 'task.project'])
    .where('turn.closed_at', 'is', null)
    .where('turn.acked_at', 'is', null)
    .where('turn.role', '=', 'worker')
    .where('turn.column', '=', 'done')
    .where('task.column', '=', 'done')
    .where('task.membership', '!=', 'archived')
    .orderBy('turn.id')
    .execute();
  for (const turn of turns) {
    const project = config.projects.find((candidate) => candidate.id === turn.project);
    if (project === undefined) continue;
    const orchestrator =
      project.columns.find((column) => column.id === 'done')?.orchestrator ?? 'none';
    if (orchestrator !== 'none') continue;
    if ((await linkedSession(trx, turn.task_id, 'worker')) !== undefined) continue;
    await closeTurns(trx, { taskId: turn.task_id, reason: 'moved', at });
  }
}

/** Raise ended-holder attention from ownership, independent of links, PRs and source freshness. */
async function endedTurnItems(
  trx: Trx,
  tasks: ReadonlyMap<number, Row<'task'>>,
  candidates: ItemCandidate[],
  at: Date,
  /** Start of Spur's last complete poll; each one confirms the holder is still ended. */
  spurConfirmedAt: string | null,
): Promise<Set<string>> {
  const holders = new Set<string>();
  const turns = await trx
    .selectFrom('turn')
    .selectAll()
    .where('closed_at', 'is', null)
    .where('acked_at', 'is not', null)
    .execute();
  for (const turn of turns) {
    const holder = turn.acked_by === null ? null : parseActorId(turn.acked_by);
    if (holder?.actor !== 'agent') continue;
    const sessionId = holder.actorRef.session;
    const session = await trx
      .selectFrom('session_snapshot')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (session === undefined || session.ended_at === null) continue;
    const parsed = sessionFactsSchema.safeParse(JSON.parse(session.detail));
    if (
      !parsed.success ||
      parsed.data.id !== sessionId ||
      parsed.data.spurProject !== holder.actorRef.project ||
      parsed.data.endedAt === null
    )
      continue;
    const keys = [
      `stuck-turn:${String(turn.id)}`,
      `health:${String(turn.task_id)}:${sessionId}:worker_lost`,
    ];
    const legacy = await trx
      .selectFrom('operator_item')
      .selectAll()
      .where('item_key', 'in', keys)
      .where('cleared_at', 'is', null)
      .execute();
    const recovery =
      turn.role === 'operator'
        ? `retake T${String(turn.id)} as the operator`
        : 'start a replacement worker or archive the task';
    const reason = `turn T${String(turn.id)} holder ${sessionId} ended; ${recovery}`;
    for (const item of legacy) await clearReconciled(trx, item, at, reason);
    const task = tasks.get(turn.task_id);
    if (
      task === undefined ||
      task.column === 'done' ||
      turn.column !== task.column ||
      turn.epoch !== task.column_epoch
    )
      continue;
    holders.add(`${String(task.id)}:${sessionId}`);
    candidates.push({
      key: `ended-turn:${String(turn.id)}:${sessionId}`,
      kind: 'worker_ended',
      taskId: task.id,
      summary: `${task.key}: turn T${String(turn.id)} holder ${sessionId} ended`,
      factAt: spurConfirmedAt ?? session.ended_at,
      revision: session.ended_at,
      source: 'spur',
      priority: 4,
    });
  }
  return holders;
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

/**
 * The Spur-derived anomaly keys a blind Spur holds open: a health flag of a session still linked
 * to its task, and a stuck turn `quietTurns` still lists, so a removed worker holder's link ends
 * the hold by the same rule that keeps its block closed after Spur recovers.
 */
async function blindHeldKeys(
  trx: Trx,
  subjects: readonly { taskId: string; id: string }[],
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const subject of subjects)
    for (const kind of ANOMALY_FLAGS)
      held.add(
        healthKey(Number(subject.taskId), { taskId: subject.taskId, sessionId: subject.id, kind }),
      );
  for (const { turn, ended } of await quietTurns(trx))
    if (!ended) held.add(`stuck-turn:${String(turn.id)}`);
  return held;
}

/** A producer's local healthSince can restart without a new current observed health state. */
async function observeTurnEpisode(trx: Trx, turnId: number, fact: SessionFacts | null) {
  const key = `turn_stall_episode:${String(turnId)}`;
  const row = await trx
    .selectFrom('meta')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  const previous = row === undefined ? undefined : parseJson(stallEpisodeSchema, row.value);
  if (
    previous !== undefined &&
    previous.session === (fact?.id ?? null) &&
    previous.health === (fact?.health ?? null)
  )
    return previous;
  const episode = {
    session: fact?.id ?? null,
    health: fact?.health ?? null,
    since: fact?.healthSince ?? null,
    revision: (previous?.revision ?? 0) + 1,
  };
  await trx
    .insertInto('meta')
    .values({ key, value: toJson(stallEpisodeSchema, episode) })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: toJson(stallEpisodeSchema, episode) }),
    )
    .execute();
  return episode;
}

/**
 * The stopped session an untaken turn of `role` with no live recipient is diagnosed against: the
 * newest stopped, present session linked to the task in that role, or for a column orchestrator
 * turn one of the column's orchestrator project `target`. It runs on every reconcile, so each
 * query is scoped to the task's links or to that project.
 */
async function stoppedExecutor(
  trx: Trx,
  taskId: number,
  role: string,
  target: string | undefined,
): Promise<Row<'session_snapshot'> | undefined> {
  const newestStopped = trx
    .selectFrom('session_snapshot')
    .selectAll('session_snapshot')
    .where('session_snapshot.state', '=', 'stopped')
    .where('session_snapshot.ended_at', 'is', null)
    .where('session_snapshot.absent_since', 'is', null)
    .orderBy('session_snapshot.first_seen', 'desc')
    .orderBy('session_snapshot.id')
    .limit(1);
  const linked = await newestStopped
    .innerJoin('link', 'link.session_id', 'session_snapshot.id')
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'session')
    .where('link.role', '=', role === 'worker' ? 'worker' : 'orchestrator')
    .where('link.banned', '=', 0)
    .executeTakeFirst();
  if (role === 'worker' || target === undefined) return linked;
  const inProject = await newestStopped
    .where('session_snapshot.spur_project', '=', target)
    .executeTakeFirst();
  if (linked === undefined || inProject === undefined) return linked ?? inProject;
  // The earlier of the two in the scan order: newest first seen, then the lower id.
  return inProject.first_seen > linked.first_seen ||
    (inProject.first_seen === linked.first_seen && inProject.id < linked.id)
    ? inProject
    : linked;
}

function healthKey(taskId: number, flag: SessionHealthFlag): string {
  return `health:${String(taskId)}:${flag.sessionId}:${flag.kind}`;
}
