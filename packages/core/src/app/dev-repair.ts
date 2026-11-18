import { eventPayloadSchemas, type ActorId, type EventPayload } from '@spur-board/contracts';
import { sql } from 'kysely';
import type { Row } from '../store/schema.ts';
import { emit, taskPr, type Trx } from './board-utils.ts';
import { carriedFeedback, isNewerEdit, sameHanded, withoutStatusComments } from './turns.ts';

type Payload = EventPayload<'dev_repair'>;
type Recognition = Extract<Payload, { action: 'recognized' }>;
type Coverage = Extract<Payload, { action: 'covered' }>;
type Feedback = Recognition['feedback'][number];
type Context = { task: Pick<Row<'task'>, 'id' | 'project'>; at: string; actor?: ActorId };

/** Replayed exclusively from this task's lifecycle rows, ordered by journal identity. */
export async function readDevRepair(trx: Trx, taskId: number) {
  const resets = await trx
    .selectFrom('event')
    .select(['id', 'payload'])
    .where('task_id', '=', taskId)
    .where('kind', '=', 'dev_repair')
    .where(
      sql<boolean>`json_extract(case when json_valid(payload) then payload else '{}' end, '$.action') = 'reset'`,
    )
    .orderBy('id', 'desc')
    .execute();
  const reset = resets.find(
    (row) => eventPayloadSchemas.dev_repair.safeParse(JSON.parse(row.payload)).success,
  );
  const rows = await trx
    .selectFrom('event')
    .select(['id', 'payload'])
    .where('task_id', '=', taskId)
    .where('kind', '=', 'dev_repair')
    .where('id', '>=', reset?.id ?? 0)
    .orderBy('id')
    .execute();
  const outstanding = new Map<number, Recognition>();
  const adoptions = new Map<string, number[]>();
  const coverage = new Map<number, Coverage>();
  const failed = new Map<number, string>();
  const representedTurns = new Set<string>();
  let throughTurn = 0;
  let throughSubmission = 0;
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const parsed = eventPayloadSchemas.dev_repair.safeParse(raw);
    if (!parsed.success) continue;
    const p = parsed.data;
    switch (p.action) {
      case 'reset':
        outstanding.clear();
        adoptions.clear();
        coverage.clear();
        failed.clear();
        representedTurns.clear();
        throughTurn = p.throughTurn;
        throughSubmission = p.throughSubmission;
        break;
      case 'recognized':
        outstanding.set(row.id, p);
        if (p.legacyTurn !== undefined) representedTurns.add(p.legacyTurn);
        break;
      case 'adopted':
        adoptions.set(p.turn, p.recognitions);
        representedTurns.add(p.turn);
        break;
      case 'covered':
        coverage.set(p.submission, p);
        representedTurns.add(p.turn);
        break;
      case 'completed':
        if (!failed.has(p.submission))
          for (const id of p.recognitions)
            if (coverage.get(p.submission)?.recognitions.includes(id)) outstanding.delete(id);
        break;
      case 'failed':
        failed.set(p.submission, p.failure);
        break;
    }
  }
  return {
    outstanding,
    adoptions,
    coverage,
    failed,
    representedTurns,
    throughTurn,
    throughSubmission,
  };
}

const write = (trx: Trx, ctx: Context, payload: Payload) =>
  emit(trx, 'dev_repair', ctx.task.project, ctx.task.id, ctx.at, payload, ctx.actor ?? 'system');
const label = (id: number) => `T${String(id)}`;

/** Existing identity/edit semantics, shared by captured, live and legacy feedback. */
export function mergeRepairFeedback(...groups: readonly (readonly Feedback[])[]): Feedback[] {
  const entries: Feedback[] = [];
  for (const entry of groups.flat()) {
    const index = entries.findIndex((old) => sameHanded(old, entry));
    if (index < 0) entries.push(entry);
    else if (isNewerEdit(entry, entries[index] ?? entry)) entries[index] = entry;
  }
  return entries;
}

/** Capture only new outstanding source revisions; current facts, never history, propose work. */
export async function recognizeDevRepair(trx: Trx, ctx: Context, candidate: Recognition) {
  const state = await readDevRepair(trx, ctx.task.id);
  const previous = [...state.outstanding.values()].filter(
    (p) =>
      p.pr.repo.toLowerCase() === candidate.pr.repo.toLowerCase() &&
      p.pr.number === candidate.pr.number,
  );
  const feedback = candidate.feedback.filter(
    (entry) =>
      !previous.some((p) =>
        p.feedback.some((old) => sameHanded(old, entry) && !isNewerEdit(entry, old)),
      ),
  );
  const threads = candidate.threads.filter(
    (entry) =>
      !previous.some((p) =>
        p.threads.some((old) =>
          entry.id !== undefined && old.id !== undefined
            ? entry.id === old.id
            : entry.url !== undefined && old.url !== undefined
              ? entry.url === old.url
              : old.id === undefined && entry.id === undefined,
        ),
      ),
  );
  const aggregate =
    candidate.reasons.includes('unresolved_threads') &&
    candidate.threads.length === 0 &&
    !previous.some((p) => p.reasons.includes('unresolved_threads'));
  const reasons = candidate.reasons.filter((reason) =>
    reason === 'external_comments' ? feedback.length > 0 : threads.length > 0 || aggregate,
  );
  if (reasons.length === 0) return;
  await write(trx, ctx, { ...candidate, reasons, feedback, threads });
}

/** One explicit handover binds the recognition revision set; later work gets another turn. */
export async function adoptDevRepair(trx: Trx, ctx: Context, turn: number) {
  const state = await readDevRepair(trx, ctx.task.id);
  if (state.adoptions.has(label(turn)) || state.outstanding.size === 0) return;
  await write(trx, ctx, {
    action: 'adopted',
    turn: label(turn),
    recognitions: [...state.outstanding.keys()],
  });
}

/** Acceptance binds actual receipt identity, independently of mutable validity and timestamps. */
export async function coverDevRepair(
  trx: Trx,
  ctx: Context,
  turn: number,
  submission: number,
  confirmed: boolean,
) {
  const state = await readDevRepair(trx, ctx.task.id);
  const recognitions = (state.adoptions.get(label(turn)) ?? []).filter((id) =>
    state.outstanding.has(id),
  );
  if (recognitions.length === 0) return;
  await write(trx, ctx, { action: 'covered', submission, turn: label(turn), recognitions });
  if (confirmed) await completeDevRepair(trx, ctx, submission);
}

export async function completeDevRepair(trx: Trx, ctx: Context, submission: number) {
  const state = await readDevRepair(trx, ctx.task.id);
  if (state.failed.has(submission)) return;
  const recognitions = (state.coverage.get(submission)?.recognitions ?? []).filter((id) =>
    state.outstanding.has(id),
  );
  if (recognitions.length > 0)
    await write(trx, ctx, { action: 'completed', submission, recognitions });
}

export async function failDevRepair(trx: Trx, ctx: Context, submission: number, failure: string) {
  const state = await readDevRepair(trx, ctx.task.id);
  if (state.coverage.has(submission) && !state.failed.has(submission))
    await write(trx, ctx, { action: 'failed', submission, failure });
}

export async function resetDevRepair(
  trx: Trx,
  ctx: Context,
  reason: Extract<Payload, { action: 'reset' }>['reason'],
  sourceEvent: number,
) {
  const turn = await trx
    .selectFrom('turn')
    .select((eb) => eb.fn.max<number | null>('id').as('id'))
    .where('task_id', '=', ctx.task.id)
    .executeTakeFirstOrThrow();
  const submission = await trx
    .selectFrom('submission')
    .select((eb) => eb.fn.max<number | null>('id').as('id'))
    .where('task_id', '=', ctx.task.id)
    .executeTakeFirstOrThrow();
  await write(trx, ctx, {
    action: 'reset',
    reason,
    sourceEvent,
    throughTurn: turn.id ?? 0,
    throughSubmission: submission.id ?? 0,
  });
}

/** Upgrade imports exact known legacy evidence only, never earlier PR snapshots/configuration. */
export async function importLegacyDevRepair(
  trx: Trx,
  ctx: Context,
  turn: Row<'turn'> | undefined,
  submission?: number,
) {
  if (turn?.column !== 'dev') return;
  const state = await readDevRepair(trx, ctx.task.id);
  if (turn.id <= state.throughTurn || state.representedTurns.has(label(turn.id))) return;
  const feedback = await carriedFeedback(trx, turn);
  const thread = turn.reason.includes('unresolved_threads');
  if (feedback.length === 0 && !thread) return;
  const pr = await taskPr(trx, ctx.task.id);
  if (pr === null) return;
  const snapshot = await trx
    .selectFrom('pr_snapshot')
    .select('head_sha')
    .where('repo', '=', pr.repo)
    .where('number', '=', pr.number)
    .executeTakeFirst();
  const headSha = turn.head_sha ?? snapshot?.head_sha;
  if (headSha === undefined) return;
  const id = await write(trx, ctx, {
    action: 'recognized',
    origin: { column: 'dev', epoch: turn.epoch },
    pr: { repo: pr.repo, number: pr.number, headSha },
    reasons: [
      ...(feedback.length > 0 ? ['external_comments' as const] : []),
      ...(thread ? ['unresolved_threads' as const] : []),
    ],
    feedback,
    threads: [],
    legacyTurn: label(turn.id),
  });
  await write(trx, ctx, { action: 'adopted', turn: label(turn.id), recognitions: [id] });
  if (submission !== undefined && submission > state.throughSubmission)
    await write(trx, ctx, {
      action: 'covered',
      submission,
      turn: label(turn.id),
      recognitions: [id],
      legacy: true,
    });
}

export async function devRepairContext(trx: Trx, taskId: number) {
  const state = await readDevRepair(trx, taskId);
  const entries = [...state.outstanding.values()];
  return {
    feedback: await withoutStatusComments(
      trx,
      mergeRepairFeedback(...entries.map((p) => p.feedback)),
    ),
    thread: entries.some((p) => p.reasons.includes('unresolved_threads')),
    threads: [...new Set(entries.flatMap((p) => p.threads.flatMap((t) => t.url ?? t.id ?? [])))],
  };
}
