import {
  COLUMNS,
  isTodoGroupColumn,
  type AddresseeRole,
  type ColumnId,
  type GateReason,
  type PrState,
  type TaskHold,
  type WaitsForKind,
} from '@spur-board/contracts';
import { nextColumn } from './dispatch.ts';
import type { evaluateGate, GateProject } from './gates.ts';

// What `board task --why` says a task waits for, read from the facts `why` already computed. It
// only reads the gate logic; the order of the ladder below is the order of the answer.

/** What a task waits for and who acts next: a role, `human` on GitHub, or null for the board. */
export interface WaitsFor {
  kind: WaitsForKind;
  text: string;
  actor: AddresseeRole | 'human' | null;
}

/** The pull request the gates judge. */
export interface PrRef {
  repo: string;
  number: number;
  state: PrState;
}

/** A fact `why` lists in `waiting`. */
type Waiting = { reason: GateReason; head: string; reviewers?: readonly string[] };

/** What the dispatcher reads about the work besides the PR: completion and work start use it. */
export interface WorkFacts {
  /** A reopen: only an open PR counts as started work, a live worker does not. */
  reopened: boolean;
  ticketDone: boolean;
  liveWorker: boolean;
  /** A linked PR, the judged one or another, is open: completion without a merge waits for it. */
  hasOpenLinkedPr: boolean;
}

/** The open turn: `byOperator` when the operator took it over; `wait` while its holder waits. */
interface TurnFacts {
  id: string;
  column: ColumnId;
  addressee: AddresseeRole;
  byOperator: boolean;
  wait?: { reason: string; wakesAt: string };
}

/**
 * The facts of `why`: `project` null when the project left the config, `gate` null when the
 * stored pull request snapshot is missing, `archived` when the dispatcher skips the task.
 */
export type WaitsForFacts =
  | { project: null }
  | { project: GateProject; archived: boolean; gate: null }
  | {
      project: GateProject;
      archived: boolean;
      gate: ReturnType<typeof evaluateGate>;
      column: ColumnId;
      holds: readonly TaskHold[];
      /** Blocks of the open cycle-limit and course-check items, in item order. */
      heldBlocks: readonly { id: string; addressee: AddresseeRole }[];
      pendingSha: string | undefined;
      turn: TurnFacts | null;
      waiting: readonly Waiting[];
      pr: PrRef | null;
      work: WorkFacts;
    };

const columnName = (column: ColumnId) =>
  COLUMNS.find((entry) => entry.id === column)?.name ?? column;

const refOf = (pr: PrRef | null) =>
  pr === null ? 'the pull request' : `${pr.repo}#${String(pr.number)}`;

const by = (actor: AddresseeRole | 'human') => (actor === 'human' ? 'a human' : actor);

const wait = (kind: WaitsForKind, text: string, actor: WaitsFor['actor'] = null): WaitsFor => ({
  kind,
  text: actor === null ? text : `${text} (${by(actor)})`,
  actor,
});

/** A wait before its actor joins the text: a gate shows the bare text. */
type Wait = [kind: WaitsForKind, text: string, actor: WaitsFor['actor']];

/** The open turn, its actor the operator who took it over, and its holder's wait on one line. */
function turnWait(turn: TurnFacts): WaitsFor {
  const actor = turn.byOperator ? 'operator' : turn.addressee;
  const line = wait('turn', `${columnName(turn.column)} turn ${turn.id}`, actor);
  if (turn.wait === undefined) return line;
  const until = `${turn.wait.wakesAt.slice(0, 16)}Z`;
  const reason = turn.wait.reason.replace(/\s+/g, ' ').trim();
  return { ...line, text: `${line.text}, waiting until ${until} for ${reason}` };
}
const NEXT_PASS_TO_DONE = 'the next dispatcher pass to move it to done';

/**
 * What completion waits for with the judged PR not open: a done ticket, then no open linked PR and
 * no live worker.
 */
function withoutOpenPr({ ticketDone, hasOpenLinkedPr, liveWorker }: WorkFacts): Wait {
  if (!ticketDone) return ['ticket', 'ticket to close, with no open PR and no live worker', null];
  if (hasOpenLinkedPr) return ['merge', 'an open linked PR to merge or close', 'human'];
  return liveWorker
    ? ['work', 'the worker session to end, with no open PR', null]
    : ['board', NEXT_PASS_TO_DONE, null];
}

/**
 * What a task waits for before work starts: with a done ticket, completion; after a reopen, an
 * open PR, since a live worker no longer counts.
 */
function workWait(work: WorkFacts): Wait {
  if (work.ticketDone) return withoutOpenPr(work);
  return work.reopened
    ? ['work', 'work to start: an open PR (the ticket was reopened)', null]
    : ['work', 'work to start: an open PR or a live worker', null];
}

/** The waits-for line of each fact GitHub or the board has not settled, by its gate reason. */
const WAITING: Partial<Record<GateReason, (entry: Waiting, pr: PrRef | null) => WaitsFor>> = {
  checks_pending: ({ head }) => wait('checks', `CI on ${head.slice(0, 8)}`),
  checks_red: ({ head }) => wait('checks', `green checks on ${head.slice(0, 8)}`),
  mergeable_unknown: ({ head }) =>
    wait('github', `GitHub to compute mergeability on ${head.slice(0, 8)}`),
  comment_history_incomplete: ({ head }) =>
    wait('board', `the board to read the full PR comment history on ${head.slice(0, 8)}`),
  merge_state_unknown: () => wait('github', 'GitHub to compute the merge state'),
  review_rule_unreadable: () =>
    wait('github', 'the GitHub review rule for the base branch to be readable'),
  awaiting_required_reviewers: ({ reviewers }) =>
    wait('approval', `review by ${(reviewers ?? []).join(', ')}`, 'human'),
  review_rule_blocked: () => wait('approval', 'the GitHub review rule to pass', 'human'),
  changes_requested: (_entry, pr) =>
    wait('approval', `a new review of the requested changes on ${refOf(pr)}`, 'human'),
};

/** What the task waits for: the first rung of the ladder that matches. */
export function waitsFor(facts: WaitsForFacts): WaitsFor {
  if (facts.project === null) return wait('config', 'the project in config.yaml', 'operator');
  if (facts.archived)
    return wait(
      'archived',
      'nothing while the task is archived; unarchive it to resume',
      'operator',
    );
  if (facts.gate === null) return wait('board', 'the first poll of the linked PR');
  const { holds, gate, column, project, pr } = facts;
  if (holds.includes('github_blind')) return wait('github', 'GitHub to be readable');
  if (holds.includes('submit_pending'))
    return wait('board', `confirmation of submit ${(facts.pendingSha ?? '').slice(0, 7)}`);
  if (holds.includes('ticket_unconfirmed')) return wait('ticket', 'ticket to close');
  if (holds.includes('cycle_limit')) {
    const [first] = facts.heldBlocks;
    return first === undefined
      ? wait('answer', 'clearing of the cycle-limit or course-check item', 'operator')
      : wait(
          'answer',
          `answer to ${facts.heldBlocks.map((block) => block.id).join(', ')}`,
          first.addressee,
        );
  }
  if (facts.turn !== null) return turnWait(facts.turn);
  if (holds.includes('spur_blind')) return wait('spur', 'Spur to be readable');
  if (holds.includes('work_not_started')) return wait(...workWait(facts.work));
  const [waiting] = facts.waiting;
  const fact = waiting === undefined ? undefined : WAITING[waiting.reason]?.(waiting, pr);
  if (fact !== undefined) return fact;
  if (column === 'done') return wait('done', 'nothing, the task is done');
  if (gate.ok) {
    const next = nextColumn(project, column);
    if (pr?.state === 'merged') return wait('board', NEXT_PASS_TO_DONE);
    if (next === undefined || next === 'done')
      return pr?.state === 'open'
        ? wait('merge', `merge of ${refOf(pr)}`, 'human')
        : wait(...withoutOpenPr(facts.work));
    return wait('board', `the next dispatcher pass to move it to ${next}`);
  }
  if (gate.column === column) {
    if (column === 'ready-to-merge' && gate.reasons.every((reason) => reason === 'not_merged'))
      return wait('merge', `merge of ${refOf(pr)}`, 'human');
    if (column === 'external-review' && gate.reasons.includes('not_approved'))
      return wait('approval', `approval of ${refOf(pr)} by an external reviewer`, 'human');
    return wait('gate', `${columnName(column)} exit: ${gate.reasons.join(', ')}`);
  }
  return wait('board', `the next dispatcher pass to move it back to ${gate.column}`);
}

/**
 * What one gate waits for when its conditions do not say it: the enabled Done gate of a task not
 * in Done, and the To Do group gate of the column a task sits in before work starts.
 */
export function gateWaitsFor(
  gate: { column: ColumnId; enabled: boolean },
  facts: {
    column: ColumnId;
    holds: readonly TaskHold[];
    pr: PrRef | null;
    /** The dispatcher skips an archived task: no gate waits for anything. */
    archived: boolean;
    work: WorkFacts;
  },
): string | undefined {
  if (facts.archived) return undefined;
  const { ticketDone, liveWorker } = facts.work;
  if (gate.column === 'done' && gate.enabled && facts.column !== 'done') {
    const ref = refOf(facts.pr);
    // A done ticket completes the task once its PR is closed too, with no live worker.
    if (facts.pr?.state === 'open')
      return !ticketDone
        ? `merge of ${ref}, then the ticket to close`
        : liveWorker
          ? `merge of ${ref}`
          : `merge of ${ref}, or close it unmerged`;
    if (facts.pr?.state === 'merged') return ticketDone ? NEXT_PASS_TO_DONE : 'ticket to close';
    return withoutOpenPr(facts.work)[1];
  }
  if (
    isTodoGroupColumn(gate.column) &&
    gate.column === facts.column &&
    facts.holds.includes('work_not_started')
  )
    return workWait(facts.work)[1];
  return undefined;
}
