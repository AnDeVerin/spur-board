// The state of a fake GitHub pull request and the `stand fake github pr` verbs that change it.
import { z } from 'zod';

const SHA = /^[0-9a-f]{40,64}$/;

const actorSchema = z.strictObject({ login: z.string().min(1) }).nullable();
// Comment and review authors also name their type, as GitHub's Actor union does.
const typedActorSchema = z
  .strictObject({ __typename: z.string().min(1), login: z.string().min(1) })
  .nullable();
// A comment's text; only the reviewer status marker on its last line matters to the board.
const commentBody = { body: z.string().default('Stand comment.') };
// When a comment, review or inline comment was last edited; null when never.
const lastEditedAt = { lastEditedAt: z.iso.datetime().nullable().default(null) };
const contextSchema = z.discriminatedUnion('__typename', [
  z.strictObject({
    __typename: z.literal('CheckRun'),
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    checkSuite: z
      .strictObject({
        createdAt: z.string(),
        // The Actions workflow or the app that ran the check; GitHub sends null when absent.
        workflowRun: z
          .strictObject({
            event: z.string().min(1),
            workflow: z.strictObject({ id: z.string().min(1) }),
          })
          .nullable()
          .default(null),
        app: z
          .strictObject({ id: z.string().min(1) })
          .nullable()
          .default(null),
      })
      .nullable(),
    isRequired: z.boolean(),
  }),
  z.strictObject({
    __typename: z.literal('StatusContext'),
    context: z.string().min(1),
    state: z.string(),
    createdAt: z.string(),
    isRequired: z.boolean(),
  }),
]);
const reviewerSchema = z.discriminatedUnion('__typename', [
  z.strictObject({ __typename: z.literal('User'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Mannequin'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Bot'), login: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('Team'), slug: z.string().min(1) }),
  z.strictObject({ __typename: z.literal('EnterpriseTeam'), slug: z.string().min(1) }),
]);
const fieldsSchema = z.strictObject({
  title: z.string(),
  updatedAt: z.iso.datetime(),
  mergedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: actorSchema,
  headRefName: z.string().min(1),
  // The base branch; `main` unless seeded.
  baseRefName: z.string().min(1).optional(),
  headRefOid: z.string().regex(SHA),
  contexts: z.array(contextSchema),
  // The head commit's check suites, answered under `statusCheckRollup.commit`; none unless
  // seeded, and no verb changes them.
  checkSuites: z.array(
    z.strictObject({
      status: z.string(),
      createdAt: z.iso.datetime(),
      workflowRun: z
        .strictObject({
          event: z.string().min(1),
          workflow: z.strictObject({ id: z.string().min(1) }),
        })
        .nullable()
        .default(null),
    }),
  ),
  reviews: z.array(
    z.strictObject({
      author: typedActorSchema,
      state: z.string(),
      commit: z.strictObject({ oid: z.string() }).nullable(),
      submittedAt: z.string().nullable(),
      ...lastEditedAt,
    }),
  ),
  comments: z.array(
    z.strictObject({
      author: typedActorSchema,
      createdAt: z.iso.datetime(),
      ...commentBody,
      ...lastEditedAt,
    }),
  ),
  // Each inline comment names its review by index in `reviews`; null for a pending review.
  reviewThreads: z.array(
    z.strictObject({
      isResolved: z.boolean(),
      isOutdated: z.boolean().default(false),
      comments: z
        .array(z.strictObject({ review: z.int().nonnegative().nullable(), ...lastEditedAt }))
        .default([]),
    }),
  ),
  reviewRequests: z.array(
    z.strictObject({ requestedReviewer: reviewerSchema.nullable(), asCodeOwner: z.boolean() }),
  ),
  closingIssuesReferences: z
    .array(
      z
        .strictObject({
          number: z.int().positive(),
          repository: z.strictObject({ nameWithOwner: z.string() }).nullable(),
        })
        .nullable(),
    )
    .nullable(),
  // The PR's commits, oldest first, the last one at `headRefOid`. Each names the top-level
  // entries it changes against its first parent, `name/` for a directory; a parent not listed
  // is base history. `create` defaults to one commit at the head.
  commits: z.array(
    z.strictObject({
      oid: z.string().regex(SHA),
      parents: z.array(z.string().regex(SHA)),
      changed: z.array(z.string().regex(/^[^/\s]+\/?$/)).default([]),
    }),
  ),
});
/** What `create` accepts; each field replaces its default. An empty `contexts` means no rollup. */
const seedSchema = fieldsSchema.partial();
export type Seed = z.output<typeof seedSchema>;
export type Pr = z.output<typeof fieldsSchema> & { repo: string; number: number };

const target = {
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.int().positive(),
};
// An omitted author is `stand-bot` for a bot and `stand-reviewer` otherwise, so a bot entry never
// shares the reviewer's login: the dispatcher drops every approval of a login with bot feedback.
const feedbackAuthor = { author: z.string().min(1).optional(), bot: z.boolean().default(false) };
export const prControlSchema = z.discriminatedUnion('verb', [
  z.strictObject({ ...target, verb: z.literal('create'), seed: seedSchema.default({}) }),
  z.strictObject({ ...target, verb: z.literal('approve') }),
  z.strictObject({ ...target, verb: z.literal('ci-red') }),
  z.strictObject({ ...target, verb: z.literal('ci-green') }),
  z.strictObject({ ...target, verb: z.literal('merge') }),
  z.strictObject({ ...target, verb: z.literal('close') }),
  z.strictObject({ ...target, verb: z.literal('reopen') }),
  z.strictObject({ ...target, verb: z.literal('conflict') }),
  z.strictObject({ ...target, verb: z.literal('push'), sha: z.string().regex(SHA) }),
  z.strictObject({ ...target, verb: z.literal('comment'), ...feedbackAuthor, ...commentBody }),
  // Edits the comment at `index` (0 is the oldest) at the stand clock; the PR's updatedAt stays.
  z.strictObject({
    ...target,
    verb: z.literal('edit'),
    index: z.int().nonnegative(),
    body: z.string().optional(),
  }),
  z.strictObject({
    ...target,
    verb: z.literal('review'),
    ...feedbackAuthor,
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']),
    // Unresolved review threads the review opens on the head, as inline notes do.
    threads: z.int().min(0).default(0),
  }),
  // Resolves the thread with this id, or every thread when omitted.
  z.strictObject({ ...target, verb: z.literal('resolve'), thread: z.string().min(1).optional() }),
]);
// Sets a new head on the repository's default branch: one push-triggered run `check` that
// failed (red) or passed (green), plus a failed scheduled run `scheduledFailure` when given.
export const branchControlSchema = z.strictObject({
  repo: target.repo,
  state: z.enum(['red', 'green']),
  check: z.string().min(1).default('build'),
  scheduledFailure: z.string().min(1).optional(),
});
export const PR_VERBS = new Set<string>(
  prControlSchema.options.map((option) => option.shape.verb.value),
);
export type Verb = Exclude<z.output<typeof prControlSchema>, { verb: 'create' }>;
