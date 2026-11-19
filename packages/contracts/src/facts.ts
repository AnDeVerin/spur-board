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
/** An http or https web URL. */
export const webUrl = z.url({ protocol: /^https?$/ });
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

/**
 * Link and edit fields a feedback entry and a handed entry share: the direct URL, the newest edit
 * and a review's inline comments.
 */
export const feedbackLinkShape = {
  url: webUrl
    .optional()
    .describe(
      'Web URL of the comment or review; missing in snapshots and handed entries written before it.',
    ),
  editedAt: at
    .optional()
    .describe(
      'When it was last edited; for a review the newest edit of its body or its inline comments. Missing when never edited or not yet read.',
    ),
  comments: z
    .array(
      z.strictObject({
        id: z.string().min(1).describe('Stable id of the inline review comment in the source.'),
        url: webUrl
          .optional()
          .describe(
            'Web URL that opens the inline comment, a thread reply included, in its thread.',
          ),
        threadId: z
          .string()
          .min(1)
          .optional()
          .describe('Id of the review thread the inline comment belongs to.'),
        editedAt: at
          .optional()
          .describe('When the inline comment was last edited; missing when never edited.'),
      }),
    )
    .optional()
    .describe(
      "A review's inline comments, thread replies included, oldest first within each thread; missing for a comment and a review without inline comments.",
    ),
};

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
  statusComment: z
    .literal(true)
    .optional()
    .describe(
      'True for a status comment of a reviewer service, marked by its last line; it is not external feedback. Missing otherwise.',
    ),
  ...feedbackLinkShape,
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
          id: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Node ID of the review thread; missing in facts stored by an earlier version.',
            ),
          url: webUrl
            .optional()
            .describe(
              "Web URL of the thread's first comment; missing in facts stored by an earlier version.",
            ),
          outdated: z
            .boolean()
            .optional()
            .describe(
              'Whether the thread is on a diff line the head no longer has; missing in facts stored by an earlier version.',
            ),
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
    mergedAt: at
      .optional()
      .describe(
        'When the pull request merged; absent while it is not merged and in facts stored by an earlier version.',
      ),
    closedAt: at
      .optional()
      .describe(
        'When the pull request closed without merge; absent while it is not closed and in facts stored by an earlier version.',
      ),
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

/** GitHub's review verdict on a pull request, as its review rule reads it. */
export const REVIEW_DECISIONS = ['approved', 'changes_requested', 'review_required'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
/** Where a base branch's review rule comes from. */
export const REVIEW_RULE_SOURCES = ['branch-protection', 'ruleset'] as const;
export type ReviewRuleSource = (typeof REVIEW_RULE_SOURCES)[number];

/** One base branch's review rule, merged over its branch protection and rulesets. */
export const reviewRuleSchema = z
  .strictObject({
    sources: z
      .array(z.enum(REVIEW_RULE_SOURCES))
      .describe('Where the rule was read: branch protection, rulesets, both or neither.'),
    approvals: z
      .int()
      .min(0)
      .nullable()
      .describe('The largest required approval count of any source; null when none sets one.'),
    codeOwners: z.boolean().describe('Whether any source requires a code owner review.'),
    conversationResolution: z
      .boolean()
      .describe('Whether any source requires every review conversation resolved.'),
    requiredChecks: z
      .array(z.string().min(1))
      .describe('Check names any source requires, once each.'),
  })
  .describe("The base branch's review rule.");
export type ReviewRule = z.output<typeof reviewRuleSchema>;

/**
 * What a full read of a pull request says about the review rule of its base branch. It travels
 * beside the PR facts, never inside them, and only for a project that follows the rule.
 */
export const prReviewRuleSchema = z
  .strictObject({
    reviewDecision: z
      .enum(REVIEW_DECISIONS)
      .nullable()
      .describe("GitHub's review verdict on the head; null when GitHub gives none or a new one."),
    rule: reviewRuleSchema,
  })
  .describe("The pull request's review verdict and its base branch's review rule.");
export type PrReviewRule = z.output<typeof prReviewRuleSchema>;

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

const queuedRingSchema = z
  .strictObject({
    notification: z.int().positive().describe('Board notification the queued ring belongs to.'),
    ring: z.int().positive().describe('Ring number within that notification series.'),
  })
  .describe('One board ring waiting in the session queue.');

/** The marker that ends a board ring text: `(N<notification>-<ring>)`. */
export function ringMarker(notification: number, ring: number): string {
  return `(N${String(notification)}-${String(ring)})`;
}

/** The notification and ring a text ends with, or null when it ends with no valid marker. */
export function parseRingMarker(text: string): { notification: number; ring: number } | null {
  const match = /\(N([1-9]\d*)-([1-9]\d*)\)$/.exec(text);
  if (!match) return null;
  const parsed = queuedRingSchema.safeParse({
    notification: Number(match[1]),
    ring: Number(match[2]),
  });
  return parsed.success ? parsed.data : null;
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
    rateLimitResetAt: at
      .optional()
      .describe('Known reset time while the session is rate limited; omitted otherwise.'),
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
    queuedRings: z
      .array(queuedRingSchema)
      .min(1)
      .optional()
      .describe(
        'Board rings still waiting in the session queue, undelivered. Only board rings are listed, never other queued text; absent when none.',
      ),
  })
  .superRefine((session, ctx) => {
    if (session.rateLimitResetAt !== undefined && session.health !== 'rate_limited') {
      ctx.addIssue({
        code: 'custom',
        path: ['rateLimitResetAt'],
        message: 'Reset time requires rate_limited health',
      });
    }
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
