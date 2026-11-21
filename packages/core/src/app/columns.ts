import {
  COLUMNS,
  COLUMN_IDS,
  columnTurnTimings,
  encodeActorId,
  readyMirrorOf,
  type AddresseeRole,
  type ColumnId,
  type Config,
} from '@spur-board/contracts';
import { blockAddressee, escalateBlock, parseAddressee } from '../domain/blocks/blocks.ts';
import { nextColumn, operatorWhenUnbound } from '../domain/dispatch.ts';
import { describeConditions, threadsFrom } from '../domain/gates.ts';
import { curatorProject } from './authorize.ts';
import type { Trx } from './board-utils.ts';
import { courseAddressee, externalColumn } from './course-check.ts';
import { bestProjectSession, observedFacts } from './doorbells.ts';
import { describeCompletion } from './dispatch.ts';
import type { Query } from './queries.ts';
import { projectTargets, visibleProjects } from './task-queries.ts';
import { stuckTurnAfterMs } from './quiet-turns.ts';
import { turnExecutor } from './turns.ts';

type Project = Config['projects'][number];

/**
 * The executor text of a column whose turns go to the operator: why, and the levers that hand
 * them on. A required column cannot be disabled; the checks-gate column only after `checksGate`
 * moves, as config validation rejects a disabled one.
 */
function operatorText(unbound: boolean, required: boolean, checksGate: boolean): string {
  const why = unbound
    ? 'No executor is bound to this column, so its turns go to the operator.'
    : 'The board config binds this column to the operator, so its turns go to the operator.';
  const bind =
    'bind an orchestrator or curator to this column in the board config to hand its turns to an agent';
  const levers = required
    ? `Take a turn to close it yourself, or ${bind}.`
    : `Take a turn to close it yourself, ${bind}, or disable the column to skip it${checksGate ? ' after moving checksGate to another enabled column' : ''}.`;
  const questions = unbound
    ? " Questions keep the routing of an unbound column: the board's own go to the task's live worker, others to the curator, else the operator."
    : '';
  return `${why} ${levers}${questions}`;
}

/** Policy reads reuse runtime selectors, but never choose a task-linked worker or turn owner. */
export function createColumnsQuery(config: Config): Query<'columns.describe'> {
  return {
    id: 'columns.describe',
    resolveTargets(_trx, input, actor) {
      return Promise.resolve(projectTargets(config, input.project, actor));
    },
    async run(trx, input, actor) {
      const visible = visibleProjects(config, actor);
      const projects = [];
      for (const project of config.projects) {
        if (
          !visible.has(project.id) ||
          (input.project !== undefined && input.project !== project.id)
        )
          continue;
        projects.push(await describeProject(trx, config, project));
      }
      return { projects };
    },
  };
}

async function describeProject(trx: Trx, config: Config, project: Project) {
  const curator = curatorProject(config, project.id);
  const from = threadsFrom(project);
  const selected = new Map<string, Awaited<ReturnType<typeof bestProjectSession>>>();
  async function destination(
    role: AddresseeRole,
    purpose: 'executor' | 'question' | 'course-check',
  ) {
    const parsed = parseAddressee(role);
    const name =
      parsed.kind === 'curator'
        ? curator
        : parsed.kind === 'orchestrator'
          ? (project.columns.find((column) => column.id === parsed.column)?.orchestrator ?? null)
          : null;
    const named = project.spurProjects.find((spur) => spur.name === name);
    if (named !== undefined && !selected.has(named.name))
      selected.set(named.name, await bestProjectSession(trx, named.name));
    const session = named === undefined ? undefined : selected.get(named.name);
    const facts = session === undefined ? null : observedFacts(session);
    return {
      role,
      project: named?.name ?? null,
      displayName: named?.displayName ?? named?.name ?? null,
      session:
        session === undefined
          ? null
          : {
              id: session.id,
              links: Object.entries(facts?.links ?? {}).map(([label, url]) => ({ label, url })),
            },
      text:
        role === 'operator'
          ? 'The operator.'
          : role === 'worker'
            ? 'The task-linked live worker, else the operator; no arbitrary project worker is selected.'
            : parsed.kind === 'curator' && purpose !== 'executor'
              ? 'Always the current project-selected curator session; task-linked and author sessions do not override it. Without a live curator recipient this question falls back to the operator.'
              : purpose === 'executor'
                ? `${parsed.kind === 'curator' ? 'A curator-bound executor turn uses column orchestrator routing. ' : ''}Project-selected live session; task-linked or author sessions can override it. Without a live executor recipient, the turn waits for a session.`
                : purpose === 'course-check'
                  ? 'Project-selected live session; task-linked or author sessions can override it. Without a live recipient this question falls back to the operator.'
                  : 'Project-selected live session; task-linked or author sessions can override it. Without a live orchestrator, ordinary questions wait for a session.',
    };
  }
  const mirror = readyMirrorOf(project);
  const columns = [];
  for (const metadata of COLUMNS) {
    const column = project.columns.find((entry) => entry.id === metadata.id && entry.enabled);
    if (column === undefined) continue;
    const named =
      column.orchestrator === 'none' || column.orchestrator === 'operator'
        ? undefined
        : project.spurProjects.find((spur) => spur.name === column.orchestrator);
    const kind =
      column.orchestrator === 'operator'
        ? ('operator' as const)
        : named?.role === 'curator'
          ? ('curator' as const)
          : named !== undefined
            ? ('orchestrator' as const)
            : column.id === 'external-review'
              ? ('dispatcher' as const)
              : operatorWhenUnbound(column.id)
                ? ('operator' as const)
                : ('worker' as const);
    // An unbound column run by the operator keeps an unbound column's question routing.
    const unbound = kind === 'operator' && column.orchestrator === 'none';
    const role: AddresseeRole =
      kind === 'curator'
        ? 'curator'
        : kind === 'orchestrator'
          ? `orchestrator:${column.id}`
          : kind === 'worker'
            ? 'worker'
            : 'operator';
    const executorDestination = await destination(role, 'executor');
    const author =
      named === undefined
        ? ('operator' as const)
        : encodeActorId({ actor: 'agent', actorRef: { project: named.name, session: 'policy' } });
    const heldByActor = (step: AddresseeRole) => {
      const parsed = parseAddressee(step);
      return (
        named !== undefined &&
        (parsed.kind === 'curator'
          ? curator === named.name
          : parsed.kind === 'orchestrator' &&
            project.columns.some(
              (entry) => entry.id === parsed.column && entry.orchestrator === named.name,
            ))
      );
    };
    const chainRole: AddresseeRole = unbound ? 'worker' : role;
    const chain =
      kind === 'dispatcher' || metadata.group !== null
        ? []
        : [await destination(chainRole, 'question')];
    if (chain.length > 0 && chainRole !== 'operator') {
      let step = blockAddressee({
        type: 'needs_input',
        author,
        authorRole: chainRole,
        column: column.id,
        orchestrator: column.orchestrator === 'none' ? null : column.orchestrator,
        curator,
        hasWorker: kind === 'worker' || unbound,
      });
      for (let i = 0; i < 3; i++) {
        chain.push(await destination(step, 'question'));
        if (step === 'operator') break;
        step = escalateBlock(
          {
            type: 'needs_input',
            state: 'open',
            outcome: null,
            unblockedBy: null,
            author,
            addressee: step,
          },
          curator !== null,
          heldByActor,
        ).addressee;
      }
    }
    const returns = returnRules(
      column.id,
      metadata.returnable,
      kind === 'dispatcher',
      from,
      externalRule(project, column.id),
    );
    const next = nextColumn(project, column.id);
    const timings = columnTurnTimings(config, project.id, column.id);
    const quietAfterMs = stuckTurnAfterMs(config, project.id, {
      column: column.id,
      role: turnExecutor(column.id, column.orchestrator, true),
    });
    columns.push({
      id: column.id,
      name: metadata.name,
      ...(metadata.group === null ? {} : { group: metadata.group }),
      exit: {
        to: next === 'done' ? null : (next ?? null),
        conditions: describeConditions(column.id, project),
      },
      returns,
      limits: metadata.returnable
        ? {
            cycleLimit: column.cycleLimit,
            courseCheck: column.courseCheck,
            courseCheckTo: await destination(
              courseAddressee(config, project.id, column.id),
              'course-check',
            ),
          }
        : null,
      executor: {
        kind,
        project: named?.name ?? null,
        role: named?.role ?? null,
        displayName: named?.displayName ?? named?.name ?? null,
        session: executorDestination.session,
        text:
          metadata.group !== null
            ? 'No executor turn opens in the Todo group, even with a configured binding.'
            : kind === 'dispatcher'
              ? 'The dispatcher waits for external approval; nobody takes a turn in this unbound External Review column.'
              : kind === 'operator' && column.id !== 'done'
                ? operatorText(unbound, metadata.required, project.checksGate === column.id)
                : column.id === 'done' && kind === 'worker'
                  ? 'The task-linked live worker gets a wrap-up turn; without one no turn opens. Done has no exit gate.'
                  : `${executorDestination.text}${column.id === 'done' ? ' Done may open an agent wrap-up turn; it has no exit gate.' : ''}`,
      },
      escalation: {
        chain,
        noRecipient:
          metadata.group !== null || timings === null
            ? null
            : {
                operatorItemAfterMs: timings.noRecipientAfterMs,
                text: 'Active with dispatcher on: an untaken named-orchestrator turn with no recipient raises one operator item per project/column. The wait starts at the later of ring creation and loss of the last eligible session from the named project or task-linked orchestrator; later changes in the same gap do not restart it. Spur being blind, incomplete or stale suppresses raising; existing items stay. A recipient clears the item; a closed item stays closed while the same oldest turn waits. The turn waits for a session and is not rerouted.',
              },
        silent:
          metadata.group !== null || kind === 'operator' || kind === 'dispatcher'
            ? null
            : {
                remindAfterMs: quietAfterMs,
                operatorItemAfterReminderReadMs: quietAfterMs,
                unhealthyAfterMs: config.health.turnStallAfterMs,
                text: `Active with dispatcher on; shadow only models policy. A taken named executor uses its effective column quietTurnAfterMs. Existing worker/operator turns keep the global idle threshold. A taken agent turn gets one reminder after observed idle time; an operator item follows after the reminder is read and another quiet period. Open questions and blind sources pause observation. An unread reminder does not start the post-read timer; an exhausted failed reminder can raise an operator item once the current quiet period reaches remindAfterMs. Unhealthy executor episodes use continuous observation and turnStallAfterMs. Ordinary doorbells wait ${String(config.doorbells.firstRetryMs)}, then ${String(config.doorbells.secondRetryMs)} ms between delivered rings; the final unanswered pause is ${String(config.doorbells.unansweredAfterMs)} ms.`,
              },
      },
      movedBy:
        mirror !== undefined && column.id === 'ready-for-dev'
          ? {
              kind: 'mirror' as const,
              text: `GitHub Project ${mirror.project} places idle work here while its ${mirror.field} field is ${mirror.value}, and back in Todo otherwise; manual moves into or out of this column are refused. Operator correction can still repair placement until the next complete read. Work starting leaves the whole Todo group.`,
            }
          : {
              kind: metadata.group !== null ? ('manual' as const) : ('dispatcher' as const),
              text:
                metadata.group !== null
                  ? column.id === 'todo'
                    ? 'New and reopened tasks enter Todo; task add and manual moves place idle work here; operator correction can also repair placement. Work starting leaves the whole Todo group.'
                    : 'Manual moves place idle work here; operator correction can also repair placement. New and reopened tasks enter Todo; work starting leaves the whole Todo group.'
                  : 'The dispatcher advances passing gates and completion shortcuts; in shadow mode it records only a shadow position. Operator corrections can also place tasks here.',
            },
    });
  }
  return {
    id: project.id,
    dispatcher: { mode: project.dispatcher.mode },
    checksGate: project.checksGate,
    reposWithoutCi: [...project.reposWithoutCi],
    resolvedThreadsFrom: from ?? null,
    completion: describeCompletion(project),
    columns,
  };
}

/** The column help of External Review while its course check is on. */
const EXTERNAL_ROUNDS_RULE =
  "Returns for external comments (a changes-requested review is one) from any column, and each external change request on a new PR head while the task is in Dev, count toward this column's courseCheck, once per head; cycleLimit stays with the column the task left.";

/** The column help of External Review while its course check is 0. */
const EXTERNAL_ROUNDS_OFF =
  "Returns for external comments from any column count toward this column's courseCheck, which is 0: they raise no course check, and change requests on new PR heads in Dev are not counted; cycleLimit stays with the column the task left.";

/** The column help of every other returnable column while External Review is enabled. */
const EXTERNAL_RETURNS_ELSEWHERE =
  "Returns for external comments count toward External Review's courseCheck, not this column's; this column's cycleLimit still counts them.";

/**
 * The column help line on where returns for external comments count (`courseCounter`), or null
 * when External Review is not enabled and every return counts on the column it left.
 */
function externalRule(project: Pick<Project, 'columns'>, column: ColumnId): string | null {
  const external = externalColumn(project);
  if (external === undefined) return null;
  if (column !== 'external-review') return EXTERNAL_RETURNS_ELSEWHERE;
  return external.courseCheck > 0 ? EXTERNAL_ROUNDS_RULE : EXTERNAL_ROUNDS_OFF;
}

function returnRules(
  column: ColumnId,
  returnable: boolean,
  dispatcher: boolean,
  from: ColumnId | undefined,
  external: string | null,
): string[] {
  if (column === 'done') return ['A reopened ticket without a merged PR returns to Todo, not Dev.'];
  if (!returnable) return [];
  return [
    ...(!dispatcher ? ['The executor can return its taken turn to Dev with findings.'] : []),
    'A missing or closed PR, red checks, unhandled external feedback (including changes requested), merge conflicts or a draft PR can break an upstream gate and return the task to Dev; reopened tickets may instead return to Todo.',
    ...(from !== undefined && COLUMN_IDS.indexOf(from) <= COLUMN_IDS.indexOf(column)
      ? [
          'Unresolved review threads, outdated ones included, return the task to Dev from the effective thread gate onward.',
        ]
      : []),
    'A new PR head invalidates head-bound marks and submissions and can return the task to Dev. A taken turn otherwise defers broken upstream gates until submit. Pending checks, unknown mergeability and incomplete history alone hold the task without returning it.',
    ...(external === null ? [] : [external]),
  ];
}
