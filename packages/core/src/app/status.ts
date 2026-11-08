import {
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  type Config,
  type PrFacts,
  type SessionFacts,
  type TicketFacts,
} from '@spur-board/contracts';
import { sql } from 'kysely';
import { parseJson } from '../store/json.ts';
import type { Store } from '../store/store.ts';
import { linkView, projectForSource, trackerSource } from './board-utils.ts';
import { CommandError } from './commands.ts';

function sessionView(fact: SessionFacts) {
  return { ...fact, links: Object.entries(fact.links).map(([label, url]) => ({ label, url })) };
}

/** Counts of each value, rendered as `<n> <value>` in the given order. */
function counts(values: readonly string[], order: readonly string[]): string {
  return order
    .map((value) => [value, values.filter((entry) => entry === value).length] as const)
    .filter(([, n]) => n > 0)
    .map(([value, n]) => `${String(n)} ${value}`)
    .join(', ');
}

/** The one-line task state: ticket status, pull request states, session health counts. */
function taskState(
  ticket: TicketFacts | null,
  prs: readonly PrFacts[],
  sessions: readonly SessionFacts[],
): string {
  const parts = [ticket === null ? 'ticket not observed' : `ticket ${ticket.status}`];
  if (prs.length > 0) {
    const labels = prs.map((pr) => (pr.state === 'open' && pr.draft ? 'draft' : pr.state));
    parts.push(`PRs ${counts(labels, ['draft', 'open', 'merged', 'closed'])}`);
  }
  if (sessions.length > 0) {
    const health: string[] = sessions.map((session) => session.health);
    parts.push(`sessions ${counts(health, [...new Set(health)].sort())}`);
  }
  return parts.join('; ');
}

/** The tracker repo of a GitHub Issues project, lowercased; null for Jira or no project. */
function issuesRepo(project: Config['projects'][number] | undefined): string | null {
  return project?.tracker.type === 'github-issues' ? project.tracker.repo.toLowerCase() : null;
}

/** Unlinked PRs and sessions finished longer ago than this are counted, not listed. */
const UNLINKED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function interval(config: Config, source: string): number {
  if (source === 'spur') return config.adapters.spur.intervalMs;
  if (source.startsWith('jira:')) return config.adapters.jira.intervalMs;
  return config.adapters.github.intervalMs;
}

/** Reads the board's latest facts, items and source availability. */
export async function getStatus(
  deps: {
    store: Pick<Store, 'db'>;
    config: Config;
    clock: { now(): number };
    completeSince: ReadonlyMap<string, string>;
    /** Configured chat gateway kinds; each is reported even with no health rows. */
    gateways?: readonly string[] | undefined;
  },
  options: {
    project?: string | undefined;
    visibleProjects?: ReadonlySet<string> | undefined;
    includeBoardItems?: boolean | undefined;
    /** Adds full ticket, pull request and session facts and links to every row. */
    detail?: boolean | undefined;
  } = {},
) {
  const { store, config, clock, completeSince, gateways = [] } = deps;
  const { project: projectId, visibleProjects, detail = false } = options;
  const includeBoardItems = options.includeBoardItems ?? visibleProjects === undefined;
  const projects =
    projectId === undefined
      ? config.projects.filter(
          (project) => visibleProjects === undefined || visibleProjects.has(project.id),
        )
      : config.projects.filter(
          (project) =>
            project.id === projectId &&
            (visibleProjects === undefined || visibleProjects.has(project.id)),
        );
  if (projects.length === 0) throw new CommandError('not_found', 'Check the project ID.');
  const projectIds = new Set(projects.map((project) => project.id));
  const rows = await store.db
    .selectFrom('task')
    .selectAll()
    .where('membership', '!=', 'archived')
    .execute();
  const blockRows = await store.db
    .selectFrom('block')
    .select(['task_id', (eb) => eb.fn.countAll<number>().as('open')])
    .where('state', '=', 'open')
    .groupBy('task_id')
    .execute();
  const openBlocks = new Map(blockRows.map((row) => [row.task_id, row.open]));
  const tasks = [];
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
    const prs: PrFacts[] = [];
    const sessions: SessionFacts[] = [];
    for (const link of links) {
      if (link.entity === 'pr' && link.repo !== null && link.number !== null) {
        const snapshot = await store.db
          .selectFrom('pr_snapshot')
          .select('detail')
          .where(sql<boolean>`lower(repo) = ${link.repo.toLowerCase()}`)
          .where('number', '=', link.number)
          .executeTakeFirst();
        if (snapshot !== undefined) prs.push(parseJson(prFactsSchema, snapshot.detail));
      } else if (link.entity === 'session' && link.session_id !== null) {
        const snapshot = await store.db
          .selectFrom('session_snapshot')
          .select('detail')
          .where('id', '=', link.session_id)
          .executeTakeFirst();
        if (snapshot !== undefined) sessions.push(parseJson(sessionFactsSchema, snapshot.detail));
      }
    }
    const ticketFacts = ticket === undefined ? null : parseJson(ticketFactsSchema, ticket.detail);
    const trackerRepo = issuesRepo(config.projects.find((entry) => entry.id === task.project));
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
    tasks.push({
      key: task.key,
      project: task.project,
      column: task.column,
      membership: task.membership,
      state: taskState(ticketFacts, prs, sessions),
      prCount: links.filter((link) => link.entity === 'pr').length,
      sessionCount: links.filter((link) => link.entity === 'session').length,
      openBlocks: openBlocks.get(task.id) ?? 0,
      ...(linkHints.length > 0 ? { linkHints } : {}),
      ...(detail
        ? {
            ticket: ticketFacts,
            prs,
            sessions: sessions.map(sessionView),
            links: links.map(linkView),
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
  const sourceRows = await store.db.selectFrom('source_state').selectAll().execute();
  const required = new Set([
    'spur',
    ...projects.flatMap((project) => [
      trackerSource(project),
      ...project.repos.map((repo) => `github:${project.id}:${repo.toLowerCase()}`),
    ]),
  ]);
  const sourceById = new Map(sourceRows.map((row) => [row.source, row]));
  const sources = [...required].map((source) => {
    const row = sourceById.get(source);
    const last = row?.last_complete_at ?? null;
    const blindReason: 'auth' | 'config' | 'stale' | null =
      row?.blind_reason === 'auth' ||
      row?.blind_reason === 'config' ||
      row?.blind_reason === 'stale'
        ? row.blind_reason
        : null;
    return {
      source,
      observedAt: row?.observed_at ?? null,
      lastCompleteAt: last,
      blindReason,
      message: row?.blind_message ?? null,
      stale:
        last === null ||
        clock.now() - Date.parse(last) >
          config.thresholds.staleMultiplier * interval(config, source),
      warmingUp: !completeSince.has(source),
    };
  });
  const itemRows = await store.db
    .selectFrom('operator_item')
    .selectAll()
    .where('cleared_at', 'is', null)
    .execute();
  const itemTasks = new Map(rows.map((task) => [task.id, task]));
  const items = itemRows
    .filter((item) =>
      item.task_id !== null
        ? projectIds.has(itemTasks.get(item.task_id)?.project ?? '')
        : item.source !== null
          ? required.has(item.source)
          : includeBoardItems,
    )
    .map((item) => {
      const source = item.source === null ? null : sourceById.get(item.source);
      const stale =
        item.fact_at !== null &&
        item.source !== null &&
        clock.now() - Date.parse(item.fact_at) >
          config.thresholds.staleMultiplier * interval(config, item.source);
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
    warmingUp: sources.some((source) => source.warmingUp),
    spurUnavailable:
      spur?.blind_reason === null || spur === undefined
        ? null
        : `Spur unavailable: ${spur.blind_message ?? spur.blind_reason}`,
    hostLoad: host?.value !== undefined && host.value !== 'null' ? 'Host under load' : null,
    transport,
    sources,
    tasks,
    unlinkedPrs,
    unlinkedSessions,
    hiddenUnlinkedPrs: prRows.length - unlinkedPrs.length,
    hiddenUnlinkedSessions: sessionRows.length - unlinkedSessions.length,
  };
}
