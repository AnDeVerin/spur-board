// The adapter port: one poll method per source. `Batch` is what an adapter hands back to core
// and is validated at runtime; `Adapter` and `PollContext` are built by core and are not.
import { z } from 'zod';
import { readyMirrorOf, type Config } from './config.ts';
import type { Result } from './errors.ts';
import {
  commitShaSchema,
  prApprovalPairSchema,
  prFactsSchema,
  prRefSchema,
  prReviewRuleSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  type PrFacts,
  type PrFeedback,
  webUrl,
} from './facts.ts';
import { actorPartSchema, taskKeySchema } from './ids.ts';

export const ADAPTER_ERROR_KINDS = ['auth', 'config', 'throttled', 'transient'] as const;
export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

/** What the source answered for one requested entity. */
export const ENTITY_STATUSES = ['ok', 'not_found', 'no_access'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

/** Opaque, adapter-issued position in a source. Core stores it and never parses it. */
export const sourceCursorSchema = z.string().min(1).brand<'SourceCursor'>();
export type SourceCursor = z.output<typeof sourceCursorSchema>;

/** An ordered historical edge, separate from current session snapshots. */
export const sessionTransitionSchema = z.strictObject({
  position: sourceCursorSchema.describe('Opaque position of this edge.'),
  session: actorPartSchema.describe('Session identity.'),
  spurProject: actorPartSchema.describe('Source project at event time.'),
  at: z.iso.datetime().describe('When the producer recorded the edge.'),
  links: z.record(z.string().min(1), z.url()).describe('Published links at event time.'),
  dimension: z.enum(['lifecycle', 'health']).describe('Which session fact changed.'),
  from: z.string().min(1).nullable().describe('Previous value, null on first observation.'),
  to: z.string().min(1).describe('Observed value.'),
  rateLimitResetAt: z.iso.datetime().optional().describe('Known rate limit reset at event time.'),
});
export type SessionTransition = z.output<typeof sessionTransitionSchema>;

/** A requested entity: a pull request, a ticket or a session. */
export const entityRefSchema = z.discriminatedUnion('kind', [
  prRefSchema.extend({ kind: z.literal('pr').describe('A pull request.') }),
  z.strictObject({
    kind: z.literal('ticket').describe('A tracker ticket.'),
    trackerId: z.string().min(1).describe('Stable id of the tracker the ticket lives in.'),
    id: z
      .string()
      .min(1)
      .optional()
      .describe('Known stable ticket id; omitted for a pending manual include.'),
    key: taskKeySchema.describe(
      'Ticket key; matches a pending request before its stable id is known.',
    ),
  }),
  z.strictObject({
    kind: z.literal('session').describe('A Spur session.'),
    id: actorPartSchema.describe('Spur session name.'),
  }),
]);
export type EntityRef = z.output<typeof entityRefSchema>;
export type PrEntityRef = Extract<EntityRef, { kind: 'pr' }>;
export type TicketEntityRef = Extract<EntityRef, { kind: 'ticket' }>;
export type SessionEntityRef = Extract<EntityRef, { kind: 'session' }>;

/** The facts of one entity, tagged with their kind. */
export const batchItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pr').describe('Pull request facts.'),
    facts: prFactsSchema,
    continuation: z
      .strictObject({
        resume: sourceCursorSchema
          .nullable()
          .describe('Opaque position to read further back from; null at the start of the PR.'),
      })
      .nullable()
      .optional()
      .describe(
        'Comment history core holds for the next poll (A10): omitted says nothing, null drops it, an object holds facts.feedback with resume.',
      ),
    reviewRule: prReviewRuleSchema
      .optional()
      .describe(
        "GitHub's review verdict and the base branch's review rule from this full read, sent only for a project whose External Review sets approvalRule github-rules; omitted says nothing new.",
      ),
    approvalPairs: z
      .array(prApprovalPairSchema)
      .optional()
      .describe(
        'What changed after each approval not on the head, for a requested open PR; omitted says nothing new. A hint for status views, never a gate input.',
      ),
  }),
  z.strictObject({
    kind: z.literal('ticket').describe('Ticket facts.'),
    facts: ticketFactsSchema,
  }),
  z.strictObject({
    kind: z.literal('session').describe('Session facts.'),
    facts: sessionFactsSchema,
  }),
]);
export type BatchItem = z.output<typeof batchItemSchema>;

/** The identity a requested entity and its item share. */
function refIdentity(ref: EntityRef): string {
  switch (ref.kind) {
    case 'pr':
      return JSON.stringify([ref.kind, ref.repo, ref.number]);
    case 'ticket':
      return JSON.stringify([ref.kind, ref.trackerId, ref.id ?? `key:${ref.key}`]);
    case 'session':
      return JSON.stringify([ref.kind, ref.id]);
  }
}

function itemIdentity(item: BatchItem): string {
  switch (item.kind) {
    case 'pr':
      return refIdentity({ kind: 'pr', repo: item.facts.repo, number: item.facts.number });
    case 'ticket':
      return refIdentity({
        kind: 'ticket',
        trackerId: item.facts.trackerId,
        id: item.facts.id,
        key: item.facts.key,
      });
    case 'session':
      return refIdentity({ kind: 'session', id: item.facts.id });
  }
}

function itemAnswersRef(item: BatchItem, ref: EntityRef): boolean {
  if (item.kind !== ref.kind) return false;
  if (ref.kind === 'ticket' && item.kind === 'ticket') {
    return (
      item.facts.trackerId === ref.trackerId &&
      (ref.id === undefined ? item.facts.key === ref.key : item.facts.id === ref.id)
    );
  }
  return itemIdentity(item) === refIdentity(ref);
}

const defaultBranchCommit = {
  branch: z.string().min(1).describe('Name of the default branch.'),
  sha: commitShaSchema.describe('Newest commit with counted checks in the default-branch read.'),
};

/**
 * The colour of the newest checked commit in the default-branch read. Push workflow checks and
 * commit statuses count; scheduled and other runs, and check runs outside workflows, never do.
 */
export const defaultBranchFactSchema = z
  .discriminatedUnion('state', [
    z.strictObject({
      state: z
        .literal('green')
        .describe('Every counted check finished as success, neutral or skipped.'),
      ...defaultBranchCommit,
    }),
    z.strictObject({
      state: z
        .literal('red')
        .describe(
          'At least one counted check has a completed result other than success, neutral or skipped.',
        ),
      ...defaultBranchCommit,
      check: z.string().min(1).nullable().describe('Name of the first failing check, if known.'),
      url: webUrl.nullable().describe('Web URL of the failing run, or null when unknown.'),
    }),
  ])
  .describe('Colour of the newest checked commit in the default-branch read.');
export type DefaultBranchFact = z.output<typeof defaultBranchFactSchema>;

/** What a complete GitHub Project read says about one issue; no complete read means unknown. */
export const READINESS_STATES = ['ready', 'not_ready'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const batchSchema = z
  .strictObject({
    source: z.string().min(1).describe('Id of the adapter that produced the batch.'),
    observedAt: z.iso.datetime().describe('When the poll started (A2).'),
    complete: z
      .boolean()
      .describe('Whether everything was listed without errors (A3); per-entity outcomes aside.'),
    items: z.array(batchItemSchema).describe('Facts observed in this poll.'),
    sessionTransitions: z
      .array(sessionTransitionSchema)
      .optional()
      .describe(
        'Ordered historical edges; presence makes the feed authoritative for session lifecycle events.',
      ),
    cursor: sourceCursorSchema
      .optional()
      .describe('Where the next poll continues; omitted when the source has none (A5).'),
    entities: z
      .array(
        z.strictObject({
          ref: entityRefSchema.describe('The requested entity.'),
          status: z.enum(ENTITY_STATUSES).describe('What the source answered for it.'),
        }),
      )
      .describe('One entry per entity core asked for (A4).'),
    prProbes: z
      .array(
        z.strictObject({
          ref: prRefSchema
            .extend({ kind: z.literal('pr').describe('A pull request.') })
            .describe('The rechecked PR.'),
          status: z
            .enum(['closed', 'refreshed', 'not_found', 'no_access'])
            .describe('Unchanged closed state, full refresh, or failed lookup.'),
        }),
      )
      .optional()
      .describe('State-only PR rechecks, separate from normal entity coverage.'),
    usage: z
      .strictObject({ points: z.int().nonnegative().describe('Reported points consumed.') })
      .optional()
      .describe('Reported source points consumed by this attempt.'),
    budget: z
      .strictObject({
        remaining: z.int().min(0).describe('Requests or points the source still allows.'),
        limit: z
          .int()
          .positive()
          .optional()
          .describe('Full budget the source restores at reset; omitted when it reports none.'),
        resetAt: z.iso.datetime().describe('When the source restores the full budget.'),
      })
      .optional()
      .describe('Request budget the source reported on this poll; omitted when it reports none.'),
    defaultBranch: defaultBranchFactSchema
      .optional()
      .describe(
        'Colour of the newest checked commit in the default-branch read. Omitted when the poll found no settled colour.',
      ),
    mirror: z
      .strictObject({
        title: z.string().min(1).describe('Title of the GitHub Project read.'),
        readiness: z
          .array(
            z.strictObject({
              key: taskKeySchema.describe('Task key of one open tracker issue.'),
              state: z
                .enum(READINESS_STATES)
                .describe(
                  'ready: the issue has the configured option in the Project; not_ready: it has another, none, or is not in the Project.',
                ),
            }),
          )
          .describe('One entry per open issue of the tracker repository.'),
      })
      .optional()
      .describe(
        'The GitHub Project status read by a github-project source; only on a complete batch.',
      ),
  })
  .superRefine((batch, ctx) => {
    if (batch.mirror !== undefined && !batch.complete)
      ctx.addIssue({
        code: 'custom',
        path: ['mirror'],
        message: 'Only a complete batch carries mirror',
      });
    const readiness = new Set<string>();
    batch.mirror?.readiness.forEach((entry, index) => {
      if (readiness.has(entry.key))
        ctx.addIssue({
          code: 'custom',
          path: ['mirror', 'readiness', index, 'key'],
          message: 'Report each task key once',
        });
      readiness.add(entry.key);
    });
    const positions = new Set<string>();
    batch.sessionTransitions?.forEach((edge, index) => {
      if (positions.has(edge.position))
        ctx.addIssue({
          code: 'custom',
          path: ['sessionTransitions', index, 'position'],
          message: 'Report each transition position once',
        });
      positions.add(edge.position);
    });
    const items = new Set<string>();
    batch.items.forEach((item, index) => {
      const identity = itemIdentity(item);
      if (items.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'Report each entity in one item',
        });
      }
      items.add(identity);
    });
    const requested = new Set<string>();
    batch.entities.forEach((entity, index) => {
      const identity = refIdentity(entity.ref);
      if (requested.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entities', index, 'ref'],
          message: 'List each requested entity once',
        });
        return;
      }
      requested.add(identity);
      if (
        (entity.status === 'ok') !==
        batch.items.some((item) => itemAnswersRef(item, entity.ref))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['entities', index, 'status'],
          message:
            entity.status === 'ok'
              ? 'An ok entity needs its item'
              : `A ${entity.status} entity has no item`,
        });
      }
    });
  })
  .describe('The result of one poll.');
export type Batch = z.output<typeof batchSchema>;

/** What core asks one poll to observe, built by core. */
export interface PollContext {
  /** Entities to observe besides the source's own listing. */
  observe: {
    /** Pull requests of board tasks. */
    prs: readonly PrEntityRef[];
    /**
     * Tickets outside the tracker filter, open tracked tickets of a tracker whose listing omits
     * closed ones, and pending manual includes, which have a key but no id.
     */
    tickets: readonly TicketEntityRef[];
    /** Sessions linked to board tasks. */
    sessions: readonly SessionEntityRef[];
  };
  /** Known persisted terminal PRs: merged are final; closed are deferred unless discovered open. */
  terminalPrs?: readonly { ref: PrEntityRef; state: 'merged' | 'closed' }[];
  /** Due state-only checks. These do not participate in A4 or gone accounting. */
  prRechecks?: readonly PrEntityRef[];
  /** The cursor the previous batch returned; absent on the first poll. */
  cursor?: SourceCursor | undefined;
  /** Persisted consecutive misses for requested PRs and tickets; loaded after a restart. */
  missCounts?: readonly { ref: PrEntityRef | TicketEntityRef; count: number }[] | undefined;
  /**
   * Per requested PR, the newest comment or review already handed over, or a time with an id no
   * entry has: the adapter reads feedback back to it instead of to the start of the PR. Absent
   * for a PR, no limit.
   */
  feedbackCursors?: readonly { ref: PrEntityRef; id: string; postedAt: string }[] | undefined;
  /**
   * Per requested PR, the comment history the last regular poll asked core to hold (A10): the
   * feedback it read and the opaque position to read further back from, `null` at the start of
   * the PR. Absent for a PR, nothing held.
   */
  continuations?:
    | readonly { ref: PrEntityRef; resume: SourceCursor | null; feedback: readonly PrFeedback[] }[]
    | undefined;
  /** Aborted when core stops the poll (A7). */
  signal: AbortSignal;
  /**
   * Aborted when an on-demand read waits for this poll: the adapter ends its optional reads
   * (approval history), its own in flight included, and returns the batch it has. Absent: never.
   */
  optionalSignal?: AbortSignal;
}

/** Source id of the PR poll of one project repo: `github:<project>:<repo lowercased>`. */
export function prSourceId(projectId: string, repo: string): string {
  return `github:${projectId}:${repo.toLowerCase()}`;
}

/**
 * Source id of a project's tracker poll: `jira:<project>`, or
 * `github-issues:<project>:<tracker repo lowercased>`.
 */
export function trackerSourceId(
  project: Pick<Config['projects'][number], 'id' | 'tracker'>,
): string {
  return project.tracker.type === 'jira'
    ? `jira:${project.id}`
    : `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`;
}

/**
 * Source id of a project's GitHub Project mirror, `github-project:<project>:<owner/number
 * lowercased>`, or undefined when its ready-for-dev column is manual.
 */
export function mirrorSourceId(
  project: Pick<Config['projects'][number], 'id' | 'tracker' | 'columns'>,
): string | undefined {
  const mirror = readyMirrorOf(project);
  return mirror === undefined
    ? undefined
    : `github-project:${project.id}:${mirror.project.toLowerCase()}`;
}

/** Why a github-project source read no complete snapshot; positions stay where they are. */
export const MIRROR_FAILURE_CODES = [
  'mirror_project_forbidden',
  'mirror_field_not_found',
  'mirror_snapshot_incomplete',
  'mirror_rate_limited',
  'mirror_read_failed',
] as const;
export type MirrorFailureCode = (typeof MIRROR_FAILURE_CODES)[number];

/** Meaning and fix of each mirror failure code, for docs/errors.md and board doctor. */
export const MIRROR_FAILURES: Record<MirrorFailureCode, { meaning: string; fix: string }> = {
  mirror_project_forbidden: {
    meaning:
      'The GitHub Project was not found or is not readable with GITHUB_TOKEN: a wrong owner or number, a missing read:project scope, or no access to the Project.',
    fix: 'Check projects[].columns[].source.project against the Project URL and give GITHUB_TOKEN the read:project scope (a fine-grained token: Projects read access for the owner). Restart the daemon after changing config.yaml or secrets.env.',
  },
  mirror_field_not_found: {
    meaning:
      "The Project has no single-select field with the configured name, the field has no option with the configured value, or an open issue's item in the Project holds an option the field does not list.",
    fix: 'Set source.field to the name of a single-select field of the Project and source.value to one of its option names, letter case included, and restart the daemon; or set the field again on the named issue in the Project.',
  },
  mirror_snapshot_incomplete: {
    meaning:
      'The read did not fit one page: the tracker repository has more than 100 open issues, or an issue sits in more than 20 Projects.',
    fix: 'Close or move open issues until the repository has at most 100, or remove an issue from Projects it does not need; the mirror applies the next complete read.',
  },
  mirror_rate_limited: {
    meaning: 'GitHub rate-limited the read; the board retries after the reset.',
    fix: 'Wait for the reset. If it repeats, lower the GraphQL load of other clients of the token or raise adapters.githubIssues.intervalMs.',
  },
  mirror_read_failed: {
    meaning:
      "The read failed for another reason: a network or server error, a malformed response, an open issue's item whose field value is not a single-select value, or a GraphQL error on the repository.",
    fix: 'Usually transient: the board retries on its next poll. If it persists, check the daemon log for the GitHub error.',
  },
};

/**
 * One source of facts. Core calls `poll` every `intervalMs` and decides what the facts mean.
 *
 * Obligations:
 * - A1: A batch carries facts only. No wire format of the source (query fields, paging
 *   tokens, response JSON, headers) reaches the batch or core, except the opaque resume of A10.
 *   A request budget the source reports goes in `budget`, in source-neutral terms.
 *   A source repository's default-branch colour goes in `defaultBranch`; omitted, it says
 *   nothing. Only push-triggered workflow check runs and commit statuses decide it.
 * - A2: `observedAt` is the time the poll started, not when it finished.
 * - A3: `complete` is true only when the whole listing was read without errors. A request the
 *   adapter gave up on or deferred for budget also leaves it false. An incomplete batch still
 *   carries the facts it did observe. Core concludes anything from absence only after a
 *   complete batch. Only a complete batch carries `mirror`, and core moves tasks by it.
 * - A4: `entities` holds exactly one entry for each ref in `PollContext.observe`. An `ok`
 *   entity has exactly one item with the same identity (a PR by repo and number, a ticket by
 *   tracker and id, a session by id); a `not_found` or `no_access` entity has none, so a missed
 *   fetch never reads as absence. A per-entity outcome does not clear `complete`. A requested
 *   session that answers 404 is reported as `not_found` with no item; it counts as resolved,
 *   and core records it as `vanished` at once, outside the gone-after-polls count. An `ok` item
 *   may carry the facts of the adapter's own earlier read when a lighter read in this poll shows
 *   the entity unchanged. A ref whose read failed or was deferred is `no_access` in an
 *   incomplete batch.
 *   State-only `prRechecks` are answered separately in `prProbes`; unchanged closed probes
 *   carry no full item and never imply ordinary entity absence.
 * - A5: The cursor is opaque to core. The adapter returns a new one or omits it, and it never
 *   moves backwards.
 * - A6: One attempt per request; the adapter does not retry on its own, with one exception: it
 *   may resend the entities of a request that failed `transient` (5xx, a cut-off body, a
 *   timeout) as smaller requests, within a fixed per-poll limit. It never resends after
 *   `throttled`, `auth`, `config` or an abort. A failure of the whole poll rejects with an
 *   `AdapterError` of the matching kind; core treats any other rejection as `transient`.
 * - A7: The adapter honours `PollContext.signal` and returns no batch after it is aborted.
 * - A8: A pending ticket request has no stable id. Its `ok` item matches by tracker and key;
 *   the next observation binds the returned stable id. Known tickets still match by id.
 * - A9: `pollPr` observes one requested PR. `entities` holds exactly that ref, `items` at most
 *   its own item, `complete` is false and the batch carries no cursor and no `continuation`, so
 *   an out-of-turn poll never moves discovery, reads as a complete listing or changes what core
 *   holds. It carries no `defaultBranch`; only `poll` sets it. It may receive the PR's `feedbackCursors` and `continuations` entry and merge the
 *   held history within the same page budget. A1, A2, A6 and A7 apply.
 * - A10: A `pr` item of `poll` may carry `continuation`. Omitted, it says nothing; `null` drops
 *   what core holds; an object asks core to hold `facts.feedback` with the opaque `resume`
 *   (`null` at the start of the PR) and to return both in `PollContext.continuations`. Core
 *   never parses `resume`. `feedbackComplete` is true only for a run of comments that joins the
 *   newest one to the feedback cursor or to the start of the PR.
 */
export interface Adapter {
  /** Stable id of this adapter instance; becomes `Batch.source`. */
  readonly id: string;
  /** Time between two polls in milliseconds, from `adapters.<source>.intervalMs`. */
  readonly intervalMs: number;
  /** Observes the source once (A1-A7, A10). */
  poll(ctx: PollContext): Promise<Batch>;
  /** Drains reported usage not yet returned in a batch or failure, including during cancellation. */
  takeUsage?(): Batch['usage'];
  /**
   * Observes one pull request out of turn (A9). Omitted by a source that cannot; the runner
   * then answers `unsupported`.
   */
  pollPr?(
    ref: PrEntityRef,
    ctx: Pick<PollContext, 'signal' | 'feedbackCursors' | 'continuations'>,
  ): Promise<Batch>;
}

export const SPUR_REQUEST_TIMEOUT = 'spur_request_timeout';
type SpurRequestTimeout = { code: typeof SPUR_REQUEST_TIMEOUT; message: string };

/** State accepted with a batch; a separate report handles failures without a batch. */
export interface SourceState {
  /** Poll-start time of the last effectively complete batch. */
  lastCompleteAt?: string | undefined;
  blind?: { reason: 'auth' | 'config' | 'stale'; message: string } | undefined;
  /** The last GitHub Project poll failure, or a request timeout while Spur is stale. */
  failure?: { code: MirrorFailureCode; message: string } | SpurRequestTimeout | undefined;
  gone: readonly EntityRef[];
}

/** One accepted observation that core commits atomically. */
export interface AcceptedObservation {
  batch: Batch;
  effectiveComplete: boolean;
  state: SourceState;
  outcomes: readonly {
    ref: PrEntityRef | TicketEntityRef;
    misses: number;
    gone: boolean;
  }[];
}

/** Core-facing side of the adapter runner. */
export interface AdapterCore {
  /** Requested entities, cursor, and persisted miss counters for the next poll. */
  context(source: string): Promise<Omit<PollContext, 'signal'>>;
  /** Commits the accepted observation and its source state together. */
  observe(source: string, observation: AcceptedObservation): Promise<void>;
  /** Reports a source failure or stale deadline without a batch. */
  reportSourceState(source: string, state: SourceState, usage?: Batch['usage']): Promise<void>;
}

/** A whole-poll failure (A6). `retryAt` is when the source allows the next attempt. */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly retryAt?: Date | undefined;
  /** The mirror failure code a github-project source reports with this failure. */
  readonly code?: MirrorFailureCode | undefined;
  /** Operator-facing detail for a timed-out Spur request. */
  readonly sourceFailure?: SpurRequestTimeout | undefined;
  usage?: Batch['usage'];

  constructor(
    kind: AdapterErrorKind,
    message: string,
    options: {
      retryAt?: Date | undefined;
      cause?: unknown;
      code?: MirrorFailureCode;
      sourceFailure?: SpurRequestTimeout;
    } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'AdapterError';
    this.kind = kind;
    this.retryAt = options.retryAt;
    this.code = options.code;
    this.sourceFailure = options.sourceFailure;
  }
}

/** Why an on-demand PR poll returned no facts. Separate from `ADAPTER_ERROR_KINDS`. */
export const POLL_PR_ERROR_KINDS = [
  'unknown_source',
  'unsupported',
  'blind',
  'timeout',
  'failed',
  'stopped',
] as const;
export type PollPrErrorKind = (typeof POLL_PR_ERROR_KINDS)[number];

/** What an applied on-demand PR poll observed; `observedAt` is the start of its turn. */
export type PollPrValue =
  | { status: 'ok'; facts: PrFacts; observedAt: string }
  | { status: 'not_found' | 'no_access'; observedAt: string };

/** Why an on-demand PR poll applied nothing. */
export type PollPrError =
  | { kind: Exclude<PollPrErrorKind, 'blind' | 'failed'>; message: string }
  | { kind: 'blind'; reason: NonNullable<SourceState['blind']>['reason']; message: string }
  | {
      kind: 'failed';
      /** The `AdapterError` kind, or `unexpected` for any other failure. */
      adapterKind: AdapterErrorKind | 'unexpected';
      /** When the source allows the next attempt, for a throttled failure. */
      retryAt?: string | undefined;
      message: string;
    };

export type PollPrResult = Result<PollPrValue, PollPrError>;

/** Polls one pull request out of turn through the runner, the only writer of PR facts. */
export interface PrPoller {
  /**
   * Queues a poll of `ref` on the source's single-flight chain, after any poll in flight, and
   * resolves once core committed its observation; it never rejects. `source` is the id core
   * builds with `prSourceId`. The commit moves the source's `observed_at` but not its
   * last complete time. While a regular throttle wait runs it resolves `failed` with
   * `adapterKind: 'throttled'` and `retryAt` without calling the source. A `transient` failure
   * of the source call is tried again, up to 3 attempts 1 s and 2 s apart, inside `timeoutMs`;
   * nothing else is retried.
   */
  pollPr(source: string, ref: PrEntityRef, options: { timeoutMs: number }): Promise<PollPrResult>;
}
