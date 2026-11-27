import { COLUMN_IDS, type ColumnId } from '@spur-board/contracts';
import type { GateProject } from '../../src/domain/gates.ts';
import type { PrRef, WaitsForFacts } from '../../src/domain/waits-for.ts';

// Shared facts of the waits-for ladder tests.

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const MINIMAL: readonly ColumnId[] = ['todo', 'dev', 'review', 'done'];

/** A project with the `enabled` columns on and every other column off. */
export const project = (enabled: readonly ColumnId[] = MINIMAL): GateProject => ({
  columns: COLUMN_IDS.map((id) => ({ id, enabled: enabled.includes(id), orchestrator: 'none' })),
  reposWithoutCi: [],
  checksGate: 'dev',
});

const open: PrRef = { repo: 'o/r', number: 7, state: 'open' };
export const merged: PrRef = { ...open, state: 'merged' };
export const closed: PrRef = { ...open, state: 'closed' };

export type Read = Extract<WaitsForFacts, { column: ColumnId }>;
type Work = Read['work'];

/** Nothing reopened, the ticket open, no live worker and fresh polls, with `changes` over it. */
export const work = (changes: Partial<Work> = {}): Work => ({
  reopened: false,
  githubBlind: false,
  ticketDone: false,
  liveWorker: false,
  hasOpenLinkedPr: false,
  allGithubReposReady: true,
  spurReady: true,
  spurBlind: false,
  ...changes,
});

/** A task in Review of the minimal board, its gate passing, with nothing holding it. */
export const facts = (changes: Partial<Read> = {}): Read => ({
  project: project(),
  archived: false,
  gate: { ok: true },
  column: 'review',
  holds: [],
  heldBlocks: [],
  pendingSha: undefined,
  turn: null,
  waiting: [],
  pr: open,
  work: work(),
  ...changes,
});

export const failing = (column: ColumnId, ...reasons: Read['waiting'][number]['reason'][]) => {
  const [first = 'no_pr', ...rest] = reasons;
  return { ok: false as const, column, reasons: [first, ...rest] as const };
};
