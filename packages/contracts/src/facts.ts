// The facts catalog: what adapters report about PRs, tickets and sessions. Facts are named
// values, not decisions; core decides what they mean. No wire format of any source appears here.
import { z } from 'zod';
import { repoSlugSchema } from './config.ts';
import { SESSION_END_REASONS } from './enums.ts';
import { actorPartSchema, taskKeySchema } from './ids.ts';

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export type PrState = (typeof PR_STATES)[number];

export const MERGEABLE_STATES = ['mergeable', 'conflicting', 'unknown'] as const;
export type MergeableState = (typeof MERGEABLE_STATES)[number];

export const MERGE_STATES = [
  'behind',
  'blocked',
  'clean',
  'dirty',
  'draft',
  'has_hooks',
  'unknown',
  'unstable',
] as const;
export type MergeState = (typeof MERGE_STATES)[number];

export const CHECK_STATES = [
  'expected',
  'pending',
  'success',
  'neutral',
  'skipped',
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const REVIEW_STATES = ['approved', 'changes_requested', 'commented', 'dismissed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const REVIEWER_KINDS = ['user', 'team', 'bot'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];
export const FEEDBACK_KINDS = ['comment', 'review'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const AUTHOR_TYPES = ['user', 'bot'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

/** Spur session lifecycle values known today. */
export const SESSION_STATUSES = [
  'spawning',
  'running',
  'stopped',
  'paused',
  'errored',
  'completed',
  'killed',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Spur session health values known today. */
export const SESSION_HEALTH_STATES = [
  'working',
  'waiting',
  'needs_input',
  'stopped',
  'error',
  'killed',
  'rate_limited',
  'stale',
] as const;
export type SessionHealthState = (typeof SESSION_HEALTH_STATES)[number];

/** UTC ISO 8601 timestamp. */
const at = z.iso.datetime();
const webUrl = z.url({ protocol: /^https?$/ });
const login = z.string().min(1);
/** A full lowercase commit SHA (SHA-1 or SHA-256). */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/, 'Expected a full commit SHA');

/** A pull request by repository and number. */
export const prRefSchema = z.strictObject({
  repo: repoSlugSchema.describe('Repository as owner/name.'),
  number: z.int().min(1).describe('Pull request number in the repository.'),
});
export type PrRef = z.output<typeof prRefSchema>;

const checkSchema = z.strictObject({
  name: z.string().min(1).describe('Check or status context name.'),
  state: z.enum(CHECK_STATES).describe('State of the latest run of this check on the head commit.'),
  completedAt: at.nullable().describe('When the latest run finished; null while it runs.'),
});

const feedbackSchema = z.strictObject({
  kind: z.enum(FEEDBACK_KINDS).describe('Whether this is a comment or a submitted review.'),
  id: z.string().min(1).describe('Stable id of the comment or review in the source.'),
  author: z
    .strictObject({
      login: login.describe('Login of the author.'),
      type: z.enum(AUTHOR_TYPES).describe('Whether the author is a user or a bot.'),
    })
    .nullable()
    .describe('Who posted it; null for a deleted account.'),
  postedAt: at.describe('When the comment was posted or the review submitted.'),
  state: z
    .enum(REVIEW_STATES)
    .optional()
    .describe('State of this review; missing for a comment and in snapshots written before it.'),
});
export type PrFeedback = z.output<typeof feedbackSchema>;

export const prFactsSchema = z
  .strictObject({
    repo: repoSlugSchema.describe('Repository as owner/name.'),
    number: z.int().min(1).describe('Pull request number in the repository.'),
    url: webUrl.describe('Web URL of the pull request.'),
    title: z.string().describe('Pull request title.'),
    author: login.describe('Login of the pull request author.'),
    headSha: commitShaSchema.describe('Commit SHA of the head of the pull request.'),
    headBranch: z.string().min(1).describe('Branch name of the head of the pull request.'),
    state: z.enum(PR_STATES).describe('Whether the pull request is open, closed or merged.'),
    draft: z.boolean().describe('Whether the pull request is a draft.'),
    mergeable: z
      .enum(MERGEABLE_STATES)
      .describe('Whether the head merges into the base without conflicts.'),
    mergeState: z
      .enum(MERGE_STATES)
      .describe('Merge state as the source reports it; any value not listed is unknown.'),
    requiredChecks: z
      .array(checkSchema)
      .describe('Required checks on the head commit, the latest run of each.'),
    checks: z
      .array(checkSchema)
      .describe(
        'All check contexts on the head commit, the latest run of each; the fallback for branches without required checks.',
      ),
    reviews: z
      .array(
        z.strictObject({
          reviewer: login.describe('Login of the reviewer.'),
          state: z.enum(REVIEW_STATES).describe('State of the latest review by this reviewer.'),
          commitSha: commitShaSchema.describe('Commit the review was given on.'),
          submittedAt: at.describe('When the review was submitted.'),
        }),
      )
      .describe('The latest review of each reviewer, with the commit it was given on.'),
    reviewThreads: z
      .array(
        z.strictObject({
          resolved: z.boolean().describe('Whether the review thread is resolved.'),
        }),
      )
      .describe('Review threads on the pull request.'),
    reviewRequests: z
      .array(
        z
          .strictObject({
            kind: z.enum(REVIEWER_KINDS).optional().describe('Kind of reviewer asked to review.'),
            id: z
              .string()
              .min(1)
              .optional()
              .describe('Login of the user or bot, or the slug of the team.'),
            reviewer: z
              .string()
              .min(1)
              .optional()
              .describe(
                'Login or team name as stored by an earlier version; new facts use kind and id.',
              ),
            asCodeOwner: z
              .boolean()
              .describe('Whether the review was requested because the reviewer owns changed code.'),
          })
          .superRefine((request, ctx) => {
            const named =
              request.reviewer === undefined
                ? request.kind !== undefined && request.id !== undefined
                : request.kind === undefined && request.id === undefined;
            if (!named)
              ctx.addIssue({ code: 'custom', message: 'Set kind and id, or reviewer alone' });
          }),
      )
      .describe('Pending review requests.'),
    ticketKeys: z
      .array(taskKeySchema)
      .describe('Ticket keys found in the head branch name and the title.'),
    updatedAt: at.describe('When the pull request last changed.'),
    feedback: z
      .array(feedbackSchema)
      .optional()
      .describe(
        'Comments and submitted reviews on the pull request, oldest first, without their text.',
      ),
    feedbackComplete: z
      .boolean()
      .optional()
      .describe(
        'Whether feedback holds every comment back to the last one handed over, or to the start of the pull request; missing reads as incomplete.',
      ),
  })
  .describe('Facts about one pull request.');
export type PrFacts = z.output<typeof prFactsSchema>;

/**
 * Whether a comment or review came from outside: not by `agentLogin` in any letter case and not
 * by a bot. A deleted account counts as external.
 */
export function isExternalAuthor(entry: Pick<PrFeedback, 'author'>, agentLogin: string): boolean {
  return (
    entry.author === null ||
    (entry.author.type !== 'bot' && entry.author.login.toLowerCase() !== agentLogin.toLowerCase())
  );
}

/** A tracker ticket; tracker-neutral, so a Jira issue and a GitHub issue both fit. */
export const ticketFactsSchema = z
  .strictObject({
    trackerId: z
      .string()
      .min(1)
      .describe('Stable id of the tracker the ticket came from; the same across polls.'),
    id: z
      .string()
      .min(1)
      .describe(
        "The ticket's stable id in its tracker; unlike the key, it stays the same when the ticket moves to another project.",
      ),
    key: taskKeySchema,
    title: z.string().describe('Ticket title.'),
    status: z.string().min(1).describe('Ticket status as the tracker names it.'),
    assignee: z.string().min(1).nullable().describe('Who the ticket is assigned to, or null.'),
    sprint: z.string().min(1).nullable().describe('Current sprint name, or null.'),
    labels: z.array(z.string().min(1)).describe('Ticket labels.'),
    inFilter: z
      .boolean()
      .describe(
        "Whether the ticket matched the project's tracker filter; false when it was fetched only by key.",
      ),
    url: webUrl.describe('Web URL of the ticket.'),
    updatedAt: at.describe('When the ticket last changed.'),
  })
  .describe('Facts about one tracker ticket.');
export type TicketFacts = z.output<typeof ticketFactsSchema>;

/** A Spur health value this version does not know. Kept as is, so the poll does not fail. */
export const unknownSessionHealthSchema = z.string().min(1).brand<'UnknownSessionHealth'>();
export type UnknownSessionHealth = z.output<typeof unknownSessionHealthSchema>;

/** A Spur lifecycle value this version does not know. Kept as is, so the poll does not fail. */
export const unknownSessionStatusSchema = z.string().min(1).brand<'UnknownSessionStatus'>();
export type UnknownSessionStatus = z.output<typeof unknownSessionStatusSchema>;

const knownHealth = z.enum(SESSION_HEALTH_STATES);
const knownStatus = z.enum(SESSION_STATUSES);

/** Whether a session health value is one this version knows. */
export function isKnownSessionHealth(
  value: SessionHealthState | UnknownSessionHealth,
): value is SessionHealthState {
  return knownHealth.safeParse(value).success;
}

/** Whether a session lifecycle value is one this version knows. */
export function isKnownSessionStatus(
  value: SessionStatus | UnknownSessionStatus,
): value is SessionStatus {
  return knownStatus.safeParse(value).success;
}

export const sessionFactsSchema = z
  .strictObject({
    id: actorPartSchema.describe('Spur session name.'),
    spurProject: actorPartSchema.describe('Spur project the session belongs to.'),
    branch: z.string().min(1).nullable().describe('Git branch the session works on, or null.'),
    pr: prRefSchema.nullable().describe('Pull request linked to the session, or null.'),
    links: z.record(z.string().min(1), webUrl).describe('Links the session published, by label.'),
    lifecycle: z
      .union([knownStatus, unknownSessionStatusSchema])
      .describe('Lifecycle status: a known value or an unknown one kept as is.'),
    health: z
      .union([knownHealth, unknownSessionHealthSchema])
      .describe('Health state after smoothing: a known value or an unknown one kept as is.'),
    healthSince: at.describe(
      'When the current health value began to hold, as the adapter observed it; health durations count from here.',
    ),
    lastActivityAt: at.nullable().describe('When the session last showed activity, or null.'),
    endedAt: at
      .nullable()
      .describe(
        'When the session ended, or null while it is live. The adapter supplies it: Spur keeps no end time.',
      ),
    endReason: z
      .enum(SESSION_END_REASONS)
      .nullable()
      .describe('Why the session ended, or null while it is live. Set together with endedAt.'),
  })
  .superRefine((session, ctx) => {
    if ((session.endedAt === null) !== (session.endReason === null)) {
      ctx.addIssue({
        code: 'custom',
        path: [session.endedAt === null ? 'endedAt' : 'endReason'],
        message: 'Set endedAt and endReason together',
      });
    }
  })
  .describe(
    'Facts about one Spur session. End time and reason are set for a session resolved after it left the list. A requested session that answers 404 has no facts: the batch reports it as not_found, counts as resolved, and core records it as vanished at once, outside the gone-after-polls count.',
  );
export type SessionFacts = z.output<typeof sessionFactsSchema>;

/** One schema per fact kind; fact names derive from their shapes. */
export const FACT_SCHEMAS = {
  pr: prFactsSchema,
  ticket: ticketFactsSchema,
  session: sessionFactsSchema,
} as const;
export type FactKind = keyof typeof FACT_SCHEMAS;

/** A fact name: `<kind>.<field>`, e.g. `pr.headSha`. A misspelled name does not compile. */
export type FactName = {
  [K in FactKind]: `${K}.${keyof z.output<(typeof FACT_SCHEMAS)[K]> & string}`;
}[FactKind];

export const FACT_NAMES: readonly FactName[] = [
  ...prFactsSchema.keyof().options.map((field): FactName => `pr.${field}`),
  ...ticketFactsSchema.keyof().options.map((field): FactName => `ticket.${field}`),
  ...sessionFactsSchema.keyof().options.map((field): FactName => `session.${field}`),
];
