import { COLUMN_IDS, type ColumnId, type GateReason, type MoveReason } from '@spur-board/contracts';
import {
  evaluateGate,
  HOLD_ONLY,
  type GateMark,
  type GateProject,
  type ReturnCause,
  type TaskGateFacts,
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
}

interface DispatchInput {
  column: ColumnId;
  project: GateProject;
  facts: TaskGateFacts;
  /** The task has a PR link hidden by a reopen: its ticket reopened after a merge. */
  reopened: boolean;
  /** The task has an open PR link past its reopen floor. */
  openPr: boolean;
  /** GitHub has no fresh view of the task: blind, or no complete poll since start. */
  githubBlind: boolean;
  /** Spur has no fresh view: blind, or no complete poll since start. */
  spurBlind: boolean;
  /** A worker session linked to the task is live, as Spur last reported. */
  liveWorker: boolean;
  /** An active cycle-limit item holds the task. */
  cycleHeld: boolean;
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
   * The column whose submits the result voids, marks kept: set with an `after_submit` turn, so
   * the submit before it cannot pass the gate past the work that turn hands over.
   */
  voids?: ColumnId;
}

/** No rule cycles, so a real cascade ends long before this; the bound is a guard. */
const STEP_BOUND = 2 * COLUMN_IDS.length;

const NO_TURN: VisitTurn = { visit: 'none', open: false, operatorUntaken: false };

const indexOf = (column: ColumnId) => COLUMN_IDS.indexOf(column);

function orchestratorOf(project: GateProject, column: ColumnId): string {
  return project.columns.find((c) => c.id === column)?.orchestrator ?? 'none';
}

/** The next enabled column of the project right of `column`, if any. */
function nextColumn(project: GateProject, column: ColumnId): ColumnId | undefined {
  return project.columns.find((c) => c.enabled && indexOf(c.id) > indexOf(column))?.id;
}

/** A left move to `to` voids the submits of `to` and right of it; marks stay. */
function dropSubmits(marks: readonly GateMark[], to: ColumnId): GateMark[] {
  return marks.filter((mark) => mark.kind === 'mark' || indexOf(mark.column) < indexOf(to));
}

/**
 * Runs the dispatcher cascade from the task's column: each step moves the task or ends with at
 * most one turn for its column. A turn whose executor is the worker (a column with orchestrator
 * `none`) is deferred while Spur is blind.
 */
export function dispatch(input: DispatchInput): DispatchResult {
  const moves: DispatchMove[] = [];
  if (input.githubBlind) return { moves, turn: null };
  const { project, reopened, cycleHeld } = input;
  const workerLive = input.liveWorker && !input.spurBlind;
  const workStarted = input.openPr || (!reopened && workerLive);
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
    const opened = cycleHeld || deferred ? null : next;
    return opened?.kind === 'after_submit'
      ? { moves, turn: opened, voids: opened.column }
      : { moves, turn: opened };
  };

  for (let step = 0; step < STEP_BOUND; step++) {
    const merged = facts.pr?.state === 'merged';
    if (column === 'done') {
      if (reopened && !merged) {
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
    const gate = evaluateGate(column, facts, project);
    if (gate.ok) {
      if ((column === 'todo' || column === 'ready-for-dev') && !workStarted) return result(null);
      const next = nextColumn(project, column);
      if (cycleHeld || next === undefined || next === 'done') return result(null);
      move(next, 'gate_passed');
      continue;
    }
    const reasons = [...gate.reasons];
    if (gate.column !== column) {
      if (cycleHeld || turn.open || reasons.every((reason) => HOLD_ONLY.has(reason))) {
        return result(null);
      }
      move(gate.column, 'gate_broken', reasons);
      continue;
    }
    const executor = orchestratorOf(project, column);
    if (column === 'external-review' && executor === 'none') return result(null);
    if (reasons.includes('pr_closed')) return result(null);
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
