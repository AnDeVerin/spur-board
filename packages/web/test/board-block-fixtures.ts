// Discussion fixtures of the board screen: blocks, comments and `block.get`; `board-fixtures.ts`
// re-exports them.
/** Valid mixed discussion records, with overrides for lifecycle and provenance tests. */
export const block = (extra: Record<string, unknown> = {}) => ({
  id: 'B12',
  task: 'ex/repo#7',
  type: 'needs_input',
  state: 'open',
  author: 'agent:worker/s1',
  addressee: 'operator',
  reason: 'Pick a path\nKeep this line.',
  at: '2026-11-15T13:00:00.000Z',
  outcome: null,
  outcomeReason: null,
  unblockedBy: null,
  unblockedAt: null,
  answeredVia: null,
  ...extra,
});
/**
 * `block.get` of the inbox row `B1`: an open question of project `a` from `agent:a/w1` to the
 * operator, with no replies; `blockExtra` overrides the block, `extra` the answer.
 */
export const blockGet = (
  blockExtra: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  block: block({
    id: 'B1',
    task: null,
    project: 'a',
    author: 'agent:a/w1',
    at: '2026-11-15T14:00:00.000Z',
    ...blockExtra,
  }),
  project: 'a',
  comments: [],
  ...extra,
});
export const comment = (extra: Record<string, unknown> = {}) => ({
  id: 'C1',
  task: 'ex/repo#7',
  block: null,
  author: 'operator',
  at: '2026-11-15T13:30:00.000Z',
  text: 'A task comment',
  revision: 1,
  ackedRevision: null,
  untrusted: true,
  ...extra,
});
