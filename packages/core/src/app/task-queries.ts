import {
  EVENT_KINDS,
  eventPayloadSchemas,
  encodeActorId,
  parseActorId,
  parseRef,
  type ActorId,
  type Config,
  type EventKind,
} from '@spur-board/contracts';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { parseJson } from '../store/json.ts';
import type { Tables } from '../store/schema.ts';
import { authorize, type ResolvedTarget } from './authorize.ts';
import { authorizationTarget, blockView, commentView, taskTarget } from './blocks.ts';
import { linkView, taskView } from './board-utils.ts';
import { CommandError } from './commands.ts';
import { notificationAddressedTo } from './doorbells.ts';
import { canonicalKey } from './membership.ts';
import type { Query } from './queries.ts';

type Trx = Kysely<Tables>;
const actorRefSchema = z.strictObject({ project: z.string().min(1), session: z.string().min(1) });

const EVENT_SUMMARIES = {
  head_moved: 'Pull request head moved',
  pr_facts_changed: 'Pull request facts changed',
  checks_changed: 'Checks changed',
  review_submitted: 'Review submitted',
  mergeable_changed: 'Mergeability changed',
  pr_state_changed: 'Pull request state changed',
  ticket_status_changed: 'Ticket status changed',
  ticket_facts_changed: 'Ticket facts changed',
  session_state_changed: 'Session state changed',
  session_facts_changed: 'Session facts changed',
  spur_unknown_state: 'Unknown session state observed',
  link_added: 'Link added',
  link_removed: 'Link removed',
  task_added: 'Task added',
  task_archived: 'Task archived',
  block_opened: 'Block opened',
  block_escalated: 'Block escalated',
  block_unblocked: 'Block unblocked',
  comment_added: 'Comment added',
  comment_edited: 'Comment edited',
  comment_deleted: 'Comment deleted',
  comment_acked: 'Comment acknowledged',
  doorbell_rung: 'Doorbell rung',
  doorbell_read: 'Doorbell read',
  doorbell_undelivered: 'Doorbell delivery exhausted',
  inbound_failed: 'Inbound message failed',
  inbound_skipped: 'Inbound message skipped',
  from_you_raised: 'Operator item raised',
  from_you_cleared: 'Operator item cleared',
  flag_raised: 'Flag raised',
  flag_cleared: 'Flag cleared',
  operation_denied: 'Operation denied',
  token_requested: 'Token requested',
  token_approved: 'Token approved',
  token_denied: 'Token denied',
  token_expired: 'Token expired',
  token_revoked: 'Token revoked',
} satisfies Record<EventKind, string>;

function linkSummary(kind: EventKind, payloadText: string): string | null {
  if (kind !== 'link_added' && kind !== 'link_removed') return null;
  try {
    const payload = eventPayloadSchemas[kind].safeParse(JSON.parse(payloadText));
    if (!payload.success) return null;
    const target =
      payload.data.entity === 'pr'
        ? `${payload.data.repo}#${String(payload.data.pr)}`
        : payload.data.entity === 'session'
          ? payload.data.session
          : payload.data.ticket;
    const verb = kind === 'link_added' ? 'Link added' : 'Link removed';
    return `${verb}: ${payload.data.entity} ${target}${payload.data.reason === undefined ? '' : ` — ${payload.data.reason}`}`;
  } catch {
    return null;
  }
}

function projectTarget(project: string): ResolvedTarget {
  return { kind: 'found', value: { project, task: null, block: null, workers: [] } };
}

export function visibleProjects(config: Config, actor: ActorId): ReadonlySet<string> {
  return new Set(
    config.projects
      .filter(
        (project) =>
          authorize([{ grant: 'operator' }, { grant: 'project-agent' }], actor, {
            config,
            target: projectTarget(project.id),
          }).status === 'allowed',
      )
      .map((project) => project.id),
  );
}

export function projectTargets(config: Config, project: string | undefined, actor: ActorId) {
  if (project !== undefined) {
    return config.projects.some((entry) => entry.id === project)
      ? [projectTarget(project)]
      : [{ kind: 'missing' as const }];
  }
  const visible = visibleProjects(config, actor);
  const projects = config.projects.filter((entry) => visible.has(entry.id));
  return projects.length === 0
    ? [{ kind: 'missing' as const }]
    : projects.map((entry) => projectTarget(entry.id));
}

async function taskByKey(trx: Trx, key: string) {
  const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
  if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
  return task;
}

export function createTaskQueries(config: Config) {
  const taskKey = (key: string) => {
    const parsed = parseRef(key, 'task');
    return parsed.ok && parsed.value.kind === 'task' && parsed.value.form === 'github-short'
      ? canonicalKey(config, key).key
      : key;
  };
  const get: Query<'task.get'> = {
    id: 'task.get',
    resolveTargets: (trx, input) => taskTarget(trx, taskKey(input.task)),
    async run(trx, input) {
      const task = await taskByKey(trx, taskKey(input.task));
      const [blocks, comments, links] = await Promise.all([
        trx.selectFrom('block').selectAll().where('task_id', '=', task.id).orderBy('id').execute(),
        trx
          .selectFrom('comment')
          .selectAll()
          .where('task_id', '=', task.id)
          .orderBy('id')
          .execute(),
        trx
          .selectFrom('link')
          .selectAll()
          .where('task_id', '=', task.id)
          .where('banned', '=', 0)
          .orderBy('id')
          .execute(),
      ]);
      return {
        task: taskView(task),
        links: links.map(linkView),
        blocks: blocks.map((block) => blockView(block, task)),
        comments: comments.map((comment) => commentView(comment, task)),
      };
    },
  };
  const history: Query<'task.history'> = {
    id: 'task.history',
    resolveTargets: (trx, input) => taskTarget(trx, taskKey(input.task)),
    async run(trx, input) {
      const task = await taskByKey(trx, taskKey(input.task));
      const rows = await trx
        .selectFrom('event')
        .selectAll()
        .where('task_id', '=', task.id)
        .orderBy('id')
        .execute();
      const events = rows.flatMap((row) => {
        const kind = EVENT_KINDS.find((candidate) => candidate === row.kind);
        if (kind === undefined) return [];
        const actorRef =
          row.actor_ref === null ? undefined : parseJson(actorRefSchema, row.actor_ref);
        return [
          {
            at: row.at,
            kind,
            actor: encodeActorId({ actor: row.actor, actorRef }),
            summary: linkSummary(kind, row.payload) ?? EVENT_SUMMARIES[kind],
          },
        ];
      });
      return { task: taskView(task), events };
    },
  };
  const inbox: Query<'inbox.get'> = {
    id: 'inbox.get',
    resolveTargets(_trx, input, actor) {
      return Promise.resolve(projectTargets(config, input.project, actor));
    },
    async run(trx, input, actor) {
      const projects =
        input.project === undefined ? visibleProjects(config, actor) : new Set([input.project]);
      const notices = await trx
        .selectFrom('notification')
        .selectAll()
        .where('kind', '=', 'answer')
        .where('acked_at', 'is', null)
        .orderBy('id', 'desc')
        .execute();
      const comments = [];
      const seen = new Set<number>();
      for (const notice of notices) {
        if (notice.comment_id === null || seen.has(notice.comment_id)) continue;
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', notice.task_id)
          .executeTakeFirst();
        if (task === undefined || !projects.has(task.project)) continue;
        seen.add(notice.comment_id);
        if (!(await notificationAddressedTo(trx, notice, actor, config))) continue;
        const comment = await trx
          .selectFrom('comment')
          .selectAll()
          .where('id', '=', notice.comment_id)
          .executeTakeFirst();
        if (comment === undefined || comment.acked_revision === comment.revision) continue;
        comments.push(commentView(comment, task));
      }
      const parsedActor = parseActorId(actor);
      if (parsedActor?.actor === 'agent') {
        const linkedTasks = await trx
          .selectFrom('task')
          .innerJoin('link', 'link.task_id', 'task.id')
          .selectAll('task')
          .where('task.project', 'in', [...projects])
          .where('link.entity', '=', 'session')
          .where('link.role', '=', 'worker')
          .where('link.banned', '=', 0)
          .where('link.session_id', '=', parsedActor.actorRef.session)
          .execute();
        const tasksById = new Map(linkedTasks.map((task) => [task.id, task]));
        if (tasksById.size > 0) {
          const taskComments = await trx
            .selectFrom('comment')
            .selectAll()
            .where('task_id', 'in', [...tasksById.keys()])
            .where('block_id', 'is', null)
            .orderBy('id')
            .execute();
          for (const comment of taskComments) {
            const task = tasksById.get(comment.task_id);
            if (
              task === undefined ||
              comment.author === actor ||
              comment.acked_revision === comment.revision
            )
              continue;
            comments.push(commentView(comment, task));
          }
        }
      }
      comments.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
      const rows = await trx
        .selectFrom('block')
        .selectAll()
        .where('state', '=', 'open')
        .orderBy('id')
        .execute();
      const blocks = [];
      for (const block of rows) {
        const task = await trx
          .selectFrom('task')
          .selectAll()
          .where('id', '=', block.task_id)
          .executeTakeFirst();
        if (task === undefined || !projects.has(task.project)) continue;
        const target = await authorizationTarget(trx, task, block);
        if (
          authorize([{ grant: 'block-addressee' }], actor, { config, target }).status !== 'allowed'
        )
          continue;
        blocks.push(blockView(block, task));
      }
      return { comments, blocks, turns: [] };
    },
  };
  return { get, history, inbox };
}
