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
import { linkView, trackerSource } from './board-utils.ts';
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
    const links = await store.db
      .selectFrom('link')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('banned', '=', 0)
      .execute();
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
    tasks.push({
      key: task.key,
      project: task.project,
      column: task.column,
      membership: task.membership,
      state: taskState(ticketFacts, prs, sessions),
      prCount: links.filter((link) => link.entity === 'pr').length,
      sessionCount: links.filter((link) => link.entity === 'session').length,
      openBlocks: openBlocks.get(task.id) ?? 0,
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
  const allPrs = await store.db.selectFrom('pr_snapshot').selectAll().execute();
  const allSessions = await store.db.selectFrom('session_snapshot').selectAll().execute();
  const allLinks = await store.db.selectFrom('link').selectAll().where('banned', '=', 0).execute();
  const unlinkedPrs = allPrs
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
    .map((pr) => {
      const facts = parseJson(prFactsSchema, pr.detail);
      if (detail) return facts;
      const { repo, number, url, title, state, draft } = facts;
      return { repo, number, url, title, state, draft };
    });
  const unlinkedSessions = allSessions
    .filter(
      (session) =>
        projects.some((project) =>
          project.spurProjects.some((spur) => spur.name === session.spur_project),
        ) && !allLinks.some((link) => link.entity === 'session' && link.session_id === session.id),
    )
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
  };
}
