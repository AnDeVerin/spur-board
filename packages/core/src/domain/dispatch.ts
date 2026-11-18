import {
  COLUMNS,
  COLUMN_IDS,
  GATE_REASONS,
  isTodoGroupColumn,
  type ColumnId,
  type GateReason,
  type MoveReason,
  type TaskHold,
} from '@spur-board/contracts';
import {
  evaluateGate,
  HOLD_ONLY,
  type GateMark,
  type GateProject,
  type ReturnCause,
  type TaskGateFacts,
  threadsGated,
} from './gates.ts';

// The dispatcher's rules over one task, with no store and no clock: from the task's column and
// facts it runs the whole cascade in memory and returns the moves and at most one turn. The app
// layer applies them inside the caller's transaction.

/** The turns of the task's current visit `(column, column_epoch)`, newest first. */
interface VisitTurn {
  /**
   * `unclosed`: the newest turn is not closed. `submitted`: it was closed by a submit. `none`: no
   * turn, or the newest was closed as archived, moved or rerouted.
   */
  visit: 'none' | 'unclosed' | 'submitted';
  /** The unclosed turn was taken (acked). */
  open: boolean;
  /** The unclosed turn is the operator's and nobody took it. */
  operatorUntaken: boolean;
  /** The unclosed turn was opened on a PR head other than the current one. */
  headMoved: boolean;
}

interface DispatchInput {
  column: ColumnId;
  project: GateProject;
  facts: TaskGateFacts;
  /** Reopen evidence from a hidden PR, or a reopened ticket while the task is in Done. */
  reopened: boolean;
  /** The current ticket is in a configured done status. */
  ticketDone: boolean;
  /** Any open unbanned linked PR, including conflict links, past the reopen floor. */
  hasOpenLinkedPr: boolean;
  /** Every configured repository is unblind with a complete poll started after the task changed. */
  allGithubReposReady: boolean;
  /** Spur is unblind with a complete poll started after the task changed. */
  spurReady: boolean;
  /** The task has an open PR link past its reopen floor. */
  openPr: boolean;
  /** GitHub has no fresh view of the task: blind, or no complete poll since start. */
  githubBlind: boolean;
  /** Spur has no fresh view: blind, or no complete poll since start. */
  spurBlind: boolean;
  /** A worker session linked to the task is live, as Spur last reported. */
  liveWorker: boolean;
  /** An active cycle-limit or course-check item holds the task. */
  cycleHeld: boolean;
  /** A turn submit of the current visit waits for a poll to confirm its head: nothing moves. */
  submitPending: boolean;
  /**
   * A pending turn submit failed (head moved, PR closed, no PR), in the current visit or in the
   * visit a left move with no turn left: its turn goes back to the executor even on a closed PR,
   * or after a left move to the target column's executor.
   */
  submitFailed: boolean;
  turn: VisitTurn;
}

interface DispatchMove {
  from: ColumnId;
  to: ColumnId;
  reason: MoveReason;
  /** The failing reasons; present only on a `gate_broken` move. */
  gate?: GateReason[];
}

interface DispatchTurn {
  column: ColumnId;
  /** The failing gate reasons at `column`; empty for a wrap-up turn. */
  reasons: GateReason[];
  kind: 'entry' | 'after_submit' | 'wrap_up' | 'reroute';
}

interface DispatchResult {
  moves: DispatchMove[];
  turn: DispatchTurn | null;
  /**
   * The column whose submits the result voids, marks kept: set with an `after_submit` turn and
   * with any Dev turn that hands over new feedback, so the submit before it cannot pass the gate
   * past the work that turn hands over.
   */
  voids?: ColumnId;
}

/** No rule cycles, so a real cascade ends long before this; the bound is a guard. */
const STEP_BOUND = 2 * COLUMN_IDS.length;

const NO_TURN: VisitTurn = {
  visit: 'none',
  open: false,
  operatorUntaken: false,
  headMoved: false,
};

const indexOf = (column: ColumnId) => COLUMN_IDS.indexOf(column);

function orchestratorOf(project: GateProject, column: ColumnId): string {
  return project.columns.find((c) => c.id === column)?.orchestrator ?? 'none';
}

const groupOf = (column: ColumnId) => COLUMNS.find((c) => c.id === column)?.group ?? null;

/**
 * The next enabled column of the project right of `column`, if any. From a column of a group it
 * skips the rest of that group, so a task leaves the group in one move.
 */
function nextColumn(project: GateProject, column: ColumnId): ColumnId | undefined {
  const group = groupOf(column);
  return project.columns.find(
    (c) =>
      c.enabled && indexOf(c.id) > indexOf(column) && (group === null || groupOf(c.id) !== group),
  )?.id;
}

/** A left move to `to` voids the submits of `to` and right of it; marks stay. */
function dropSubmits(marks: readonly GateMark[], to: ColumnId): GateMark[] {
  return marks.filter((mark) => mark.kind === 'mark' || indexOf(mark.column) < indexOf(to));
}

/** Whether work on the task started: it has an open PR, or a live worker and no reopen. */
function workStarted(input: DispatchInput): boolean {
  const workerLive = input.liveWorker && !input.spurBlind;
  return input.openPr || (!input.reopened && workerLive);
}

function ticketFinished(input: DispatchInput): boolean {
  return input.ticketDone && !input.hasOpenLinkedPr && !input.liveWorker;
}

function absenceReady(input: DispatchInput): boolean {
  return ticketFinished(input) && input.allGithubReposReady && input.spurReady && !input.spurBlind;
}

/**
 * What holds the dispatcher on the task now: a blind GitHub or a pending submit stops it, a blind
 * Spur defers a worker's turn, an active cycle-limit or course-check item stops every turn and
 * move right, and the Todo group (To Do, Triage, Ready for Dev) waits for the work to start. The last is judged at the
 * task's column, while `dispatch` judges it at each column the cascade reaches.
 */
export function dispatchHolds(input: DispatchInput): TaskHold[] {
  const holds: TaskHold[] = [];
  if (
    input.githubBlind ||
    (input.column !== 'done' &&
      input.facts.pr?.state !== 'merged' &&
      ticketFinished(input) &&
      !input.allGithubReposReady)
  )
    holds.push('github_blind');
  if (
    input.spurBlind ||
    (input.column !== 'done' &&
      input.facts.pr?.state !== 'merged' &&
      ticketFinished(input) &&
      !input.spurReady)
  )
    holds.push('spur_blind');
  if (input.submitPending) holds.push('submit_pending');
  if (input.cycleHeld) holds.push('cycle_limit');
  if (isTodoGroupColumn(input.column) && !workStarted(input) && !absenceReady(input))
    holds.push('work_not_started');
  return holds;
}

/**
 * Runs the dispatcher cascade from the task's column: each step moves the task or ends with at
 * most one turn for its column. A turn whose executor is the worker (a column with orchestrator
 * `none`) is deferred while Spur is blind.
 */
export function dispatch(input: DispatchInput): DispatchResult {
  const moves: DispatchMove[] = [];
  if (input.githubBlind || input.submitPending) return { moves, turn: null };
  const { project, reopened, cycleHeld } = input;
  const workerLive = input.liveWorker && !input.spurBlind;
  const started = workStarted(input);
  // A left move resets `turn`, so the failed submit is judged on the input visit: the one it was
  // made in, or a visit with no turn yet that a deferred hand-back carried it to.
  const handsBack = input.submitFailed && input.turn.visit !== 'unclosed';
  let { column, facts, turn } = input;
  const move = (to: ColumnId, reason: MoveReason, gate?: GateReason[]) => {
    moves.push({ from: column, to, reason, ...(gate === undefined ? {} : { gate }) });
    if (indexOf(to) < indexOf(column)) facts = { ...facts, marks: dropSubmits(facts.marks, to) };
    column = to;
    turn = NO_TURN;
  };
  const result = (next: DispatchTurn | null): DispatchResult => {
    const deferred =
      next !== null && input.spurBlind && orchestratorOf(project, next.column) === 'none';
    const opened = cycleHeld || deferred ? null : withThreads(next);
    // Only a Dev turn hands over feedback, and none from an incomplete history (applyOn).
    const handsOver =
      opened?.column === 'dev' &&
      facts.commentHistory === 'complete' &&
      facts.unhandledExternalComments > 0;
    return opened !== null && (opened.kind === 'after_submit' || handsOver)
      ? { moves, turn: opened, voids: opened.column }
      : { moves, turn: opened };
  };

  // A Dev turn names unresolved threads whenever a column of the project requires them resolved,
  // even where Dev's own gate ignores them, so the worker resolves them before moving right.
  const withThreads = (next: DispatchTurn | null): DispatchTurn | null => {
    if (next?.column !== 'dev' || !threadsGated(project) || facts.unresolvedThreads === 0)
      return next;
    const { reasons } = next;
    if (reasons.some((r) => r === 'no_pr' || r === 'pr_closed' || r === 'unresolved_threads'))
      return next;
    const added = new Set<GateReason>([...reasons, 'unresolved_threads']);
    return { ...next, reasons: GATE_REASONS.filter((reason) => added.has(reason)) };
  };

  for (let step = 0; step < STEP_BOUND; step++) {
    const merged = facts.pr?.state === 'merged';
    if (column === 'done') {
      if (reopened && !merged && !input.ticketDone) {
        move('todo', 'ticket_reopened');
        continue;
      }
      if (turn.visit !== 'none') return result(null);
      const executor = orchestratorOf(project, 'done');
      const agent = executor === 'none' ? workerLive : executor !== 'operator';
      return result(agent ? { column, reasons: [], kind: 'wrap_up' } : null);
    }
    if (merged) {
      move('done', 'merged');
      continue;
    }
    if (absenceReady(input)) {
      move('done', 'ticket_done_no_pr');
      continue;
    }
    // The reopen hid the task's only PR, merged before it but seen merged later: To Do, as from Done.
    if (reopened && facts.pr === null && column !== 'todo') {
      move('todo', 'ticket_reopened');
      continue;
    }
    const gate = evaluateGate(column, facts, project);
    if (gate.ok) {
      if (isTodoGroupColumn(column) && !started) return result(null);
      const next = nextColumn(project, column);
      if (cycleHeld || next === undefined || next === 'done') return result(null);
      move(next, 'gate_passed');
      continue;
    }
    const reasons = [...gate.reasons];
    if (gate.column !== column) {
      // A taken turn holds the task, unless a new head closed it: no mark counts on that head.
      const held = turn.open && !turn.headMoved;
      if (cycleHeld || held || reasons.every((reason) => HOLD_ONLY.has(reason))) {
        return result(null);
      }
      move(gate.column, 'gate_broken', reasons);
      continue;
    }
    const executor = orchestratorOf(project, column);
    if (column === 'external-review' && executor === 'none') return result(null);
    // A closed PR opens no turn, except to hand back a pending submit it failed.
    if (reasons.includes('pr_closed') && !handsBack) return result(null);
    switch (turn.visit) {
      case 'none':
        return result({ column, reasons, kind: 'entry' });
      case 'unclosed':
        return result(
          turn.operatorUntaken && executor === 'none' && workerLive
            ? { column, reasons, kind: 'reroute' }
            : null,
        );
      case 'submitted':
        return result(
          reasons.some((reason) => !HOLD_ONLY.has(reason))
            ? { column, reasons, kind: 'after_submit' }
            : null,
        );
    }
  }
  return result(null);
}

const CAUSE_OF: Partial<Record<GateReason, ReturnCause>> = {
  checks_red: 'checks_red',
  conflict: 'conflict',
  pr_draft: 'draft',
  external_comments: 'external_comments',
  unresolved_threads: 'unresolved_threads',
};

/**
 * The cycle causes of a return to Dev: `executor` when the column executor returned it with a
 * block, then one cause per gate reason that maps to one. Other reasons give no cause.
 */
export function returnCauses(gate: readonly GateReason[], byExecutor: boolean): ReturnCause[] {
  const causes: ReturnCause[] = byExecutor ? ['executor'] : [];
  for (const reason of gate) {
    const cause = CAUSE_OF[reason];
    if (cause !== undefined && !causes.includes(cause)) causes.push(cause);
  }
  return causes;
}

/**
 * The reason text of a new turn: `<column>: <reason>, <reason>`, or `done: wrap up`. A reroute
 * keeps the reason of the operator turn it replaces, given as `rerouted`.
 */
export function turnReason(turn: DispatchTurn, rerouted?: string): string {
  if (turn.kind === 'wrap_up') return 'done: wrap up';
  if (turn.kind === 'reroute' && rerouted !== undefined) return rerouted;
  return `${turn.column}: ${turn.reasons.join(', ')}`;
}
