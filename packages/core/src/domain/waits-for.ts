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
import { COMPLETION_RULE, nextColumn, type CompletionFacts } from './dispatch.ts';
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

/**
 * What the dispatcher reads about the work besides the PR: the completion facts, a reopen (only an
 * open PR then counts as started work) and a blind GitHub, which stops every move.
 */
export interface WorkFacts extends CompletionFacts {
  reopened: boolean;
  githubBlind: boolean;
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
const TICKET_WITHOUT_WORK = 'ticket to close, with no open PR and no live worker';

/**
 * Whether completion, which bypasses every gate and turn, judges the task now: a done ticket, or a
 * merged PR the gates judge (an unconfirmed ticket holds the task before it).
 */
const completes = (pr: PrRef | null, work: WorkFacts) => work.ticketDone || pr?.state === 'merged';

/**
 * What completion waits for, by the first unmet condition of `COMPLETION_RULE`: a merged PR or a
 * finished ticket with fresh polls moves the task. An open PR completes it once merged, or once
 * closed when no worker is live; a live worker otherwise blocks only the closed-ticket route.
 */
function completionWait(pr: PrRef | null, work: WorkFacts): Wait {
  if (COMPLETION_RULE.reason(pr, work) !== null) return ['board', NEXT_PASS_TO_DONE, null];
  if (pr?.state === 'open')
    return work.liveWorker
      ? ['merge', `merge of ${refOf(pr)}`, 'human']
      : ['merge', `merge of ${refOf(pr)} or close it unmerged`, 'human'];
  if (work.hasOpenLinkedPr) return ['merge', 'an open linked PR to merge or close', 'human'];
  if (work.liveWorker) return ['work', 'the worker session to end, with no open PR', null];
  // The ticket is finished; what absenceReady still misses is fresh, complete, unblind polls.
  return ['board', 'fresh polls of Spur and every GitHub repository since the last change', null];
}

/** What work start waits for: after a reopen only an open PR counts. */
const workToStart = (work: WorkFacts): Wait =>
  work.reopened
    ? ['work', 'work to start: an open PR (the ticket was reopened)', null]
    : ['work', 'work to start: an open PR or a live worker', null];

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

type Read = Extract<WaitsForFacts, { column: ColumnId }>;

/**
 * What stops the dispatcher before it judges the task, in its own order: `dispatch()` returns at
 * once while GitHub is blind or a submit is pending, and the pass skips a task whose ticket is not
 * confirmed after a merge (`app/dispatch.ts`).
 */
function stopped(facts: Read): Wait | undefined {
  if (facts.work.githubBlind) return ['github', 'GitHub to be readable', null];
  if (facts.holds.includes('submit_pending'))
    return ['board', `confirmation of submit ${(facts.pendingSha ?? '').slice(0, 7)}`, null];
  if (facts.holds.includes('ticket_unconfirmed')) return ['ticket', 'ticket to close', null];
  return undefined;
}

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
  const stop = stopped(facts);
  if (stop !== undefined) return wait(...stop);
  // Completion that fires moves the task before any turn or gate counts (dispatch() checks it
  // first in its loop); completion that would not fire leaves the turn as it is.
  if (column !== 'done' && COMPLETION_RULE.reason(pr, facts.work) !== null)
    return wait('board', NEXT_PASS_TO_DONE);
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
  // A gate that fails on a fact not known yet holds the task before completion can still come.
  const [waiting] = facts.waiting;
  const fact = waiting === undefined ? undefined : WAITING[waiting.reason]?.(waiting, pr);
  if (fact !== undefined) return fact;
  if (column !== 'done' && completes(pr, facts.work))
    return wait(...completionWait(pr, facts.work));
  if (holds.includes('work_not_started')) return wait(...workToStart(facts.work));
  if (column === 'done') return wait('done', 'nothing, the task is done');
  if (gate.ok) {
    const next = nextColumn(project, column);
    if (next === undefined || next === 'done')
      return pr?.state === 'open'
        ? wait('merge', `merge of ${refOf(pr)}`, 'human')
        : wait('ticket', TICKET_WITHOUT_WORK);
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
 * in Done, and the To Do group gate of the column a task sits in before work starts. The Done gate
 * names what stops the dispatcher first, so it never promises a pass that cannot act.
 */
export function gateWaitsFor(
  gate: { column: ColumnId; enabled: boolean },
  facts: Read,
): string | undefined {
  if (facts.archived) return undefined;
  if (gate.column === 'done' && gate.enabled && facts.column !== 'done') {
    const stop = stopped(facts);
    if (stop !== undefined) return stop[1];
    if (completes(facts.pr, facts.work)) return completionWait(facts.pr, facts.work)[1];
    return facts.pr?.state === 'open'
      ? `merge of ${refOf(facts.pr)}, then the ticket to close`
      : TICKET_WITHOUT_WORK;
  }
  if (
    isTodoGroupColumn(gate.column) &&
    gate.column === facts.column &&
    facts.holds.includes('work_not_started')
  )
    return (
      completes(facts.pr, facts.work)
        ? completionWait(facts.pr, facts.work)
        : workToStart(facts.work)
    )[1];
  return undefined;
}
