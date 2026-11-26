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

/**
 * The facts of `why`: `project` null when the project left the config, `gate` null when the
 * stored pull request snapshot is missing.
 */
export type WaitsForFacts =
  | { project: null }
  | { project: GateProject; gate: null }
  | {
      project: GateProject;
      gate: ReturnType<typeof evaluateGate>;
      column: ColumnId;
      holds: readonly TaskHold[];
      /** Blocks of the open cycle-limit and course-check items, in item order. */
      heldBlocks: readonly { id: string; addressee: AddresseeRole }[];
      pendingSha: string | undefined;
      turn: { id: string; column: ColumnId; addressee: AddresseeRole } | null;
      waiting: readonly Waiting[];
      pr: PrRef | null;
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

const WORK_TO_START = 'work to start: an open PR or a live worker';
const TICKET_WITHOUT_WORK = 'ticket to close, with no open PR and no live worker';

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
  if (facts.turn !== null)
    return wait(
      'turn',
      `${columnName(facts.turn.column)} turn ${facts.turn.id}`,
      facts.turn.addressee,
    );
  if (holds.includes('spur_blind')) return wait('spur', 'Spur to be readable');
  if (holds.includes('work_not_started')) return wait('work', WORK_TO_START);
  const [waiting] = facts.waiting;
  const fact = waiting === undefined ? undefined : WAITING[waiting.reason]?.(waiting, pr);
  if (fact !== undefined) return fact;
  if (column === 'done') return wait('done', 'nothing, the task is done');
  if (gate.ok) {
    const next = nextColumn(project, column);
    if (pr?.state === 'merged') return wait('board', 'the next dispatcher pass to move it to done');
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
 * in Done, and the To Do group gate of the column a task sits in before work starts.
 */
export function gateWaitsFor(
  gate: { column: ColumnId; enabled: boolean },
  facts: {
    column: ColumnId;
    holds: readonly TaskHold[];
    pr: PrRef | null;
    ticketDone: boolean;
  },
): string | undefined {
  if (gate.column === 'done' && gate.enabled && facts.column !== 'done') {
    if (facts.pr?.state === 'open')
      return facts.ticketDone
        ? `merge of ${refOf(facts.pr)}`
        : `merge of ${refOf(facts.pr)}, then the ticket to close`;
    if (facts.pr?.state === 'merged')
      return facts.ticketDone ? 'the next dispatcher pass to move it to done' : 'ticket to close';
    return TICKET_WITHOUT_WORK;
  }
  if (
    isTodoGroupColumn(gate.column) &&
    gate.column === facts.column &&
    facts.holds.includes('work_not_started')
  )
    return WORK_TO_START;
  return undefined;
}
