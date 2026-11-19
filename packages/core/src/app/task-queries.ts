import {
  parseActorId,
  parseRef,
  PR_STATES,
  TASK_HOLDS,
  type ActorId,
  type Config,
} from '@spur-board/contracts';
import { sql, type Selectable } from 'kysely';
import { dispatchHolds } from '../domain/dispatch.ts';
import { evaluateGate, explainGates, HOLD_ONLY, type HoldOnlyReason } from '../domain/gates.ts';
import type { CommentTable, TaskTable } from '../store/schema.ts';
import { authorize, projectTarget } from './authorize.ts';
import { blockView, commentView, subjectTarget, taskBlockViews, taskTarget } from './blocks.ts';
import { linkView, moveViews, taskView, type Trx } from './board-utils.ts';
import { CommandError } from './commands.ts';
import { courseKeyPrefix, cycleKeyPrefix } from './course-check.ts';
import { blindSources, readInput } from './dispatch.ts';
import { notificationAddressedTo } from './doorbells.ts';
import { historyEvents } from './history.ts';
import { canonicalKey } from './membership.ts';
import { latestSubmissions } from './submissions.ts';
import type { Query } from './queries.ts';
import { blockSubject, rowSubject, taskSubject } from './subject.ts';
import { taskTurns } from './task-turns.ts';
import { taskSessions } from './task-sessions.ts';
import { turnView } from './turn-view.ts';
import { turnNotification } from './turns.ts';

type Task = Selectable<TaskTable>;

/** How many of the last moves `task.get --why` shows. */
const WHY_MOVES = 5;

/** The fact each hold-only gate reason waits for, as `--why` names it. */
const WAITING_FOR: Record<HoldOnlyReason, string> = {
  checks_pending: 'waiting for CI',
  mergeable_unknown: 'waiting for GitHub to compute mergeability',
  comment_history_incomplete: 'waiting for the board to read the full PR comment history',
  merge_state_unknown: 'GitHub has not computed the merge state yet',
};

/** The review rule waits of `approvalRule: github-rules` that are not hold-only, as `--why` names them. */
const RULE_WAITS = {
  review_rule_blocked: 'merge blocked by the GitHub review rule',
  changes_requested: 'changes requested',
} as const;

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

type Comment = Selectable<CommentTable>;
type BlockOpening = Pick<ReturnType<typeof blockView>, 'id' | 'author' | 'reason' | 'at'>;

/**
 * Drops each block's opening comment: its earliest comment when author, text and time equal the
 * block's author, reason and creation time. `block.ask` writes it as the Slack thread root, so the
 * reply list would repeat the question. Order is kept.
 */
function withoutBlockOpenings(comments: readonly Comment[], blocks: readonly BlockOpening[]) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const seen = new Set<number>();
  return comments.filter((comment) => {
    if (comment.block_id === null || seen.has(comment.block_id)) return true;
    seen.add(comment.block_id);
    const block = byId.get(`B${String(comment.block_id)}`);
    return !(
      block !== undefined &&
      comment.author === block.author &&
      comment.text === block.reason &&
      comment.created_at === block.at
    );
  });
}

async function taskByKey(trx: Trx, key: string) {
  const task = await trx.selectFrom('task').selectAll().where('key', '=', key).executeTakeFirst();
  if (task === undefined) throw new CommandError('not_found', 'Check the task key.');
  return task;
}

import { refreshPrs } from './pr-refresh.ts';
import type { PrPoller } from '@spur-board/contracts';

export function createTaskQueries(deps: {
  prPoller?: (() => PrPoller['pollPr'] | undefined) | undefined;
  config: Config;
  clock: { now(): number };
  completeSince: ReadonlyMap<string, string>;
}) {
  const { config, clock, completeSince } = deps;
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
    const project = config.projects.find((entry) => entry.id === task.project);
    const shared = {
      column,
      turn: open === undefined ? null : await turnView(trx, open, task, project),
      moves: await moveViews(trx, task.id, { limit: WHY_MOVES }),
    };
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
      { at: new Date(clock.now()), complete: completeSince },
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
    const { checksGate } = project;
    // Under a checksGate right of Dev, running checks name the gate and red checks are listed too.
    // The review rule waits name no head: GitHub's answer is about the PR as a whole.
    const waitText = (reason: HoldOnlyReason, sha: string) =>
      reason === 'checks_pending' && checksGate !== 'dev'
        ? `checks running, exit from ${checksGate} waits for green`
        : reason === 'merge_state_unknown'
          ? WAITING_FOR[reason]
          : `${WAITING_FOR[reason]} on ${sha}`;
    const waiting =
      gate.ok || head === undefined
        ? []
        : gate.reasons.flatMap((reason) =>
            HOLD_ONLY.has(reason)
              ? [{ reason, head, text: waitText(reason as HoldOnlyReason, head) }]
              : reason === 'checks_red' && checksGate !== 'dev'
                ? [{ reason, head, text: 'checks red' }]
                : Object.hasOwn(RULE_WAITS, reason)
                  ? [{ reason, head, text: RULE_WAITS[reason as keyof typeof RULE_WAITS] }]
                  : [],
          );
    const holds = [
      ...dispatchHolds(read.input),
      ...(read.ticketUnconfirmed ? ['ticket_unconfirmed' as const] : []),
    ].sort((left, right) => TASK_HOLDS.indexOf(left) - TASK_HOLDS.indexOf(right));
    const heldBy = holds.includes('cycle_limit') ? await holdBlocks(trx, task.id) : [];
    const pending = read.pending?.state === 'pending' ? read.pending : undefined;
    return {
      ...shared,
      dispatcher: mode,
      holds,
      ...(heldBy.length === 0 ? {} : { heldBy }),
      ...(pending === undefined
        ? {}
        : {
            pendingSubmit: {
              sha: pending.sha,
              until: pending.until,
              text: `submit pending confirmation of ${pending.sha.slice(0, 7)}`,
            },
          }),
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
    async prepare(db, input) {
      if (input.refresh !== true) return;
      const task = await taskByKey(db, taskKey(input.task));
      const links = await db
        .selectFrom('link')
        .select(['repo', 'number'])
        .where('task_id', '=', task.id)
        .where('entity', '=', 'pr')
        .where('banned', '=', 0)
        .execute();
      await refreshPrs(
        config,
        task.project,
        links.flatMap((link) =>
          link.repo === null || link.number === null
            ? []
            : [{ kind: 'pr' as const, repo: link.repo, number: link.number }],
        ),
        deps.prPoller?.(),
      );
    },
    async run(trx, input) {
      const task = await taskByKey(trx, taskKey(input.task));
      const [blocks, comments, links] = await Promise.all([
        taskBlockViews(trx, task),
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
        sessions: await taskSessions(trx, task.id),
        submission: (await latestSubmissions(trx, [task])).get(task.id) ?? null,
        task: taskView(task),
        ...(await taskTurns(trx, task, input.detail === true)),
        links: links.map(({ state, ...link }) => {
          const observed = PR_STATES.find((value) => value === state);
          return { ...linkView(link), ...(observed === undefined ? {} : { state: observed }) };
        }),
        blocks,
        comments: withoutBlockOpenings(comments, blocks).map((comment) =>
          commentView(comment, subject),
        ),
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
      return { task: taskView(task), events: historyEvents(rows) };
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
      .select(['task.key', 'task.project'])
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
      const project = config.projects.find((entry) => entry.id === turn.project);
      turns.push(await turnView(trx, turn, { id: turn.task_id, key: turn.key }, project));
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
