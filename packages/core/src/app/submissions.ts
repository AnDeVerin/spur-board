import {
  prSourceId,
  type ColumnId,
  type Config,
  type PrPoller,
  type PollPrResult,
  type SubmissionBasis,
  type SubmissionView,
} from '@spur-board/contracts';
import { sql, type Kysely } from 'kysely';
import type { Tables, Row } from '../store/schema.ts';
import { CommandError } from './commands.ts';
import { taskPr, type Trx } from './board-utils.ts';

/** How long a submit waits for its on-demand PR read. */
export const SUBMIT_POLL_TIMEOUT_MS = 10_000;

/** The PR poll `prepare` ran for a submit, or why it ran none. */
export type SubmitPrepared =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'polled';
      /** Lowercase. */
      readonly repo: string;
      readonly number: number;
      /** Null when the daemon has no poller. */
      readonly result: PollPrResult | null;
    };

/** Polls the task's PR on demand for a submit; `skipped` when the task has none. */
export async function pollTaskPr(
  db: Trx,
  task: Row<'task'>,
  poll: PrPoller['pollPr'] | undefined,
): Promise<SubmitPrepared> {
  const pr = await taskPr(db, task.id);
  if (pr === null) return { kind: 'skipped' };
  const repo = pr.repo.toLowerCase();
  const result =
    poll === undefined
      ? null
      : await poll(
          prSourceId(task.project, repo),
          { kind: 'pr', repo: pr.repo, number: pr.number },
          { timeoutMs: SUBMIT_POLL_TIMEOUT_MS },
        );
  return { kind: 'polled', repo, number: pr.number, result };
}

type Db = Kysely<Tables>;
type BasisInput = {
  basis?: SubmissionBasis | undefined;
  from?: string | undefined;
  reason?: string | undefined;
};

/** Resolve provenance independently of current gate validity, pinning the original tested row. */
export async function submissionBasis(db: Db, task: number, input: BasisInput) {
  const basis = input.basis ?? 'tested';
  if (
    (input.reason !== undefined && input.reason.trim().length === 0) ||
    (basis !== 'tested' && input.reason === undefined) ||
    (basis === 'carried' ? input.from === undefined : input.from !== undefined)
  ) {
    throw new CommandError(
      'submit_basis_invalid',
      'Supply from and a nonblank reason for carried, a nonblank reason for skipped, and from only with carried.',
    );
  }
  let origin: { id: number; commit_sha: string } | undefined;
  if (basis === 'carried' && input.from !== undefined) {
    origin = await db
      .selectFrom('submission')
      .select(['id', 'commit_sha'])
      .where('task_id', '=', task)
      .where('commit_sha', '=', input.from)
      .where((eb) => eb.or([eb('basis', 'is', null), eb('basis', '=', 'tested')]))
      .orderBy('id', 'desc')
      .executeTakeFirst();
    origin ??= await db
      .selectFrom('submission as carried')
      .innerJoin('submission as origin', 'origin.id', 'carried.tested_source_id')
      .select(['origin.id', 'origin.commit_sha'])
      .where('carried.task_id', '=', task)
      .where('origin.task_id', '=', task)
      .where('carried.commit_sha', '=', input.from)
      .where('carried.basis', '=', 'carried')
      .where((eb) => eb.or([eb('origin.basis', 'is', null), eb('origin.basis', '=', 'tested')]))
      .orderBy('carried.id', 'desc')
      .executeTakeFirst();
    if (origin === undefined)
      throw new CommandError(
        'submit_source_not_tested',
        'Choose a source SHA with a tested origin on this task, or test or skip with a reason.',
      );
  }
  return {
    values: {
      basis,
      source_sha: input.from ?? null,
      basis_reason: input.reason ?? null,
      tested_source_id: origin?.id ?? null,
    },
    event: {
      basis,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(origin === undefined ? {} : { testedOrigin: origin.commit_sha }),
    },
  };
}

/**
 * One bounded latest row per task, ordered by identity even at equal timestamps; with `column`,
 * the latest row of that column.
 */
export async function latestSubmissions(
  db: Db,
  tasks: readonly Pick<Row<'task'>, 'id'>[],
  column?: ColumnId,
): Promise<Map<number, SubmissionView>> {
  if (tasks.length === 0) return new Map();
  const ids = tasks.map((task) => task.id);
  const inColumn = db
    .selectFrom('submission')
    .select(sql<number>`max(id)`.as('id'))
    .where('task_id', 'in', ids);
  const rows = await db
    .selectFrom('submission as s')
    .leftJoin('submission as origin', 'origin.id', 's.tested_source_id')
    .selectAll('s')
    .select('origin.commit_sha as origin_sha')
    .where('s.task_id', 'in', ids)
    .where(
      's.id',
      'in',
      (column === undefined ? inColumn : inColumn.where('column', '=', column)).groupBy('task_id'),
    )
    .execute();
  return new Map(
    rows.map((row) => [
      row.task_id,
      {
        column: row.column,
        sha: row.commit_sha,
        at: row.submitted_at,
        basis: row.basis ?? 'tested',
        from: row.source_sha,
        testedOrigin: row.origin_sha,
        reason: row.basis_reason,
        pending: row.pending_until !== null && row.voided_at === null,
        voided: row.voided_at !== null,
      },
    ]),
  );
}

/** The latest QA row per task, for tasks whose project has an enabled QA column. */
export async function latestQaSubmissions(
  db: Db,
  tasks: readonly Pick<Row<'task'>, 'id' | 'project'>[],
  config: Pick<Config, 'projects'>,
): Promise<Map<number, SubmissionView>> {
  const withQa = new Set(
    config.projects
      .filter((project) => project.columns.some((column) => column.id === 'qa' && column.enabled))
      .map((project) => project.id),
  );
  return latestSubmissions(
    db,
    tasks.filter((task) => withQa.has(task.project)),
    'qa',
  );
}
