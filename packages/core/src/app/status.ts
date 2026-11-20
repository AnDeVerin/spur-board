import {
  configBindings,
  mirrorSourceId,
  prFactsSchema,
  prSourceId,
  sessionFactsSchema,
  ticketFactsSchema,
  trackerSourceId,
  type Config,
  type PrFacts,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import { sql } from 'kysely';
import type { z } from 'zod';
import { parseJson } from '../store/json.ts';
import type { Store } from '../store/store.ts';
import { approvalViews } from './approval-watch.ts';
import { projectForSource } from './board-utils.ts';
import { CommandError } from './commands.ts';
import { itemOwner } from './items.ts';
import { latestQaSubmissions, latestSubmissions } from './submissions.ts';
import { readOutageEnds, services } from './status-services.ts';
import {
  columnGroupViews,
  orderTodoGroupRows,
  counts,
  readStatusBlocks,
  readStatusColumnEntries,
  readStatusReturns,
  readStatusTurns,
  sessionView,
  summarizePr,
  sourceInterval,
  sourceView,
} from './status-views.ts';

/** End reasons in the words of the "worker ended" item (`ENDED_WORKER_LABELS`, fromYou.ts). */
export const END_WORDS = {
  complete: 'completed',
  kill: 'killed',
  vanished: 'vanished',
  unknown: 'unknown',
} as const satisfies Record<NonNullable<SessionFacts['endReason']>, string>;

/** A linked session's label in the task row: `ended (<reason>)` once the board knows it ended. */
function sessionLabel(fact: SessionFacts, absentSince: string | null): string {
  if (fact.endReason !== null) return `ended (${END_WORDS[fact.endReason]})`;
  if (fact.lifecycle === 'killed' || fact.lifecycle === 'completed')
    return `ended (${fact.lifecycle})`;
  if (absentSince !== null) return 'ended (gone)';
  return fact.health;
}

/** The one-line task state: ticket status, pull request states, session counts by label. */
function taskState(
  ticket: TicketFacts | null,
  prs: readonly PrFacts[],
  sessions: readonly { fact: SessionFacts; absentSince: string | null }[],
): string {
  const parts = [ticket === null ? 'ticket not observed' : `ticket ${ticket.status}`];
  if (prs.length > 0) {
    const labels = prs.map((pr) => (pr.state === 'open' && pr.draft ? 'draft' : pr.state));
    parts.push(`PRs ${counts(labels, ['draft', 'open', 'merged', 'closed'])}`);
  }
  if (sessions.length > 0) {
    const labels = sessions.map((session) => sessionLabel(session.fact, session.absentSince));
    parts.push(`sessions ${counts(labels, [...new Set(labels)].sort())}`);
  }
  return parts.join('; ');
}

/** The tracker repo of a GitHub Issues project, lowercased; null for Jira or no project. */
function issuesRepo(project: Config['projects'][number] | undefined): string | null {
  return project?.tracker.type === 'github-issues' ? project.tracker.repo.toLowerCase() : null;
}

/** Unlinked PRs and sessions finished longer ago than this are counted, not listed. */
const UNLINKED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type StatusOutput = z.output<typeof statusOutputSchema>;

/** Reads the board's latest facts, items and source availability. */
export async function getStatus(
  deps: {
    store: Pick<Store, 'db'>;
    config: Config;
    clock: { now(): number };
    completeSince: ReadonlyMap<string, string>;
    /** Configured chat gateway kinds; each is reported even with no health rows. */
    gateways?: readonly string[] | undefined;
    /** The running daemon; defaults to an unknown version started now, before any tick. */
    daemon?: { version: string; startedAt: string; lastDispatchAt: string | null } | undefined;
    /** When each source became usable in this daemon run; defaults to none. */
    healthySince?: ReadonlyMap<string, string> | undefined;
    /** Sources the adapter runner of this run pauses for the rate budget; defaults to none. */
    budgetWaits?: ReadonlySet<string> | undefined;
    /** The last host sample, or null before the first; never sampled here. */
    host?: StatusOutput['host'] | undefined;
  },
  options: {
    project?: string | undefined;
    visibleProjects?: ReadonlySet<string> | undefined;
    includeBoardItems?: boolean | undefined;
    /**
     * Projects whose operator the caller is: without `includeBoardItems`, it still sees the
     * failed deliveries of those projects' tasks, which it may retry and close.
     */
    operatorProjects?: ReadonlySet<string> | undefined;
    /** Adds full ticket, pull request and session facts to every row. */
    detail?: boolean | undefined;
  } = {},
) {
  const { store, config, clock, completeSince, gateways = [] } = deps;
  const daemon = deps.daemon ?? {
    version: 'unknown',
    startedAt: new Date(clock.now()).toISOString(),
    lastDispatchAt: null,
  };
  const { project: projectId, visibleProjects, detail = false } = options;
  const includeBoardItems = options.includeBoardItems ?? visibleProjects === undefined;
  const operatorProjects = options.operatorProjects ?? new Set<string>();
  const visible = config.projects.filter(
    (project) => visibleProjects === undefined || visibleProjects.has(project.id),
  );
  const projects =
    projectId === undefined ? visible : visible.filter((project) => project.id === projectId);
  if (projects.length === 0) throw new CommandError('not_found', 'Check the project ID.');
  const projectIds = new Set(projects.map((project) => project.id));
  const rows = await store.db
    .selectFrom('task')
    .selectAll()
    .where('membership', '!=', 'archived')
    .execute();
  const openBlocks = await readStatusBlocks(store.db, projectIds);
  // Project-level blocks have no task row to count on: one entry per requested project.
  const projectBlockRows = await store.db
    .selectFrom('block')
    .select(['project', (eb) => eb.fn.countAll<number>().as('open')])
    .where('state', '=', 'open')
    .where('task_id', 'is', null)
    .groupBy('project')
    .execute();
  const openProjectBlocks = new Map(projectBlockRows.map((row) => [row.project, row.open]));
  const projectBlocks = projects.map((project) => ({
    project: project.id,
    openBlocks: openProjectBlocks.get(project.id) ?? 0,
  }));
  const sourceRows = await store.db.selectFrom('source_state').selectAll().execute();
  const sourceById = new Map(sourceRows.map((row) => [row.source, row]));
  const turns = await readStatusTurns(store.db, projectIds);
  const returns = await readStatusReturns(store.db, projectIds);
  const entries = await readStatusColumnEntries(store.db, projectIds);
  const columnEntries = new Map(entries.map((entry) => [entry.task_id, entry.at]));
  orderTodoGroupRows(rows, entries, projects);
  const tasks = [];
  const submissions = await latestSubmissions(store.db, rows);
  const qaSubmissions = await latestQaSubmissions(store.db, rows, { projects });
  for (const task of rows) {
    if (!projectIds.has(task.project)) continue;
    const ticket = await store.db
      .selectFrom('ticket_snapshot')
      .selectAll()
      .where('task_id', '=', task.id)
      .executeTakeFirst();
    const taskLinks = await store.db
      .selectFrom('link')
      .selectAll()
      .where('task_id', '=', task.id)
      .execute();
    const links = taskLinks.filter((link) => link.banned === 0);
    const project = config.projects.find((entry) => entry.id === task.project);
    const prs: PrFacts[] = [];
    const summaries = [];
    const sessions: SessionFacts[] = [];
    const sessionStates: { fact: SessionFacts; absentSince: string | null }[] = [];
    for (const link of links) {
      if (link.entity === 'pr' && link.repo !== null && link.number !== null) {
        const snapshot = await store.db
          .selectFrom('pr_snapshot')
          .select(['detail', 'source', 'observed_at'])
          .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
          .where('number', '=', link.number)
          .executeTakeFirst();
        if (snapshot !== undefined) {
          const fact = parseJson(prFactsSchema, snapshot.detail);
          prs.push(fact);
          const source = sourceById.get(snapshot.source);
          const unconfirmed =
            source === undefined ||
            source.blind_reason !== null ||
            clock.now() - Date.parse(snapshot.observed_at) >
              config.thresholds.staleMultiplier * sourceInterval(config, snapshot.source);
          const approvals = await approvalViews(store.db, fact, project?.approvalWatch);
          summaries.push(summarizePr(fact, snapshot.observed_at, unconfirmed, approvals));
        }
      } else if (link.entity === 'session' && link.session_id !== null) {
        const snapshot = await store.db
          .selectFrom('session_snapshot')
          .select(['detail', 'absent_since'])
          .where('id', '=', link.session_id)
          .executeTakeFirst();
        if (snapshot !== undefined) {
          const fact = parseJson(sessionFactsSchema, snapshot.detail);
          sessions.push(fact);
          sessionStates.push({ fact, absentSince: snapshot.absent_since });
        }
      }
    }
    const ticketFacts = ticket === undefined ? null : parseJson(ticketFactsSchema, ticket.detail);
    const trackerRepo = issuesRepo(project);
    const linkHints: string[] = [];
    for (const session of sessions) {
      const pr = session.pr;
      if (trackerRepo === null || pr === null || pr.repo.toLowerCase() !== trackerRepo) continue;
      // Any link row, a removed one included, means the rules are not the reason.
      const known = taskLinks.some(
        (link) =>
          link.entity === 'pr' &&
          link.repo?.toLowerCase() === trackerRepo &&
          link.number === pr.number,
      );
      if (known) continue;
      const snapshot = await store.db
        .selectFrom('pr_snapshot')
        .select('detail')
        .where(sql<boolean>`lower(repo) = ${trackerRepo}`)
        .where('number', '=', pr.number)
        .executeTakeFirst();
      if (snapshot === undefined) continue;
      const keys = parseJson(prFactsSchema, snapshot.detail).ticketKeys;
      if (keys.some((key) => key.toLowerCase() === task.key.toLowerCase())) continue;
      linkHints.push(
        `Session ${session.id} has PR ${pr.repo}#${String(pr.number)}, but the link rules give it no link to this task; check projects[].link in config.yaml.`,
      );
    }
    const blocks = openBlocks.get(task.id) ?? [];
    const returned = returns.get(task.id);
    tasks.push({
      key: task.key,
      submission: submissions.get(task.id) ?? null,
      qaSubmission: qaSubmissions.get(task.id) ?? null,
      project: task.project,
      column: task.column,
      position: task.position,
      columnEnteredAt: columnEntries.get(task.id) ?? task.created_at,
      membership: task.membership,
      ...(project?.dispatcher.mode === 'shadow'
        ? {
            shadowColumn: task.shadow_column ?? task.column,
            shadowDiffers: (task.shadow_column ?? task.column) !== task.column,
          }
        : {}),
      state: taskState(ticketFacts, prs, sessionStates),
      prCount: links.filter((link) => link.entity === 'pr').length,
      sessionCount: links.filter((link) => link.entity === 'session').length,
      openBlocks: blocks.length,
      blocks,
      ...(returned === undefined ? {} : { returned }),
      turn: turns.get(task.id) ?? null,
      prSummary: summaries.length === 0 ? null : summaries,
      links: {
        ticket: ticketFacts?.url ?? null,
        prs: links.flatMap((link) =>
          link.entity === 'pr' && link.repo !== null && link.number !== null
            ? [
                {
                  repo: link.repo,
                  number: link.number,
                  url:
                    prs.find(
                      (pr) =>
                        pr.repo.toLowerCase() === link.repo?.toLowerCase() &&
                        pr.number === link.number,
                    )?.url ?? `https://github.com/${link.repo}/pull/${String(link.number)}`,
                },
              ]
            : [],
        ),
        sessions: links.flatMap((link) =>
          link.entity === 'session' && link.session_id !== null ? [{ id: link.session_id }] : [],
        ),
      },
      ...(linkHints.length > 0 ? { linkHints } : {}),
      ...(detail
        ? {
            ticket: ticketFacts,
            prs,
            sessions: sessions.map(sessionView),
          }
        : {}),
    });
  }
  const pastWindow = (at: string) => clock.now() - Date.parse(at) > UNLINKED_WINDOW_MS;
  const allPrs = await store.db.selectFrom('pr_snapshot').selectAll().execute();
  const allSessions = await store.db.selectFrom('session_snapshot').selectAll().execute();
  const allLinks = await store.db.selectFrom('link').selectAll().where('banned', '=', 0).execute();
  const bannedPrLinks = await store.db
    .selectFrom('link')
    .select(['repo', 'number'])
    .where('entity', '=', 'pr')
    .where('banned', '=', 1)
    .execute();
  /** Why the link rules left an open tracker-repo PR unlinked, or undefined. */
  const unlinkedReason = (source: string, facts: PrFacts): string | undefined => {
    if (facts.state !== 'open') return undefined;
    const project = projectForSource(config, source);
    if (project === undefined || issuesRepo(project) !== facts.repo.toLowerCase()) return undefined;
    // The operator removed a link to this PR: the rules are not the reason.
    const removed = bannedPrLinks.some(
      (link) =>
        link.repo?.toLowerCase() === facts.repo.toLowerCase() && link.number === facts.number,
    );
    if (removed) return undefined;
    if (facts.ticketKeys.length === 0) return 'no key in branch or title by the link rules';
    const onBoard = facts.ticketKeys.some((key) =>
      rows.some((task) => task.project === project.id && task.key === key),
    );
    return onBoard ? undefined : `no task on the board for ${facts.ticketKeys.join(', ')}`;
  };
  const prRows = allPrs
    .filter(
      (pr) =>
        projects.some((project) =>
          project.repos.some((repo) => repo.toLowerCase() === pr.repo.toLowerCase()),
        ) &&
        !allLinks.some(
          (link) =>
            link.entity === 'pr' &&
            link.repo?.toLowerCase() === pr.repo.toLowerCase() &&
            link.number === pr.number,
        ),
    )
    .map((pr) => ({ pr, facts: parseJson(prFactsSchema, pr.detail) }));
  const hiddenPr = (facts: PrFacts) => facts.state !== 'open' && pastWindow(facts.updatedAt);
  const unlinkedPrs = prRows
    .filter(({ facts }) => !hiddenPr(facts))
    .map(({ pr, facts }) => {
      const reason = unlinkedReason(pr.source, facts);
      const why = reason === undefined ? {} : { reason };
      if (detail) return { ...facts, ...why };
      const { repo, number, url, title, state, draft } = facts;
      return { repo, number, url, title, state, draft, ...why };
    });
  const sessionRows = allSessions.filter(
    (session) =>
      projects.some((project) =>
        project.spurProjects.some((spur) => spur.name === session.spur_project),
      ) && !allLinks.some((link) => link.entity === 'session' && link.session_id === session.id),
  );
  /** Ended, or omitted by complete Spur polls, for longer than the window. */
  const hiddenSession = (session: (typeof sessionRows)[number]) => {
    const ended =
      session.ended_at !== null ||
      session.state === 'completed' ||
      session.state === 'killed' ||
      session.absent_since !== null;
    return ended && pastWindow(session.ended_at ?? session.absent_since ?? session.last_seen);
  };
  const unlinkedSessions = sessionRows
    .filter((session) => !hiddenSession(session))
    .map((session) => {
      const facts = parseJson(sessionFactsSchema, session.detail);
      if (detail) return sessionView(facts);
      const { id, spurProject, branch, lifecycle, health } = facts;
      return { id, spurProject, branch, lifecycle, health };
    });
  const sourceIds = (scope: readonly Config['projects'][number][], mirrors: boolean) =>
    new Set([
      'spur',
      ...scope.flatMap((project) => {
        const mirror = mirrors ? mirrorSourceId(project) : undefined;
        return [
          trackerSourceId(project),
          ...project.repos.map((repo) => prSourceId(project.id, repo)),
          ...(mirror === undefined ? [] : [mirror]),
        ];
      }),
    ]);
  // Items and warmingUp follow the requested projects; sources and services stay board-wide
  // (every project the caller may see), so the web bar shows every service whatever is chosen.
  // A GitHub Project mirror is listed and rolled into services, but the board never waits on it.
  const required = sourceIds(projects, false);
  const boardSources = sourceIds(visible, true);
  const costs = await store.db
    .selectFrom('source_cost')
    .select(['source', 'points'])
    .where('at', '>', new Date(clock.now() - 3_600_000).toISOString())
    .where('at', '<=', new Date(clock.now()).toISOString())
    .execute();
  const points = new Map<string, number>();
  for (const cost of costs) points.set(cost.source, (points.get(cost.source) ?? 0) + cost.points);
  const sources = [...boardSources].map((source) =>
    sourceView({
      source,
      row: sourceById.get(source),
      config,
      now: clock.now(),
      points,
      completeSince,
      healthySince: deps.healthySince,
      budgetWaits: deps.budgetWaits,
    }),
  );
  const itemRows = await store.db
    .selectFrom('operator_item')
    .selectAll()
    .where('cleared_at', 'is', null)
    .execute();
  const itemTasks = new Map(rows.map((task) => [task.id, task]));
  const ownedProjects = new Map<number, string>();
  if (!includeBoardItems && operatorProjects.size > 0) {
    for (const item of itemRows) {
      if (item.task_id !== null || item.source !== null) continue;
      const owner = await itemOwner(store.db, item);
      if (owner !== undefined) ownedProjects.set(item.id, owner.project);
    }
  }
  const ownedBy = (item: { id: number }) => {
    const owner = ownedProjects.get(item.id) ?? '';
    return projectIds.has(owner) && operatorProjects.has(owner);
  };
  const items = itemRows
    .filter((item) =>
      item.task_id !== null
        ? projectIds.has(itemTasks.get(item.task_id)?.project ?? '')
        : item.source !== null
          ? required.has(item.source)
          : includeBoardItems || ownedBy(item),
    )
    .map((item) => {
      const source = item.source === null ? null : sourceById.get(item.source);
      const stale =
        item.fact_at !== null &&
        item.source !== null &&
        clock.now() - Date.parse(item.fact_at) >
          config.thresholds.staleMultiplier * sourceInterval(config, item.source);
      const unconfirmed =
        stale ||
        item.text.includes('no_access') ||
        (source !== null && source !== undefined && source.blind_reason !== null);
      const time =
        item.fact_at === null ? null : new Date(item.fact_at).toISOString().slice(11, 16);
      return {
        id: `I${String(item.id)}`,
        key: item.item_key,
        task: item.task_id === null ? null : (itemTasks.get(item.task_id)?.key ?? null),
        at: item.raised_at,
        summary: unconfirmed
          ? `${item.text} (not confirmed${time === null ? '' : `, fact from ${time}`})`
          : item.text,
        factAt: item.fact_at,
        unconfirmed,
      };
    })
    .sort((a, b) => {
      const priority = (key: string) =>
        itemRows.find((item) => item.item_key === key)?.priority ?? 4;
      return priority(a.key) - priority(b.key) || a.at.localeCompare(b.at);
    });
  const host = await store.db
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'host_load_episode')
    .executeTakeFirst();
  const spur = sourceById.get('spur');
  const healthRows = await store.db
    .selectFrom('transport_health')
    .select(['gateway', 'space', 'reason', 'since'])
    .orderBy('since')
    .orderBy('space')
    .execute();
  // Board-wide: every caller sees it; the health item itself stays operator-only.
  const transport = [...new Set([...gateways, ...healthRows.map((row) => row.gateway)])]
    .sort()
    .map((gateway) => {
      const down = healthRows.filter((row) => row.gateway === gateway);
      const first = down[0];
      return {
        gateway,
        state: first === undefined ? ('up' as const) : ('down' as const),
        since: first?.since ?? null,
        reason: first?.reason ?? null,
        spaces: down.map((row) => row.space).sort(),
      };
    });
  return {
    items,
    warmingUp: sources.some((source) => required.has(source.source) && source.warmingUp),
    spurUnavailable:
      spur?.blind_reason === null || spur === undefined
        ? null
        : `Spur unavailable: ${spur.blind_message ?? spur.blind_reason}`,
    hostLoad: host?.value !== undefined && host.value !== 'null' ? 'Host under load' : null,
    host: deps.host ?? null,
    services: services({
      now: clock.now(),
      daemon,
      transport,
      outageEnds: await readOutageEnds(store.db),
      sources,
    }),
    transport,
    sources,
    tasks,
    columnGroups: columnGroupViews(),
    projectBlocks,
    unlinkedPrs,
    unlinkedSessions,
    hiddenUnlinkedPrs: prRows.length - unlinkedPrs.length,
    hiddenUnlinkedSessions: sessionRows.length - unlinkedSessions.length,
    bindings: configBindings(config, projectIds),
    daemon,
  };
}
