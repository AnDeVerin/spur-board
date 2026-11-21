import { browserOperations } from '@spur-board/contracts/browser';

/**
 * One `columns.describe` column: a dispatcher column with no rules, no returns and no limits,
 * unless `extra` says otherwise. A plain object of the column shape; only `policy` parses.
 */
export const policyColumn = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  exit: { to: null, conditions: [] },
  returns: [],
  limits: null,
  executor: {
    kind: 'dispatcher',
    project: null,
    role: null,
    displayName: null,
    session: null,
    text: 'The dispatcher moves the task when the rules hold; nobody takes a turn.',
  },
  escalation: { chain: [], noRecipient: null, silent: null, quiet: null },
  movedBy: { kind: 'dispatcher', text: 'The dispatcher moves tasks in when the rules hold.' },
  ...extra,
});
/** A parsed `columns.describe` answer naming one project and its columns. */
export const policy = (
  projectId: string,
  columns: unknown[],
  extra: Record<string, unknown> = {},
) =>
  browserOperations['columns.describe'].output.parse({
    projects: [
      {
        id: projectId,
        dispatcher: { mode: 'on' },
        checksGate: 'dev',
        reposWithoutCi: [],
        resolvedThreadsFrom: null,
        completion: { to: 'done', text: 'A merged PR with a done ticket completes the task.' },
        columns,
        ...extra,
      },
    ],
  });
