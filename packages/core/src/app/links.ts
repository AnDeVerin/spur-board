import type { PrFacts, SessionFacts } from '@spur-board/contracts';
import { prFactsSchema, sessionFactsSchema } from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import { parseJson } from '../store/json.ts';
import type { LinkTable } from '../store/schema.ts';
import { emit, projectForKey, type Trx } from './board-utils.ts';
import { taskTarget } from './blocks.ts';
import { CommandError, type Mutation } from './commands.ts';
import { canonicalKey } from './membership.ts';
import type { Config } from '@spur-board/contracts';

type Link = Selectable<LinkTable>;
type LinkInput = Parameters<Mutation<'link.add'>['run']>[1];

function prIdentity(url: string): { repo: string; number: number } {
  const parsed = new URL(url);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
  if (parsed.hostname.toLowerCase() !== 'github.com' || match === null) {
    throw new CommandError('usage', 'Use a GitHub pull request URL.');
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number))
    throw new CommandError('usage', 'Invalid pull request number.');
  return { repo: `${match[1] ?? ''}/${match[2] ?? ''}`.toLowerCase(), number };
}

function ref(input: LinkInput): string {
  if (input.mode === 'pr') {
    const pr = prIdentity(input.pr);
    return `${pr.repo}#${String(pr.number)}`;
  }
  return input.mode === 'session' ? input.session : input.ticket;
}

function ticketIdentity(config: Config, key: string): string {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return key;
  const repo = key.slice(0, hash);
  if (!repo.includes('/')) return canonicalKey(config, key).key;
  const project = projectForKey(config, key);
  const canonicalRepo =
    project?.tracker.type === 'github-issues' ? project.tracker.repo : repo.toLowerCase();
  return `${canonicalRepo}${key.slice(hash)}`;
}

async function snapshot(trx: Trx, repo: string, number: number): Promise<PrFacts | null> {
  const row = await trx
    .selectFrom('pr_snapshot')
    .select('detail')
    .where(sql<boolean>`lower(repo) = ${repo.toLowerCase()}`)
    .where('number', '=', number)
    .executeTakeFirst();
  return row === undefined ? null : parseJson(prFactsSchema, row.detail);
}

async function sessionSnapshot(trx: Trx, id: string): Promise<SessionFacts | null> {
  const row = await trx
    .selectFrom('session_snapshot')
    .select('detail')
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? null : parseJson(sessionFactsSchema, row.detail);
}

async function existingLink(
  trx: Trx,
  taskId: number,
  input: LinkInput,
  ticket: string | null,
): Promise<Link | undefined> {
  let query = trx.selectFrom('link').selectAll().where('task_id', '=', taskId);
  if (input.mode === 'pr') {
    const pr = prIdentity(input.pr);
    query = query
      .where('entity', '=', 'pr')
      .where(sql<boolean>`lower(repo) = ${pr.repo}`)
      .where('number', '=', pr.number);
  } else if (input.mode === 'session') {
    query = query.where('entity', '=', 'session').where('session_id', '=', input.session);
  } else {
    query = query.where('entity', '=', 'ticket').where('ticket_key', '=', ticket ?? input.ticket);
  }
  return query.executeTakeFirst();
}

async function sessionRole(trx: Trx, taskId: number): Promise<'worker' | 'other'> {
  const worker = await trx
    .selectFrom('link')
    .select('id')
    .where('task_id', '=', taskId)
    .where('entity', '=', 'session')
    .where('role', '=', 'worker')
    .where('banned', '=', 0)
    .executeTakeFirst();
  return worker === undefined ? 'worker' : 'other';
}

async function prConflict(trx: Trx, taskId: number, repo: string, number: number, open: boolean) {
  const links = await trx
    .selectFrom('link')
    .leftJoin('pr_snapshot', (join) =>
      join
        .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
        .onRef('pr_snapshot.number', '=', 'link.number'),
    )
    .select(['link.repo', 'link.number', 'link.pr_state', 'link.pr_open', 'pr_snapshot.state'])
    .where('link.task_id', '=', taskId)
    .where('link.entity', '=', 'pr')
    .where('link.banned', '=', 0)
    .execute();
  for (const link of links) {
    if (link.repo?.toLowerCase() === repo && link.number === number) continue;
    const blocking = `${link.repo ?? ''}#${String(link.number ?? '')}`;
    if (link.state === 'merged')
      throw new CommandError(
        'link_conflict',
        `${blocking} is merged; manual PR replacement is not allowed.`,
      );
    if (open && link.pr_state === 'active' && link.pr_open === 1)
      throw new CommandError('link_conflict', `${blocking} is already the open PR for this task.`);
  }
}

async function run(
  trx: Trx,
  input: LinkInput,
  ctx: Parameters<Mutation<'link.add'>['run']>[2],
  config: Config,
  remove: boolean,
) {
  const key = canonicalKey(config, input.task).key;
  const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
  if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
  if (task.membership === 'archived') throw new CommandError('task_archived', 'Task is archived.');
  const ticket = input.mode === 'ticket' ? ticketIdentity(config, input.ticket) : null;
  const target = ticket ?? ref(input);
  const current = await existingLink(trx, task.id, input, ticket);
  const pr = input.mode === 'pr' ? prIdentity(input.pr) : null;
  const facts = pr === null ? null : await snapshot(trx, pr.repo, pr.number);
  const open = facts?.state !== 'closed' && facts?.state !== 'merged';
  if (!remove && pr !== null) await prConflict(trx, task.id, pr.repo, pr.number, open);

  if (remove) {
    if (current?.banned === 1) return { task: key, target };
    if (current === undefined) {
      await trx
        .insertInto('link')
        .values({
          task_id: task.id,
          entity: input.mode,
          repo: pr?.repo ?? null,
          number: pr?.number ?? null,
          pr_state: pr === null ? null : 'active',
          session_id: input.mode === 'session' ? input.session : null,
          role: null,
          source: 'manual',
          banned: 1,
          created_at: ctx.at,
          ticket_key: ticket,
          pr_open: pr === null ? null : open ? 1 : 0,
        })
        .execute();
    } else {
      await trx.updateTable('link').set({ banned: 1 }).where('id', '=', current.id).execute();
    }
    await emit(
      trx,
      'link_removed',
      task.project,
      task.id,
      ctx.at,
      input.mode === 'pr'
        ? { entity: 'pr', repo: pr?.repo ?? '', pr: pr?.number ?? 0, reason: input.reason }
        : input.mode === 'session'
          ? { entity: 'session', session: input.session, reason: input.reason }
          : { entity: 'ticket', ticket: ticket ?? input.ticket, reason: input.reason },
      ctx.actor,
    );
    return { task: key, target };
  }

  if (
    current?.banned === 0 &&
    current.source === 'manual' &&
    (input.mode !== 'pr' || current.pr_state === 'active')
  )
    return { task: key, target };
  const role =
    input.mode === 'session' ? (current?.role ?? (await sessionRole(trx, task.id))) : null;
  const session = input.mode === 'session' ? await sessionSnapshot(trx, input.session) : null;
  if (current === undefined) {
    await trx
      .insertInto('link')
      .values({
        task_id: task.id,
        entity: input.mode,
        repo: pr?.repo ?? null,
        number: pr?.number ?? null,
        pr_state: pr === null ? null : 'active',
        session_id: input.mode === 'session' ? input.session : null,
        role,
        source: 'manual',
        banned: 0,
        created_at: ctx.at,
        ticket_key: ticket,
        pr_open: pr === null ? null : open ? 1 : 0,
      })
      .execute();
  } else {
    await trx
      .updateTable('link')
      .set({
        source: 'manual',
        banned: 0,
        ...(pr === null
          ? {}
          : { pr_state: 'active' as const, pr_open: open ? (1 as const) : (0 as const) }),
      })
      .where('id', '=', current.id)
      .execute();
  }
  await emit(
    trx,
    'link_added',
    task.project,
    task.id,
    ctx.at,
    input.mode === 'pr'
      ? {
          entity: 'pr',
          repo: pr?.repo ?? '',
          pr: pr?.number ?? 0,
          state: 'active',
          source: 'manual',
          ...(facts === null ? {} : { facts }),
          reason: input.reason,
        }
      : input.mode === 'session'
        ? {
            entity: 'session',
            session: input.session,
            role: role ?? 'other',
            source: 'manual',
            ...(session === null ? {} : { facts: session }),
            reason: input.reason,
          }
        : {
            entity: 'ticket',
            ticket: ticket ?? input.ticket,
            source: 'manual',
            reason: input.reason,
          },
    ctx.actor,
  );
  return { task: key, target };
}

export function createLinkMutations(config: Config): {
  add: Mutation<'link.add'>;
  remove: Mutation<'link.remove'>;
} {
  const resolveTargets = (trx: Trx, input: LinkInput) =>
    taskTarget(trx, canonicalKey(config, input.task).key);
  return {
    add: {
      id: 'link.add',
      resolveTargets,
      run: (trx, input, ctx) => run(trx, input, ctx, config, false),
    },
    remove: {
      id: 'link.remove',
      resolveTargets,
      run: (trx, input, ctx) => run(trx, input, ctx, config, true),
    },
  };
}
