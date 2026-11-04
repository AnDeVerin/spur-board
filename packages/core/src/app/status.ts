import {
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  type Config,
  type SessionFacts,
} from '@spur-board/contracts';
import { parseJson } from '../store/json.ts';
import type { Store } from '../store/store.ts';
import { trackerSource } from './board-utils.ts';
import { CommandError } from './commands.ts';

function sessionView(fact: SessionFacts) {
  return { ...fact, links: Object.entries(fact.links).map(([label, url]) => ({ label, url })) };
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
  },
  projectId?: string,
  visibleProjects?: ReadonlySet<string>,
  includeBoardItems = visibleProjects === undefined,
) {
  const { store, config, clock, completeSince } = deps;
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
    const prs = [];
    const sessions = [];
    for (const link of links) {
      if (link.entity === 'pr' && link.repo !== null && link.number !== null) {
        const snapshot = await store.db
          .selectFrom('pr_snapshot')
          .select('detail')
          .where('repo', '=', link.repo)
          .where('number', '=', link.number)
          .executeTakeFirst();
        if (snapshot !== undefined) prs.push(parseJson(prFactsSchema, snapshot.detail));
      } else if (link.session_id !== null) {
        const snapshot = await store.db
          .selectFrom('session_snapshot')
          .select('detail')
          .where('id', '=', link.session_id)
          .executeTakeFirst();
        if (snapshot !== undefined)
          sessions.push(sessionView(parseJson(sessionFactsSchema, snapshot.detail)));
      }
    }
    tasks.push({
      key: task.key,
      project: task.project,
      column: task.column,
      membership: task.membership,
      ticket: ticket === undefined ? null : parseJson(ticketFactsSchema, ticket.detail),
      prs,
      sessions,
      links: links.map((link) => ({
        kind: link.entity,
        ref:
          link.entity === 'pr'
            ? `${link.repo ?? ''}#${String(link.number ?? '')}`
            : (link.session_id ?? ''),
        role: link.role,
      })),
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
          (link) => link.entity === 'pr' && link.repo === pr.repo && link.number === pr.number,
        ),
    )
    .map((pr) => parseJson(prFactsSchema, pr.detail));
  const unlinkedSessions = allSessions
    .filter(
      (session) =>
        projects.some((project) =>
          project.spurProjects.some((spur) => spur.name === session.spur_project),
        ) && !allLinks.some((link) => link.entity === 'session' && link.session_id === session.id),
    )
    .map((session) => sessionView(parseJson(sessionFactsSchema, session.detail)));
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
  return {
    tasks,
    items,
    unlinkedPrs,
    unlinkedSessions,
    sources,
    warmingUp: sources.some((source) => source.warmingUp),
    spurUnavailable:
      spur?.blind_reason === null || spur === undefined
        ? null
        : `Spur unavailable: ${spur.blind_message ?? spur.blind_reason}`,
    hostLoad: host?.value !== undefined && host.value !== 'null' ? 'Host under load' : null,
  };
}
