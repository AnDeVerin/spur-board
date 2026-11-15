import {
  EVENT_KINDS,
  eventPayloadSchemas,
  parseActorId,
  parseRef,
  PR_STATES,
  TASK_HOLDS,
  type ActorId,
  type Config,
  type EventKind,
} from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import { dispatchHolds } from '../domain/dispatch.ts';
import { evaluateGate, explainGates, HOLD_ONLY, type HoldOnlyReason } from '../domain/gates.ts';
import type { TaskTable, TurnTable } from '../store/schema.ts';
import { authorize, projectTarget } from './authorize.ts';
import { blockView, commentView, subjectTarget, taskTarget } from './blocks.ts';
import { eventActor, linkView, moveViews, taskView, type Trx } from './board-utils.ts';
import { CommandError } from './commands.ts';
import { courseKeyPrefix, cycleKeyPrefix } from './course-check.ts';
import { blindSources, readInput } from './dispatch.ts';
import { notificationAddressedTo } from './doorbells.ts';
import { canonicalKey } from './membership.ts';
import type { Query } from './queries.ts';
import { blockSubject, rowSubject, taskSubject } from './subject.ts';
import { taskTurns } from './task-turns.ts';
import { turnHanded, turnNotification } from './turns.ts';

type Task = Selectable<TaskTable>;
type Turn = Selectable<TurnTable>;

/** How many of the last moves `task.get --why` shows. */
const WHY_MOVES = 5;

/** The fact each hold-only gate reason waits for, as `--why` names it. */
const WAITING_FOR: Record<HoldOnlyReason, string> = {
  checks_pending: 'waiting for CI',
  mergeable_unknown: 'waiting for GitHub to compute mergeability',
  comment_history_incomplete: 'waiting for the board to read the full PR comment history',
};

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
  task_submitted: 'Turn submitted',
  task_moved: 'Task moved',
  task_shadow_moved: 'Shadow move',
  task_corrected: 'Column corrected by the operator',
  dispatcher_mode_changed: 'Dispatcher mode changed',
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

/** The summary of a shadow move that reached its column's course check. */
function shadowSummary(kind: EventKind, payloadText: string): string | null {
  if (kind !== 'task_shadow_moved') return null;
  try {
    const payload = eventPayloadSchemas[kind].safeParse(JSON.parse(payloadText));
    return payload.success && payload.data.courseCheck === true
      ? 'Shadow move with a course check'
      : null;
  } catch {
    return null;
  }
}

/** The summary of a submit whose head the board's newest poll confirmed. */
function submitSummary(kind: EventKind, payloadText: string): string | null {
  if (kind !== 'task_submitted') return null;
  try {
    const payload = eventPayloadSchemas[kind].safeParse(JSON.parse(payloadText));
    return payload.success && payload.data.confirmedByPoll === true
      ? 'Turn submitted on the head of the last poll'
      : null;
  } catch {
    return null;
  }
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

function turnView(turn: Turn, key: string) {
  return {
    id: `T${String(turn.id)}`,
    task: key,
    column: turn.column,
    addressee: turn.role,
    reason: turn.reason,
    handed: turnHanded(turn),
    head: turn.head_sha,
    at: turn.created_at,
    taken:
      turn.acked_by === null || turn.acked_at === null
        ? null
        : { by: turn.acked_by, at: turn.acked_at },
  };
}

export function createTaskQueries(deps: {
  config: Config;
  completeSince: ReadonlyMap<string, string>;
}) {
  const { config, completeSince } = deps;
  const taskKey = (key: string) => {
    const parsed = parseRef(key, 'task');
    return parsed.ok && parsed.value.kind === 'task' && parsed.value.form === 'github-short'
      ? canonicalKey(config, key).key
      : key;
  };
  /**
   * Why the task is where it is, read as the next dispatcher pass will see it: from the column it
   * works from (the shadow column, which only shadow mode sets) and with the configured mode. It
   * only reads; a pending mode switch is left to the dispatcher.
   */
  async function why(trx: Trx, task: Task) {
    const column = task.shadow_column ?? task.column;
    const open = await trx
      .selectFrom('turn')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('closed_at', 'is', null)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const shared = {
      column,
      turn: open === undefined ? null : turnView(open, task.key),
      moves: await moveViews(trx, task.id, { limit: WHY_MOVES }),
    };
    const project = config.projects.find((entry) => entry.id === task.project);
    if (project === undefined)
      return { ...shared, dispatcher: null, holds: [], gates: [], checksWaivedBy: null };
    const mode = project.dispatcher.mode;
    const read = await readInput(
      trx,
      { ...task, column },
      project,
      mode,
      await blindSources(trx, completeSince),
      config,
    );
    if (read === null) {
      return {
        ...shared,
        dispatcher: mode,
        holds: ['pr_snapshot_missing' as const],
        gates: [],
        checksWaivedBy: null,
      };
    }
    const { facts } = read.input;
    const { gates, checksWaivedBy } = explainGates(facts, read.input.project);
    const gate = evaluateGate(column, facts, read.input.project);
    const head = facts.pr?.headSha.toLowerCase();
    const waiting =
      gate.ok || head === undefined
        ? []
        : gate.reasons
            .filter((reason): reason is HoldOnlyReason => HOLD_ONLY.has(reason))
            .map((reason) => ({
              reason,
              head,
              text: `${WAITING_FOR[reason]} on ${head}`,
            }));
    const holds = [
      ...dispatchHolds(read.input),
      ...(read.ticketUnconfirmed ? ['ticket_unconfirmed' as const] : []),
    ].sort((left, right) => TASK_HOLDS.indexOf(left) - TASK_HOLDS.indexOf(right));
    const heldBy = holds.includes('cycle_limit') ? await holdBlocks(trx, task.id) : [];
    return {
      ...shared,
      dispatcher: mode,
      holds,
      ...(heldBy.length === 0 ? {} : { heldBy }),
      gates,
      checksWaivedBy,
      ...(waiting.length === 0 ? {} : { waiting }),
    };
  }
  /** The blocks of the active cycle-limit and course-check items that hold the task's turn. */
  async function holdBlocks(trx: Trx, taskId: number): Promise<string[]> {
    const items = await trx
      .selectFrom('operator_item')
      .select('block_id')
      .where((eb) =>
        eb.or([
          eb('item_key', 'like', `${cycleKeyPrefix(taskId)}%`),
          eb('item_key', 'like', `${courseKeyPrefix(taskId)}%`),
        ]),
      )
      .where('cleared_at', 'is', null)
      .where('block_id', 'is not', null)
      .orderBy('id')
      .execute();
    return items.flatMap((item) => (item.block_id === null ? [] : [`B${String(item.block_id)}`]));
  }
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
          .leftJoin('pr_snapshot', (join) =>
            join
              .on(sql<boolean>`lower(pr_snapshot.repo) = lower(link.repo)`)
              .onRef('pr_snapshot.number', '=', 'link.number'),
          )
          .selectAll('link')
          .select('pr_snapshot.state')
          .where('link.task_id', '=', task.id)
          .where('link.banned', '=', 0)
          .orderBy('link.id')
          .execute(),
      ]);
      const subject = taskSubject(task);
      return {
        task: taskView(task),
        ...(await taskTurns(trx, task, input.detail === true)),
        links: links.map(({ state, ...link }) => {
          const observed = PR_STATES.find((value) => value === state);
          return { ...linkView(link), ...(observed === undefined ? {} : { state: observed }) };
        }),
        blocks: blocks.map((block) => blockView(block, subject)),
        comments: comments.map((comment) => commentView(comment, subject)),
        ...(input.why === true ? { why: await why(trx, task) } : {}),
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
        return [
          {
            at: row.at,
            kind,
            actor: eventActor(row),
            summary:
              linkSummary(kind, row.payload) ??
              shadowSummary(kind, row.payload) ??
              submitSummary(kind, row.payload) ??
              EVENT_SUMMARIES[kind],
          },
        ];
      });
      return { task: taskView(task), events };
    },
  };
  /**
   * Unclosed agent turns the caller may take or has taken: an untaken one addressed to it, one it
   * took, and a taken orchestrator turn it may take over. At most one per task.
   */
  async function inboxTurns(trx: Trx, projects: ReadonlySet<string>, actor: ActorId) {
    if (parseActorId(actor)?.actor !== 'agent' || projects.size === 0) return [];
    const rows = await trx
      .selectFrom('turn')
      .innerJoin('task', 'task.id', 'turn.task_id')
      .selectAll('turn')
      .select('task.key')
      .where('task.project', 'in', [...projects])
      .where('turn.closed_at', 'is', null)
      .where('turn.role', '!=', 'operator')
      .orderBy('turn.id')
      .execute();
    const turns = [];
    for (const turn of rows) {
      if (turn.acked_by !== actor) {
        const notice = await turnNotification(trx, turn.id);
        const mayTake =
          turn.acked_at === null
            ? notice?.acked_at === null
            : turn.role.startsWith('orchestrator:');
        if (
          notice === undefined ||
          !mayTake ||
          !(await notificationAddressedTo(trx, notice, actor, config))
        )
          continue;
      }
      turns.push(turnView(turn, turn.key));
    }
    return turns;
  }

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
      const listed = new Set<number>();
      for (const notice of notices) {
        if (notice.comment_id === null || seen.has(notice.comment_id)) continue;
        const subject = await rowSubject(trx, notice);
        if (!projects.has(subject.project)) continue;
        seen.add(notice.comment_id);
        if (!(await notificationAddressedTo(trx, notice, actor, config))) continue;
        const comment = await trx
          .selectFrom('comment')
          .selectAll()
          .where('id', '=', notice.comment_id)
          .executeTakeFirst();
        if (comment === undefined || comment.acked_revision === comment.revision) continue;
        listed.add(comment.id);
        comments.push(commentView(comment, subject));
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
            const task = comment.task_id === null ? undefined : tasksById.get(comment.task_id);
            // A course note is also an answer notice: list it once, and to a linked worker its
            // notice does not address (a worker linked after the note rang another).
            if (
              task === undefined ||
              listed.has(comment.id) ||
              comment.author === actor ||
              comment.acked_revision === comment.revision
            )
              continue;
            comments.push(commentView(comment, taskSubject(task)));
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
        const subject = await blockSubject(trx, block);
        if (!projects.has(subject.project)) continue;
        const target = await subjectTarget(trx, subject, block);
        if (
          authorize([{ grant: 'block-addressee' }], actor, { config, target }).status !== 'allowed'
        )
          continue;
        blocks.push(blockView(block, subject));
      }
      return { comments, blocks, turns: await inboxTurns(trx, projects, actor) };
    },
  };
  return { get, history, inbox };
}
