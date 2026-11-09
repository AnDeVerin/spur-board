import { scanTransaction } from './secrets.ts';
import {
  RESERVED_PROJECT,
  entityRefSchema,
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  type AcceptedObservation,
  type AdapterCore,
  type Config,
  type EntityRef,
  type PrFacts,
  type SessionFacts,
  type SourceState,
  type TicketFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { sql } from 'kysely';
import { parseJson, toJson } from '../store/json.ts';
import type { Store } from '../store/store.ts';
import { emit, projectForKey, projectForSource, trackerSource, type Trx } from './board-utils.ts';
import { enqueueLiveAfterFirstPoll } from './doctor.ts';
import { reconcileMembership } from './membership-rules.ts';
import { reconcileItems } from './fromYou.ts';

function refKey(ref: EntityRef): string {
  switch (ref.kind) {
    case 'pr':
      return `pr:${ref.repo.toLowerCase()}#${String(ref.number)}`;
    case 'ticket':
      return `ticket:${ref.trackerId}:${ref.id ?? ref.key}`;
    case 'session':
      return `session:${ref.id}`;
  }
}

/** A closed issue of a GitHub Issues tracker, which lists only open issues. */
function closedIssue(project: Config['projects'][number], status: string): boolean {
  return project.tracker.type === 'github-issues' && status === 'closed';
}

async function updateTerminal(
  trx: Trx,
  config: Config,
  taskId: number,
  at: string,
  completeSince: ReadonlyMap<string, string>,
  blind: ReadonlySet<string>,
): Promise<void> {
  const task = await trx
    .selectFrom('task')
    .selectAll()
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow();
  const project = config.projects.find((entry) => entry.id === task.project);
  if (project === undefined) return;
  const ticket = await trx
    .selectFrom('ticket_snapshot')
    .select('status')
    .where('task_id', '=', taskId)
    .executeTakeFirst();
  const linked = await trx
    .selectFrom('link')
    .innerJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select('pr_snapshot.state')
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .execute();
  const hasOpen = linked.some((pr) => pr.state === 'open');
  const merged = linked.some((pr) => pr.state === 'merged');
  const doneTicket =
    ticket !== undefined &&
    (project.tracker.type === 'jira'
      ? project.tracker.doneStatuses.includes(ticket.status)
      : ticket.status === 'closed');
  const githubComplete = project.repos.every((repo) => {
    const source = `github:${project.id}:${repo.toLowerCase()}`;
    const complete = completeSince.get(source);
    return (
      !blind.has(source) &&
      complete !== undefined &&
      complete > (task.last_change_at ?? task.created_at)
    );
  });
  // Conflict links count too: `linked` has no pr_state filter, so an open conflict PR is in hasOpen.
  const terminal = !hasOpen && (merged || (doneTicket && githubComplete));
  await trx
    .updateTable('task')
    .set({
      terminal_at: terminal
        ? (task.terminal_at ?? (merged ? at : (task.last_change_at ?? at)))
        : null,
    })
    .where('id', '=', taskId)
    .execute();
}

async function sourceState(
  trx: Trx,
  source: string,
  state: SourceState,
  observedAt?: string,
  cursor?: string,
) {
  await trx
    .insertInto('source_state')
    .values({
      source,
      initialized: observedAt === undefined ? 0 : 1,
      last_complete_at: state.lastCompleteAt ?? null,
      blind_reason: state.blind?.reason ?? null,
      blind_message: state.blind?.message ?? null,
      cursor: cursor ?? null,
      observed_at: observedAt ?? null,
      gone: toJson(z.array(entityRefSchema), [...state.gone]),
    })
    .onConflict((oc) =>
      oc.column('source').doUpdateSet((eb) => ({
        initialized: observedAt === undefined ? eb.ref('source_state.initialized') : 1,
        last_complete_at: state.lastCompleteAt ?? null,
        blind_reason: state.blind?.reason ?? null,
        blind_message: state.blind?.message ?? null,
        cursor: cursor ?? eb.ref('source_state.cursor'),
        observed_at: observedAt ?? eb.ref('source_state.observed_at'),
        gone: toJson(z.array(entityRefSchema), [...state.gone]),
      })),
    )
    .execute();
}

/**
 * A merged pending key's open blocks were raised for the same ticket: they move to the surviving
 * task with what keeps them going (comments, threads, doorbells, items and undelivered rows).
 * Closed blocks and the journal stay with the archived row as its history.
 */
async function moveOpenWork(trx: Trx, from: number, to: number): Promise<void> {
  const blocks = await trx
    .selectFrom('block')
    .select('id')
    .where('task_id', '=', from)
    .where('state', '=', 'open')
    .execute();
  if (blocks.length === 0) return;
  const ids = blocks.map((block) => block.id);
  await trx.updateTable('block').set({ task_id: to }).where('id', 'in', ids).execute();
  for (const table of ['comment', 'conversation', 'notification', 'operator_item'] as const)
    await trx.updateTable(table).set({ task_id: to }).where('block_id', 'in', ids).execute();
  // Board-derived items have no block id; their keys name the block.
  const keys = ids.flatMap((id) => [`operator-block:${String(id)}`, `block:${String(id)}`]);
  await trx
    .updateTable('operator_item')
    .set({ task_id: to })
    .where('task_id', '=', from)
    .where('item_key', 'in', keys)
    .execute();
  const moved = await trx
    .selectFrom('operator_item')
    .select('item_key')
    .where('task_id', '=', to)
    .where((eb) => eb.or([eb('block_id', 'in', ids), eb('item_key', 'in', keys)]))
    .execute();
  const itemKeys = moved.map((item) => item.item_key);
  await trx
    .updateTable('outbox')
    .set({ payload: sql<string>`json_set(payload, '$.taskId', ${to})` })
    .where('state', 'not in', ['done', 'dead'])
    .where(sql<number>`json_extract(payload, '$.taskId')`, '=', from)
    .where((eb) =>
      eb.or([
        eb(sql<number>`json_extract(payload, '$.blockId')`, 'in', ids),
        ...(itemKeys.length === 0
          ? []
          : [eb(sql<string>`json_extract(payload, '$.itemKey')`, 'in', itemKeys)]),
      ]),
    )
    .execute();
}

async function ticket(
  trx: Trx,
  config: Config,
  fact: TicketFacts,
  at: string,
  source: string,
): Promise<void> {
  if (fact.trackerId !== source) throw new Error('Ticket from an unconfigured tracker');
  await trx
    .deleteFrom('source_miss')
    .where('source', '=', source)
    .where('ref_key', '=', `ticket:${source}:${fact.key}`)
    .execute();
  const project = config.projects.find((entry) => trackerSource(entry) === source);
  if (project === undefined) throw new Error('Ticket from an unconfigured tracker');
  let task = await trx
    .selectFrom('task')
    .selectAll()
    .where('project', '=', project.id)
    .where('tracker_kind', '=', project.tracker.type)
    .where('tracker_id', '=', fact.id)
    .executeTakeFirst();
  const pending = await trx
    .selectFrom('task')
    .selectAll()
    .where('project', '=', project.id)
    .where('key', '=', fact.key)
    .executeTakeFirst();
  if (task !== undefined && pending !== undefined && pending.id !== task.id) {
    const oldKey = task.key;
    await trx
      .updateTable('task')
      .set({ key: `__transfer__${String(task.id)}` })
      .where('id', '=', task.id)
      .execute();
    await trx
      .updateTable('task')
      .set({
        key: oldKey,
        manual_include: 0,
        manual_exclude: 0,
        membership: 'archived',
        archive_reason: 'manual',
      })
      .where('id', '=', pending.id)
      .execute();
    await emit(trx, 'task_archived', pending.project, pending.id, at, { reason: 'manual' });
    await moveOpenWork(trx, pending.id, task.id);
    await trx
      .updateTable('task')
      .set({
        key: fact.key,
        manual_include: pending.manual_include,
        manual_exclude: pending.manual_exclude,
        membership: pending.manual_include === 1 ? 'active' : task.membership,
        archive_reason: pending.manual_include === 1 ? null : task.archive_reason,
      })
      .where('id', '=', task.id)
      .execute();
    task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
  }
  if (task === undefined) task = pending;
  if (task?.manual_exclude === 1) return;
  if (task === undefined) {
    if (!fact.inFilter || closedIssue(project, fact.status)) return;
    task = await trx
      .insertInto('task')
      .values({
        project: project.id,
        tracker_kind: project.tracker.type,
        tracker_id: fact.id,
        key: fact.key,
        membership: 'active',
        archive_reason: null,
        column: 'todo',
        shadow_column: null,
        created_at: at,
        manual_include: 0,
        manual_exclude: 0,
        last_change_at: at,
        terminal_at: null,
        archive_slot_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await emit(trx, 'task_added', project.id, task.id, at, { column: task.column });
  } else if (task.tracker_id !== fact.id || task.key !== fact.key) {
    await trx
      .updateTable('task')
      .set({ tracker_id: fact.id, key: fact.key, last_change_at: at })
      .where('id', '=', task.id)
      .execute();
  }
  const previous = await trx
    .selectFrom('ticket_snapshot')
    .selectAll()
    .where('task_id', '=', task.id)
    .executeTakeFirst();
  const previousFact =
    previous === undefined ? null : parseJson(ticketFactsSchema, previous.detail);
  if (previousFact === null || JSON.stringify(previousFact) !== JSON.stringify(fact)) {
    await trx
      .insertInto('ticket_snapshot')
      .values({
        task_id: task.id,
        status: fact.status,
        assignee: fact.assignee,
        detail: toJson(ticketFactsSchema, fact),
        source,
        observed_at: at,
      })
      .onConflict((oc) =>
        oc.column('task_id').doUpdateSet({
          status: fact.status,
          assignee: fact.assignee,
          detail: toJson(ticketFactsSchema, fact),
          source,
          observed_at: at,
        }),
      )
      .execute();
    if (previousFact?.status !== fact.status)
      await emit(trx, 'ticket_status_changed', project.id, task.id, at, {
        from: previousFact?.status ?? null,
        to: fact.status,
      });
    await emit(trx, 'ticket_facts_changed', project.id, task.id, at, { facts: fact });
    await trx.updateTable('task').set({ last_change_at: at }).where('id', '=', task.id).execute();
  } else {
    await trx
      .updateTable('ticket_snapshot')
      .set({ observed_at: at })
      .where('task_id', '=', task.id)
      .execute();
  }
  if (
    fact.inFilter &&
    (task.membership === 'out_of_filter' || task.archive_reason === 'out_of_filter')
  ) {
    await trx
      .updateTable('task')
      .set({ membership: 'active', archive_reason: null })
      .where('id', '=', task.id)
      .execute();
    if (task.membership === 'out_of_filter')
      await emit(trx, 'flag_cleared', project.id, task.id, at, { flag: 'out_of_filter' });
    else await emit(trx, 'task_added', project.id, task.id, at, { column: task.column });
  }
}

async function pr(
  trx: Trx,
  config: Config,
  fact: PrFacts,
  at: string,
  source: string,
): Promise<void> {
  const old = await trx
    .selectFrom('pr_snapshot')
    .selectAll()
    .where(sql<boolean>`lower(repo) = ${fact.repo.toLowerCase()}`)
    .where('number', '=', fact.number)
    .executeTakeFirst();
  const previous = old === undefined ? null : parseJson(prFactsSchema, old.detail);
  const changed = previous === null || JSON.stringify(previous) !== JSON.stringify(fact);
  await trx
    .insertInto('pr_snapshot')
    .values({
      repo: old?.repo ?? fact.repo,
      number: fact.number,
      head_sha: fact.headSha,
      head_branch: fact.headBranch,
      state: fact.state,
      draft: fact.draft ? 1 : 0,
      mergeable: fact.mergeable,
      merge_state: fact.mergeState,
      detail: toJson(prFactsSchema, fact),
      source,
      observed_at: at,
    })
    .onConflict((oc) =>
      oc.columns(['repo', 'number']).doUpdateSet({
        head_sha: fact.headSha,
        head_branch: fact.headBranch,
        state: fact.state,
        draft: fact.draft ? 1 : 0,
        mergeable: fact.mergeable,
        merge_state: fact.mergeState,
        detail: toJson(prFactsSchema, fact),
        source,
        observed_at: at,
      }),
    )
    .execute();
  const project = projectForSource(config, source);
  if (project === undefined) return;
  for (const key of fact.ticketKeys) {
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('project', '=', project.id)
      .where('key', '=', key)
      .executeTakeFirst();
    if (task === undefined || task.membership === 'archived') continue;
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
  const linkedPrs = await trx
    .selectFrom('link')
    .select(['id', 'task_id', 'pr_state', 'source', 'banned'])
    .where('entity', '=', 'pr')
    .where(sql<boolean>`lower(repo) = ${fact.repo.toLowerCase()}`)
    .where('number', '=', fact.number)
    .execute();
  for (const link of linkedPrs) {
    if (fact.state !== 'open' || link.banned === 1) {
      await trx
        .updateTable('link')
        .set({ pr_open: fact.state === 'open' ? 1 : 0 })
        .where('id', '=', link.id)
        .execute();
      continue;
    }
    const other = await trx
      .selectFrom('link')
      .select(['id', 'source'])
      .where('task_id', '=', link.task_id)
      .where('entity', '=', 'pr')
      .where('pr_state', '=', 'active')
      .where('pr_open', '=', 1)
      .where('banned', '=', 0)
      .where('id', '!=', link.id)
      .executeTakeFirst();
    if (other !== undefined && link.source === 'manual' && other.source !== 'manual') {
      await trx
        .updateTable('link')
        .set({ pr_state: 'conflict' })
        .where('id', '=', other.id)
        .execute();
      await trx
        .updateTable('link')
        .set({ pr_state: 'active', pr_open: 1 })
        .where('id', '=', link.id)
        .execute();
    } else if (other !== undefined) {
      await trx
        .updateTable('link')
        .set({ pr_state: 'conflict', pr_open: 1 })
        .where('id', '=', link.id)
        .execute();
    } else {
      await trx.updateTable('link').set({ pr_open: 1 }).where('id', '=', link.id).execute();
    }
  }
  if (!changed) return;
  const links = await trx
    .selectFrom('link')
    .select(['task_id'])
    .where('entity', '=', 'pr')
    .where(sql<boolean>`lower(repo) = ${fact.repo.toLowerCase()}`)
    .where('number', '=', fact.number)
    .execute();
  for (const link of links) {
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', link.task_id)
      .executeTakeFirstOrThrow();
    if (previous?.headSha !== fact.headSha && previous !== null)
      await emit(trx, 'head_moved', task.project, task.id, at, {
        repo: fact.repo,
        pr: fact.number,
        from: previous.headSha,
        to: fact.headSha,
      });
    if (
      previous !== null &&
      JSON.stringify([previous.checks, previous.requiredChecks]) !==
        JSON.stringify([fact.checks, fact.requiredChecks])
    )
      await emit(trx, 'checks_changed', task.project, task.id, at, {
        repo: fact.repo,
        pr: fact.number,
        from: JSON.stringify([previous.checks, previous.requiredChecks]),
        to: JSON.stringify([fact.checks, fact.requiredChecks]),
        sha: fact.headSha,
      });
    if (previous !== null && previous.mergeable !== fact.mergeable)
      await emit(trx, 'mergeable_changed', task.project, task.id, at, {
        repo: fact.repo,
        pr: fact.number,
        from: previous.mergeable,
        to: fact.mergeable,
      });
    if (previous !== null && previous.state !== fact.state)
      await emit(trx, 'pr_state_changed', task.project, task.id, at, {
        repo: fact.repo,
        pr: fact.number,
        from: previous.state,
        to: fact.state,
      });
    for (const review of fact.reviews) {
      const oldReview = previous?.reviews.find((entry) => entry.reviewer === review.reviewer);
      if (
        oldReview === undefined ||
        oldReview.submittedAt !== review.submittedAt ||
        oldReview.state !== review.state
      )
        await emit(trx, 'review_submitted', task.project, task.id, at, {
          repo: fact.repo,
          pr: fact.number,
          reviewer: review.reviewer,
          state: review.state,
        });
    }
    await emit(trx, 'pr_facts_changed', task.project, task.id, at, { facts: fact });
    await trx.updateTable('task').set({ last_change_at: at }).where('id', '=', task.id).execute();
  }
}

// The key matches in any letter case, not after a letter or digit and not before a digit,
// so WEBDEV-56 is not found in XWEBDEV-56 or WEBDEV-5698.
function branchHasKey(branch: string, key: string): boolean {
  const text = branch.toLowerCase();
  const needle = key.toLowerCase();
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    if (!/[a-z0-9]/.test(text[index - 1] ?? '') && !/[0-9]/.test(text[index + needle.length] ?? ''))
      return true;
  }
  return false;
}

async function session(
  trx: Trx,
  config: Config,
  fact: SessionFacts,
  at: string,
  source: string,
  ambiguousBranches: ReadonlySet<string>,
): Promise<void> {
  const old = await trx
    .selectFrom('session_snapshot')
    .selectAll()
    .where('id', '=', fact.id)
    .executeTakeFirst();
  const previous = old === undefined ? null : parseJson(sessionFactsSchema, old.detail);
  const changed = previous === null || JSON.stringify(previous) !== JSON.stringify(fact);
  await trx
    .insertInto('session_snapshot')
    .values({
      id: fact.id,
      spur_project: fact.spurProject,
      branch: fact.branch,
      pr: fact.pr === null ? null : `${fact.pr.repo}#${String(fact.pr.number)}`,
      raw_state: fact.lifecycle,
      state: fact.lifecycle,
      first_seen: old?.first_seen ?? at,
      last_seen: at,
      ended_at: fact.endedAt,
      end_reason: fact.endReason,
      detail: toJson(sessionFactsSchema, fact),
      source,
      observed_at: at,
      absent_since: null,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        branch: fact.branch,
        pr: fact.pr === null ? null : `${fact.pr.repo}#${String(fact.pr.number)}`,
        raw_state: fact.lifecycle,
        state: fact.lifecycle,
        last_seen: at,
        ended_at: fact.endedAt,
        end_reason: fact.endReason,
        detail: toJson(sessionFactsSchema, fact),
        source,
        observed_at: at,
        absent_since: null,
      }),
    )
    .execute();
  // Explicit ticket links are read before branch inference and keep their first role.
  let key: string | undefined;
  let role: 'worker' | 'other' | undefined;
  for (const label of ['board-worker', 'board-other'] as const) {
    const url = fact.links[label];
    if (url === undefined) continue;
    const candidate =
      /\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)$/.exec(url)?.[1] ??
      /\/issues\/([1-9]\d*)$/.exec(url)?.[1];
    key =
      candidate === undefined
        ? undefined
        : url.includes('/issues/')
          ? `${new URL(url).pathname.split('/').slice(1, 3).join('/')}#${candidate}`
          : candidate;
    role = label === 'board-worker' ? 'worker' : 'other';
    if (key !== undefined) break;
  }
  if (key === undefined && fact.pr !== null) {
    const linked = await trx
      .selectFrom('link')
      .innerJoin('task', 'task.id', 'link.task_id')
      .select(['task.key', 'task.project'])
      .where('link.entity', '=', 'pr')
      .where(sql<boolean>`lower(link.repo) = ${fact.pr.repo.toLowerCase()}`)
      .where('link.number', '=', fact.pr.number)
      .where('link.banned', '=', 0)
      .executeTakeFirst();
    const project = config.projects.find((entry) => entry.id === linked?.project);
    if (
      project?.spurProjects.some((spur) => spur.name === fact.spurProject && spur.role === 'worker')
    )
      key = linked?.key;
  }
  if (key === undefined && fact.branch !== null) {
    const tasks = await trx
      .selectFrom('task')
      .selectAll()
      .where('membership', '!=', 'archived')
      .execute();
    const branchPrs = await trx
      .selectFrom('link')
      .innerJoin('pr_snapshot', (join) =>
        join
          .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
          .onRef('pr_snapshot.number', '=', 'link.number'),
      )
      .select(['link.task_id', 'pr_snapshot.head_branch'])
      .where('link.entity', '=', 'pr')
      .where('pr_snapshot.head_branch', '=', fact.branch)
      .where('link.banned', '=', 0)
      .execute();
    const matches = tasks.filter((task) => {
      const project = config.projects.find((entry) => entry.id === task.project);
      return (
        project?.spurProjects.some(
          (spur) => spur.name === fact.spurProject && spur.role === 'worker',
        ) === true &&
        ((fact.branch !== null && branchHasKey(fact.branch, task.key)) ||
          branchPrs.some((pr) => pr.task_id === task.id))
      );
    });
    if (matches.length === 1) {
      const candidate = matches[0];
      const worker =
        candidate === undefined
          ? undefined
          : await trx
              .selectFrom('link')
              .select('id')
              .where('task_id', '=', candidate.id)
              .where('entity', '=', 'session')
              .where('role', '=', 'worker')
              .where('banned', '=', 0)
              .executeTakeFirst();
      if (!ambiguousBranches.has(fact.branch) || worker !== undefined) key = candidate?.key;
    }
  }
  if (key !== undefined && projectForKey(config, key) !== null) {
    const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
    if (task !== undefined) {
      const existing = await trx
        .selectFrom('link')
        .selectAll()
        .where('entity', '=', 'session')
        .where('session_id', '=', fact.id)
        .where('task_id', '=', task.id)
        .executeTakeFirst();
      if (existing === undefined) {
        const worker = await trx
          .selectFrom('link')
          .selectAll()
          .where('task_id', '=', task.id)
          .where('entity', '=', 'session')
          .where('role', '=', 'worker')
          .where('banned', '=', 0)
          .executeTakeFirst();
        const chosenRole = role ?? (worker === undefined ? 'worker' : 'other');
        await trx
          .insertInto('link')
          .values({
            task_id: task.id,
            entity: 'session',
            repo: null,
            number: null,
            pr_state: null,
            session_id: fact.id,
            role: chosenRole,
            source: role === undefined ? 'branch' : 'spawn_link',
            banned: 0,
            created_at: at,
            ticket_key: null,
            pr_open: null,
          })
          .execute();
        await emit(trx, 'link_added', task.project, task.id, at, {
          entity: 'session',
          session: fact.id,
          role: chosenRole,
          source: role === undefined ? 'branch' : 'spawn_link',
          facts: fact,
        });
      }
    }
  }
  if (!changed) return;
  const links = await trx
    .selectFrom('link')
    .select(['task_id'])
    .where('entity', '=', 'session')
    .where('session_id', '=', fact.id)
    .execute();
  for (const link of links) {
    const task = await trx
      .selectFrom('task')
      .selectAll()
      .where('id', '=', link.task_id)
      .executeTakeFirstOrThrow();
    if (previous?.lifecycle !== fact.lifecycle && previous !== null)
      await emit(trx, 'session_state_changed', task.project, task.id, at, {
        session: fact.id,
        from: previous.lifecycle,
        to: fact.lifecycle,
      });
    await emit(trx, 'session_facts_changed', task.project, task.id, at, { facts: fact });
    await trx.updateTable('task').set({ last_change_at: at }).where('id', '=', task.id).execute();
  }
}

/** Core's adapter-facing port. Every accepted batch and its source state share one transaction. */
export function createObservationCore(deps: {
  store: Store;
  config: Config;
  clock: { now(): number };
  productVersion?: string;
}): AdapterCore & {
  notice(kind: 'unknown_state' | 'unknown_status', value: string): Promise<void>;
  completeSince: Map<string, string>;
} {
  const { store, config, clock } = deps;
  const completeSince = new Map<string, string>();
  return {
    completeSince,
    async context(source) {
      const state = await store.db
        .selectFrom('source_state')
        .selectAll()
        .where('source', '=', source)
        .executeTakeFirst();
      const project = projectForSource(config, source);
      const tickets =
        project !== undefined && source === trackerSource(project)
          ? (
              await store.db
                .selectFrom('task')
                .leftJoin('ticket_snapshot', 'ticket_snapshot.task_id', 'task.id')
                .select([
                  'task.key',
                  'task.tracker_id',
                  'task.manual_include',
                  'ticket_snapshot.detail',
                ])
                .where('project', '=', project.id)
                .where('membership', '!=', 'archived')
                .execute()
            ).flatMap((task) => {
              const detail =
                task.detail === null ? null : parseJson(ticketFactsSchema, task.detail);
              const outside = detail !== null && !detail.inFilter;
              const openIssue =
                project.tracker.type === 'github-issues' &&
                detail !== null &&
                !closedIssue(project, detail.status);
              return task.manual_include === 1 || outside || openIssue
                ? [
                    {
                      kind: 'ticket' as const,
                      trackerId: source,
                      ...(task.tracker_id === null ? {} : { id: task.tracker_id }),
                      key: task.key,
                    },
                  ]
                : [];
            })
          : [];
      const repo = source.startsWith('github:') ? source.slice(source.lastIndexOf(':') + 1) : null;
      const prs =
        repo === null
          ? []
          : (
              await store.db
                .selectFrom('link')
                .select(['repo', 'number'])
                .where('entity', '=', 'pr')
                .where(sql<boolean>`lower(repo) = ${repo.toLowerCase()}`)
                .where('banned', '=', 0)
                .execute()
            ).flatMap((link) =>
              link.repo === null || link.number === null
                ? []
                : [{ kind: 'pr' as const, repo: link.repo, number: link.number }],
            );
      const sessions =
        source === 'spur'
          ? (
              await store.db
                .selectFrom('link')
                .innerJoin('session_snapshot', 'session_snapshot.id', 'link.session_id')
                .select('link.session_id')
                .where('link.entity', '=', 'session')
                .where('session_snapshot.ended_at', 'is', null)
                .execute()
            ).flatMap((link) =>
              link.session_id === null ? [] : [{ kind: 'session' as const, id: link.session_id }],
            )
          : [];
      const misses = await store.db
        .selectFrom('source_miss')
        .selectAll()
        .where('source', '=', source)
        .execute();
      return {
        observe: {
          prs: [...new Map(prs.map((ref) => [refKey(ref), ref])).values()],
          tickets,
          sessions: [...new Map(sessions.map((ref) => [refKey(ref), ref])).values()],
        },
        ...(state?.cursor === null || state === undefined
          ? {}
          : {
              cursor: state.cursor as NonNullable<
                Awaited<ReturnType<AdapterCore['context']>>['cursor']
              >,
            }),
        missCounts: misses.flatMap((row) => {
          const ref = parseJson(entityRefSchema, row.ref);
          return ref.kind === 'session' ? [] : [{ ref, count: row.misses }];
        }),
      };
    },
    async observe(source, observation: AcceptedObservation) {
      const { batch } = observation;
      // Read once: every scan pass must build the same gateway strings (`scanTransaction`).
      const now = clock.now();
      await scanTransaction(store, config, async (trx) => {
        await sourceState(trx, source, observation.state, batch.observedAt, batch.cursor);
        for (const outcome of observation.outcomes) {
          const answer = batch.entities.find(
            (entity) => refKey(entity.ref) === refKey(outcome.ref),
          );
          await trx
            .insertInto('source_miss')
            .values({
              source,
              ref_key: refKey(outcome.ref),
              ref: toJson(entityRefSchema, outcome.ref),
              misses: outcome.misses,
              gone: outcome.gone ? 1 : 0,
              outcome: answer?.status ?? null,
            })
            .onConflict((oc) =>
              oc.columns(['source', 'ref_key']).doUpdateSet({
                misses: outcome.misses,
                gone: outcome.gone ? 1 : 0,
                outcome: answer?.status ?? null,
              }),
            )
            .execute();
        }
        const branchCounts = new Map<string, number>();
        for (const item of batch.items)
          if (
            item.kind === 'session' &&
            item.facts.branch !== null &&
            item.facts.links['board-worker'] === undefined &&
            item.facts.links['board-other'] === undefined
          )
            branchCounts.set(item.facts.branch, (branchCounts.get(item.facts.branch) ?? 0) + 1);
        const ambiguous = new Set(
          [...branchCounts].filter(([, count]) => count > 1).map(([branch]) => branch),
        );
        const orderedItems = [...batch.items].sort((left, right) => {
          const rank = (item: typeof left) =>
            item.kind === 'ticket'
              ? 0
              : item.kind === 'pr'
                ? 1
                : item.facts.links['board-worker'] === undefined
                  ? 3
                  : 2;
          return rank(left) - rank(right);
        });
        for (const item of orderedItems) {
          if (item.kind === 'ticket')
            await ticket(trx, config, item.facts, batch.observedAt, source);
          else if (item.kind === 'pr') await pr(trx, config, item.facts, batch.observedAt, source);
          else await session(trx, config, item.facts, batch.observedAt, source, ambiguous);
        }
        for (const entity of batch.entities) {
          if (entity.ref.kind !== 'session' || entity.status !== 'not_found') continue;
          const old = await trx
            .selectFrom('session_snapshot')
            .selectAll()
            .where('id', '=', entity.ref.id)
            .executeTakeFirst();
          if (old === undefined || old.ended_at !== null) continue;
          const fact = parseJson(sessionFactsSchema, old.detail);
          const ended = { ...fact, endedAt: batch.observedAt, endReason: 'vanished' as const };
          await trx
            .updateTable('session_snapshot')
            .set({
              ended_at: batch.observedAt,
              end_reason: 'vanished',
              detail: toJson(sessionFactsSchema, ended),
              observed_at: batch.observedAt,
            })
            .where('id', '=', old.id)
            .execute();
          const links = await trx
            .selectFrom('link')
            .select(['task_id'])
            .where('entity', '=', 'session')
            .where('session_id', '=', old.id)
            .execute();
          for (const link of links) {
            const task = await trx
              .selectFrom('task')
              .selectAll()
              .where('id', '=', link.task_id)
              .executeTakeFirstOrThrow();
            await emit(trx, 'session_state_changed', task.project, task.id, batch.observedAt, {
              session: old.id,
              from: fact.lifecycle,
              to: fact.lifecycle,
              endReason: 'vanished',
            });
            await emit(trx, 'session_facts_changed', task.project, task.id, batch.observedAt, {
              facts: ended,
            });
          }
        }
        // A complete poll that omits a session starts its absence; a later listing clears it.
        if (observation.effectiveComplete)
          await trx
            .updateTable('session_snapshot')
            .set({ absent_since: batch.observedAt })
            .where('source', '=', source)
            .where('absent_since', 'is', null)
            .where('last_seen', '<', batch.observedAt)
            .execute();
        if (observation.effectiveComplete) {
          const project = config.projects.find((entry) => trackerSource(entry) === source);
          if (project !== undefined) {
            const seen = new Set(
              batch.items.flatMap((item) =>
                item.kind === 'ticket' && item.facts.inFilter ? [item.facts.id] : [],
              ),
            );
            const unresolved = new Set(
              batch.entities.flatMap((entity) =>
                entity.ref.kind === 'ticket' &&
                entity.status !== 'ok' &&
                !observation.outcomes.some(
                  (outcome) => refKey(outcome.ref) === refKey(entity.ref) && outcome.gone,
                )
                  ? [entity.ref.id ?? entity.ref.key]
                  : [],
              ),
            );
            const rows = await trx
              .selectFrom('ticket_snapshot')
              .innerJoin('task', 'task.id', 'ticket_snapshot.task_id')
              .select([
                'ticket_snapshot.task_id',
                'ticket_snapshot.detail',
                'task.tracker_id',
                'task.key',
                'task.membership',
              ])
              .where('task.project', '=', project.id)
              .where('task.manual_include', '=', 0)
              .where('task.manual_exclude', '=', 0)
              .execute();
            for (const row of rows) {
              if (project.tracker.type === 'github-issues' && row.membership === 'archived')
                continue;
              if (
                unresolved.has(row.key) ||
                (row.tracker_id !== null &&
                  (seen.has(row.tracker_id) || unresolved.has(row.tracker_id)))
              )
                continue;
              const fact = parseJson(ticketFactsSchema, row.detail);
              if (!fact.inFilter || closedIssue(project, fact.status)) continue;
              const outside = { ...fact, inFilter: false };
              await trx
                .updateTable('ticket_snapshot')
                .set({ detail: toJson(ticketFactsSchema, outside), observed_at: batch.observedAt })
                .where('task_id', '=', row.task_id)
                .execute();
              await emit(trx, 'ticket_facts_changed', project.id, row.task_id, batch.observedAt, {
                facts: outside,
              });
              await trx
                .updateTable('task')
                .set({ last_change_at: batch.observedAt })
                .where('id', '=', row.task_id)
                .execute();
            }
          }
        }
        const currentComplete = new Map(completeSince);
        if (observation.effectiveComplete) currentComplete.set(source, batch.observedAt);
        const states = await trx
          .selectFrom('source_state')
          .select(['source', 'blind_reason'])
          .execute();
        const blind = new Set(
          states.filter((state) => state.blind_reason !== null).map((state) => state.source),
        );
        const activeTasks = await trx
          .selectFrom('task')
          .select('id')
          .where('membership', '!=', 'archived')
          .execute();
        for (const task of activeTasks)
          await updateTerminal(trx, config, task.id, batch.observedAt, currentComplete, blind);
        await reconcileMembership(trx, config, currentComplete, batch.observedAt);
        await reconcileItems(trx, config, now, currentComplete.has('spur'));
        if (deps.productVersion !== undefined)
          await enqueueLiveAfterFirstPoll(trx, {
            config,
            productVersion: deps.productVersion,
            completeSince: currentComplete,
            blind,
            at: batch.observedAt,
          });
      });
      if (observation.effectiveComplete) completeSince.set(source, batch.observedAt);
    },
    reportSourceState(source, state) {
      const now = clock.now();
      return scanTransaction(store, config, async (trx) => {
        await sourceState(trx, source, state);
        await reconcileItems(trx, config, now, completeSince.has('spur'));
      });
    },
    notice(kind, value) {
      const at = new Date(clock.now()).toISOString();
      return scanTransaction(store, config, async (trx) => {
        const key = `spur-notice:${kind}:${value}`;
        const old = await trx
          .selectFrom('meta')
          .select('key')
          .where('key', '=', key)
          .executeTakeFirst();
        if (old !== undefined) return;
        await trx.insertInto('meta').values({ key, value: 'true' }).execute();
        await emit(trx, 'spur_unknown_state', RESERVED_PROJECT, null, at, { kind, value });
      });
    },
  };
}
