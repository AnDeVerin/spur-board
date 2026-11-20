// The turn shapes operations return: the handed feedback, the return that opened a Dev visit, the
// turn as its executor reads it, as `task.get` lists it and as a `status.get` row shows it.
import { z } from 'zod';
import { ADDRESSEE_ROLES, COLUMN_IDS, SUBMISSION_BASES, TURN_OUTCOMES } from '../enums.ts';
import {
  APPROVAL_NOT_COUNTED,
  FEEDBACK_KINDS,
  prFactsSchema,
  commitShaSchema,
  feedbackLinkShape,
  prRefSchema,
} from '../facts.ts';
import { actorIdSchema, blockIdSchema, taskKeySchema, turnIdSchema } from '../ids.ts';

/** One pull request comment or review a turn handed to its executor. */
export const turnHandedSchema = z
  .strictObject({
    ...prRefSchema.shape,
    kind: z.enum(FEEDBACK_KINDS).describe('Whether this is a comment or a submitted review.'),
    id: z.string().min(1).describe('Stable id of the comment or review in the source.'),
    postedAt: z.iso
      .datetime()
      .describe('When the comment was posted or the review submitted, ISO 8601 UTC.'),
    ...feedbackLinkShape,
  })
  .describe('Pull request feedback a turn handed; an edit after the hand hands it again.');

/** The return that opened the Dev visit a turn belongs to. */
const turnReturnSchema = z
  .strictObject({
    by: actorIdSchema.describe('Who returned the task to Dev.'),
    from: z.enum(COLUMN_IDS).describe('Column the task was returned from.'),
    turn: turnIdSchema.describe('The turn the return closed.'),
    block: blockIdSchema.describe('The code block the return opened.'),
    reason: z.string().describe('Reason of the return, verbatim from its code block.'),
  })
  .describe('The return that sent the task back to Dev and opened this visit.');

export const turnViewSchema = z
  .strictObject({
    id: turnIdSchema,
    task: taskKeySchema,
    column: z.enum(COLUMN_IDS).describe('Board column the turn belongs to.'),
    addressee: z.enum(ADDRESSEE_ROLES).describe('Who executes the turn.'),
    reason: z.string().describe('Why the turn was handed to the executor.'),
    handed: z.array(turnHandedSchema).describe('Pull request feedback handed over with the turn.'),
    returned: turnReturnSchema
      .optional()
      .describe(
        'The return that opened this Dev visit: who returned it, from which column, the closed turn, the code block and its reason. Missing when the visit did not start with a return.',
      ),
    head: commitShaSchema
      .nullable()
      .describe(
        "Head commit of the task's pull request when the turn was opened; null when the task had no pull request.",
      ),
    at: z.iso.datetime().describe('When the turn was opened, ISO 8601 UTC.'),
    taken: z
      .strictObject({
        by: actorIdSchema,
        at: z.iso.datetime().describe('When the turn was taken, ISO 8601 UTC.'),
      })
      .nullable()
      .describe('Who took the turn and when; null until it is taken.'),
    threads: z
      .array(
        z
          .strictObject({
            id: z.string().min(1).describe('Node ID of the review thread.'),
            url: z.url({ protocol: /^https?$/ }).describe("Web URL of the thread's first comment."),
            outdated: z
              .boolean()
              .describe('Whether the thread is on a diff line the head no longer has.'),
          })
          .describe('One unresolved review thread.'),
      )
      .min(1)
      .optional()
      .describe(
        "The unresolved review threads on the task's open pull request, read live, in a Dev turn of a project requiring resolved threads; absent when none, or when the pull request is closed, merged or missing. Fix or answer each thread, then resolve it.",
      ),
  })
  .describe('A turn: the executor of a column is asked to act on a task.');

/** A turn as `task.get` shows it: who executes it, whether it was taken, and how it closed. */
export const taskTurnSchema = turnViewSchema
  .pick({
    id: true,
    column: true,
    addressee: true,
    at: true,
    taken: true,
    handed: true,
    returned: true,
  })
  .extend({
    closed: z
      .strictObject({
        at: z.iso.datetime().describe('When the turn closed, ISO 8601 UTC.'),
        outcome: z
          .enum(TURN_OUTCOMES)
          .describe(
            'How the turn closed; turns closed by a return or a mode switch before those were recorded read moved.',
          ),
      })
      .nullable()
      .describe('How and when the turn closed; null while it is open.'),
  })
  .describe("A task's turn: the executor of a column is asked to act on it.");

const omittedTurnDetail =
  'Always omitted by status.get, even with detail=true; use task.get --why or inbox.get for details.';

/** A turn as a `status.get` row shows it: no feedback, return context or threads. */
export const statusTurnSchema = turnViewSchema
  .omit({ handed: true })
  .extend({
    returned: turnViewSchema.shape.returned.describe(omittedTurnDetail),
    threads: turnViewSchema.shape.threads.describe(omittedTurnDetail),
    addressedTo: z
      .string()
      .nullable()
      .describe(
        'Newest assigned recipient session of an untaken turn; null when taken or unassigned.',
      ),
    stalledSince: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the executor stall on this turn began, ISO 8601 UTC, while its stall block is open; null otherwise.',
      ),
  })
  .describe('Unclosed turn without feedback, return context or thread details.');

/** The return a `status.get` task row shows while the task stays in Dev after it. */
export const statusReturnedSchema = z.strictObject({
  from: z.enum(COLUMN_IDS).describe('Column the task was returned from.'),
  at: z.iso.datetime().describe('When the task was returned, ISO 8601 UTC.'),
  by: actorIdSchema.describe('Who returned the task to Dev.'),
  block: blockIdSchema.describe('The code block the return opened.'),
  findings: z
    .int()
    .min(0)
    .nullable()
    .describe('Number of review findings the return sent; null when not given.'),
});

const submissionViewSchema = z
  .strictObject({
    column: z.enum(COLUMN_IDS).describe('Column submitted from.'),
    sha: commitShaSchema.describe('Full submitted commit SHA.'),
    at: z.iso.datetime().describe('Submission time, ISO 8601 UTC.'),
    basis: z
      .enum(SUBMISSION_BASES)
      .describe('Declared testing provenance; tested does not claim tests passed.'),
    from: commitShaSchema
      .nullable()
      .describe('Supplied source SHA for carried work, otherwise null.'),
    testedOrigin: commitShaSchema
      .nullable()
      .describe('Original tested submission SHA for carried work, otherwise null.'),
    reason: z
      .string()
      .max(2000)
      .nullable()
      .describe('Literal explanation supplied by the submitter.'),
    pending: z.boolean().describe('Whether head confirmation is pending.'),
    voided: z.boolean().describe('Whether this submission has been voided for gate purposes.'),
  })
  .describe('Latest accepted submission by row order, including pending and voided submissions.');
export type SubmissionView = z.output<typeof submissionViewSchema>;
export const columnPositionSchema = z
  .int()
  .min(1)
  .optional()
  .describe('1-based place in the column order; new arrivals go last; absent on older servers.');
export const latestSubmissionSchema = submissionViewSchema
  .nullable()
  .optional()
  .describe('Latest submission; null when none, absent on older servers.');

const summaryCount = (what: string) => z.int().min(0).describe(what);

const topLevelEntries = (what: string) =>
  z
    .array(z.string().describe('A top-level entry: name/ for a directory, a bare name for a file.'))
    .optional()
    .describe(what);

/** One latest approval of an open pull request and what changed after it. */
export const approvalViewSchema = z
  .strictObject({
    author: prFactsSchema.shape.reviews.element.shape.reviewer,
    sha: commitShaSchema.describe('Commit the approval was given on.'),
    onHead: z.boolean().describe('Whether the approval was given on the current head.'),
    commitsAfter: summaryCount(
      'Single-parent commits after the approval up to the head; merges, base-branch merges included, are left out. Absent when not counted or not read yet.',
    ).optional(),
    changedAfter: topLevelEntries(
      'Every top-level entry those commits changed, sorted. Absent when not counted or not read yet.',
    ),
    watchedAfter: topLevelEntries(
      "The part of changedAfter that matches the project's approvalWatch; all of changedAfter without the key. Absent when not counted or not read yet.",
    ),
    notCounted: z
      .enum(APPROVAL_NOT_COUNTED)
      .optional()
      .describe(
        'Why the commits were not counted: history_rewritten (the approved commit is not in the head history), rate_limit (waiting for GitHub budget) or pr_too_large (more than 100 commits). Absent when counted or not read yet.',
      ),
  })
  .describe(
    'A latest approval. commitsAfter, changedAfter and watchedAfter come together; notCounted replaces them; none of them means not read yet. A hint, never a gate.',
  );

export const prSummarySchema = z
  .strictObject({
    repo: prFactsSchema.shape.repo,
    number: prFactsSchema.shape.number,
    checks: z
      .strictObject({
        pass: summaryCount('Successful or neutral checks.'),
        fail: summaryCount('Failed checks, including skipped.'),
        pending: summaryCount('Expected or pending checks.'),
      })
      .describe(
        'Required checks when nonempty, otherwise all reported checks; a factual rollup, not a gate verdict.',
      ),
    mergeable: prFactsSchema.shape.mergeable,
    threads: z
      .strictObject({
        unresolved: summaryCount('Unresolved review threads.'),
        total: summaryCount('All review threads.'),
      })
      .describe('Review thread counts.'),
    reviewsOnHead: z
      .strictObject({
        approved: z.array(z.string()).describe('Reviewers approving the current head.'),
        changesRequested: z
          .array(z.string())
          .describe('Reviewers requesting changes on the current head.'),
      })
      .describe('Latest recorded reviews on the current head, without gate filtering.'),
    draft: prFactsSchema.shape.draft,
    factAt: z.iso.datetime().describe('Snapshot observation time, ISO 8601 UTC.'),
    unconfirmed: z
      .boolean()
      .describe('Observation is stale or its supporting source is blind or missing.'),
    approvals: z
      .array(approvalViewSchema)
      .optional()
      .describe(
        'Latest approvals in review order with what changed after each; present only for an open pull request with at least one approval.',
      ),
  })
  .describe('Compact observed pull request facts.');
