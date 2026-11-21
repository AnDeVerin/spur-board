import { z } from 'zod';
import {
  APPROVAL_RULES,
  CHECKS_GATE_COLUMNS,
  COLUMNS,
  COLUMN_IDS,
  DISPATCHER_MODES,
  REQUIRED_COLUMN_IDS,
  TODO_GROUP_COLUMN_IDS,
  type AddresseeSource,
  type ApprovalRule,
  type ColumnBindingSource,
  type ColumnId,
  type OperatorBindingSource,
} from './enums.ts';

/**
 * The daemon's default loopback port. It sits above 4310-4399, a margin the board keeps for
 * Spur's server port 4310 and the ports from 4311 upward that Spur's MCP port takes. It also
 * avoids Spur's web UI port 5555, its Playwright sidecars 8730-8799 and the Linux ephemeral
 * range 32768-60999.
 */
export const DEFAULT_HTTP_PORT = 4777;
export const DEFAULT_STAND_PORT_RANGE = { min: 4780, max: 4799 } as const;
export const DEFAULT_SLACK_APP_NAME = 'spur-board';
export const DEFAULT_SLACK_COMMAND = '/board';
/**
 * The journal project of board-wide events that belong to no configured project: token
 * lifecycle, unknown Spur states and denials with no resolvable project. It sits outside the
 * project id pattern, so no configured project can take it.
 */
export const RESERVED_PROJECT = '_board';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const nonEmpty = z.string().min(1);
/** A GitHub repository as `owner/name`. */
export const repoSlugSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Expected owner/name');

/** Adds an issue at `[i, key]` for each element whose `key` repeats an earlier one. */
function rejectDuplicates<T>(
  items: readonly T[],
  key: keyof T & string,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<unknown>();
  items.forEach((item, i) => {
    const value = item[key];
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, key],
        message: `Duplicate ${label}: ${JSON.stringify(value)}`,
      });
    }
    seen.add(value);
  });
}

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * False for an `http:` URL whose host is not loopback: such a URL would carry credentials in
 * clear text. Loopback is `localhost`, 127.0.0.0/8 or `[::1]` after WHATWG normalization; no DNS.
 */
export function plainHttpAllowed(url: URL): boolean {
  if (url.protocol !== 'http:') return true;
  const host = url.hostname;
  return host === 'localhost' || host === '[::1]' || LOOPBACK_IPV4.test(host);
}

/** Check raw syntax before URL normalization can hide a slash, whitespace or backslash. */
function validOrigin(value: string, port?: number, allowHttp = false): boolean {
  const resolved = port === undefined ? value : value.replaceAll('{port}', String(port));
  if (!/^https?:\/\/[^/\\\s?#@{}]+$/i.test(resolved)) return false;
  try {
    const url = new URL(resolved);
    return url.username === '' && url.password === '' && (allowHttp || plainHttpAllowed(url));
  } catch {
    return false;
  }
}

const originError =
  'Expected a bare HTTP/HTTPS origin; HTTP requires loopback, with no path, trailing slash, query, fragment, credentials or invalid placeholders';
const concreteOrigin = z.string().refine((value) => validOrigin(value, undefined, true), {
  error:
    'Expected a bare HTTP/HTTPS origin with no path, trailing slash, query, fragment, credentials or placeholders',
});

const jiraTracker = z.strictObject({
  type: z
    .literal('jira')
    .describe(
      'jira: tasks come from the Jira issues jql returns, read with JIRA_EMAIL and JIRA_API_TOKEN from secrets.env.',
    ),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .refine(
      (value) => {
        try {
          return plainHttpAllowed(new URL(value));
        } catch {
          return true;
        }
      },
      {
        error:
          'Use https: for the Jira URL; http: is allowed only on a loopback host (localhost, 127.0.0.0/8, ::1) because it receives your Jira credentials',
      },
    )
    .describe('Jira site URL. https:, or http: only on a loopback host.'),
  jql: nonEmpty.describe(
    'Jira search whose issues become tasks in To Do. A task whose issue leaves the result is flagged out of filter while it has an open PR or a live session, and is archived otherwise, once Spur, the tracker and every repo have a complete poll since its last change and none of them is blind; a task added or removed by hand is left alone.',
  ),
  doneStatuses: z
    .array(nonEmpty.describe('A Jira status name, spelled exactly as in Jira.'))
    .min(1)
    .describe(
      'Jira statuses that mean done. A task whose issue is in one of them and that has no open PR is archived on the next archive.doneWeekday, once every repo has a complete poll since its last change. Each name must exist in every projectKeys project, or the Jira poll fails with a config error.',
    ),
  readyStatuses: z
    .array(nonEmpty.describe('A Jira status name, spelled exactly as in Jira.'))
    .min(1)
    .describe(
      'Jira statuses that mean ready for development. The board checks only that each name exists in every projectKeys project; the Jira poll fails with a config error otherwise.',
    ),
  projectKeys: z
    .array(
      z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/, 'Expected a Jira project key like PROJ')
        .describe('A Jira project key in capitals, such as PROJ.'),
    )
    .default([])
    .describe(
      "Keys of this board project's Jira projects, such as PROJ. A PR names its task by one of these keys, and doneStatuses and readyStatuses are checked in each of these projects. A task key such as PROJ-12 belongs to the one board project whose list holds its prefix; an empty list takes every Jira key, and a key that several projects take belongs to none. The Jira poll fails with a config error while the list is empty.",
    ),
});

/** Capture groups of a pattern that compiles without flags, or `undefined` when it does not. */
function captureGroups(pattern: string): number | undefined {
  try {
    new RegExp(pattern);
    // Compiled alone first, so the pattern's tail cannot escape or close the wrapper.
    return (new RegExp(`(?:${pattern})|`).exec('')?.length ?? 1) - 1;
  } catch {
    return undefined;
  }
}

/** Where a PR in the tracker repository can name its issue, in the default priority order. */
const LINK_SOURCES = ['closing', 'branch', 'title'] as const;

/**
 * The `projects[].link` defaults. A Jira project whose `link` field equals its default here
 * treats it as unset and finds every `tracker.projectKeys` key in that text instead.
 */
export const DEFAULT_LINK = {
  sources: LINK_SOURCES,
  branchPattern: '^[A-Za-z]+-([1-9][0-9]*)',
  titlePattern: '^[a-z]+(?:\\([^)]*\\))?!?: #([1-9][0-9]*)',
} as const;

/** A `link` pattern: compiles, starts with `^` and has exactly one capture group. */
function linkPattern(fallback: string, description: string) {
  return nonEmpty
    .superRefine((pattern, ctx) => {
      if (!pattern.startsWith('^') || captureGroups(pattern) !== 1)
        ctx.addIssue({
          code: 'custom',
          message:
            'Expected a regular expression that starts with ^ and has exactly one capture group',
        });
    })
    .default(fallback)
    .describe(description);
}

const githubIssuesTracker = z
  .strictObject({
    type: z
      .literal('github-issues')
      .describe(
        'github-issues: tasks come from the open issues of tracker.repo, narrowed by label or milestone when set, read with GITHUB_TOKEN.',
      ),
    repo: repoSlugSchema.describe(
      'Repository as owner/name whose open issues become tasks. PRs link to its issues only in this repository, so list it in repos too.',
    ),
    label: nonEmpty
      .describe(
        'Only open issues with this label become tasks. Set at most one of label and milestone; with neither, every open issue of tracker.repo becomes a task.',
      )
      .optional(),
    milestone: nonEmpty
      .describe(
        'Only open issues in the milestone with this title become tasks. Set at most one of label and milestone; with neither, every open issue of tracker.repo becomes a task.',
      )
      .optional(),
  })
  .superRefine((tracker, ctx) => {
    if (tracker.label !== undefined && tracker.milestone !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'Set at most one of label or milestone',
      });
    }
  });

const spurProject = z.strictObject({
  name: nonEmpty.describe(
    'The name of the project in Spur. A Spur project can be listed under only one board project.',
  ),
  role: z
    .enum(['worker', 'operator', 'curator', 'orchestrator'])
    .describe(
      "worker: sessions of this Spur project may link to this project's tasks through their PR or branch. operator: sessions act as the operator of this board project only. orchestrator: sessions execute named columns and never become task workers. curator: sessions answer the questions no column orchestrator takes and escalate the rest to the operator; a board project has at most one.",
    ),
  shortName: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'Expected a short name of lowercase letters, digits, _ and -, starting with a letter or digit, at most 32 characters',
    )
    .optional()
    .describe(
      "The name the operator types as @<shortName> at the start of a new message in the orchestrators channel to start a conversation with this Spur project's live session. Unique across the board.",
    ),
  displayName: nonEmpty
    .max(80)
    .optional()
    .describe(
      "The name Slack messages this Spur project's sessions write are posted under: block threads and replies, and a curator's answer lines in the feed. Defaults to the Spur project name.",
    ),
  icon: z
    .string()
    .regex(/^:[a-z0-9_+'-]+:$/, 'Expected an emoji shortcode such as :owl:')
    .optional()
    .describe(
      'The emoji shortcode, such as :owl:, shown on those messages instead of the role icon.',
    ),
});

const DEFAULT_CYCLE_LIMIT = 10;
const DEFAULT_COURSE_CHECK = 3;

/** A built-in column id; an unknown string names the built-in columns. */
const columnId = z.enum(COLUMN_IDS, {
  error: (issue) =>
    typeof issue.input === 'string'
      ? `Unknown column ${JSON.stringify(issue.input)}: custom columns arrive with custom matchers and are not supported yet. Built-in columns: ${COLUMN_IDS.join(', ')}`
      : undefined,
});

/** A GitHub Project as `owner/number`, the owner's login and the Project number. */
const githubProjectRef = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[1-9][0-9]*$/, 'Expected owner/number, such as example-org/3');

const trackerColumnSource = z.strictObject({
  type: z
    .literal('tracker')
    .describe(
      'tracker: the board places idle Todo-group tasks between todo and ready-for-dev from the status of their issue in a GitHub Project, read on every poll with GITHUB_TOKEN (scope read:project). An issue whose field has the value moves to ready-for-dev; one that loses it, leaves the Project or is archived there moves back to todo. Tasks with started work, and triage, are never moved. Manual moves into or out of ready-for-dev are refused with column_mirrored. A failed or incomplete read moves nothing. Only on the ready-for-dev column of a github-issues project.',
    ),
  project: githubProjectRef.describe(
    'The GitHub Project as owner/number: the user or organization login that owns it and its number from the Project URL.',
  ),
  field: nonEmpty.describe(
    'Name of the single-select field of the Project to read, such as Status.',
  ),
  value: nonEmpty.describe(
    'The option of field that places a task in ready-for-dev, such as Ready; matched to an option name exactly, letter case included.',
  ),
});

const columnConfig = z.strictObject({
  id: columnId.describe('The built-in column this entry configures.'),
  enabled: z
    .boolean()
    .default(true)
    .describe(
      'false skips the column: tasks move past it and its exit condition is not checked. todo, dev and done cannot be disabled.',
    ),
  orchestrator: nonEmpty
    .default('none')
    .describe(
      "Who takes the column's turns. none: the task's live worker session, else the operator. operator: the operator, who also gets the questions asked in the column. Otherwise the name of a spurProjects entry with role orchestrator or curator whose sessions orchestrate the column and get the questions others ask in it. A column left at none, and enabled, takes the top-level spurProjects orchestrator that lists it.",
    ),
  cycleLimit: z
    .int()
    .min(1)
    .default(DEFAULT_CYCLE_LIMIT)
    .describe(
      'How many times a task may return to Dev from this column before the board stops it for the operator. Returns by the column executor, for external comments and for unresolved review threads count, a changes-requested review included (it is an external comment, not a separate return); a conflict, red CI and a draft do not.',
    ),
  courseCheck: z
    .int()
    .min(0)
    .default(DEFAULT_COURSE_CHECK)
    .describe(
      "How many returns to Dev from this column, counted as for cycleLimit, before the board holds the task and asks courseCheckTo (by default the curator, or the operator when the project has no curator) to check its course. The answer resets the count and reaches the worker as a task comment. 0 turns the check off; cycleLimit is checked first. With External Review enabled, returns for external comments from any column, and each external change request on a new PR head while the task is in Dev (once per head), count toward External Review's courseCheck instead of this column's; cycleLimit still counts them per column.",
    ),
  courseCheckTo: nonEmpty
    .optional()
    .describe(
      "Who answers this column's course check: operator, the curator's name, or the name of a column orchestrator listed in this project's spurProjects; a board-wide orchestrator is refused. Without it, the curator, or the operator when the project has no curator. When the addressee has no live session the question moves to the operator; a conductor that is rung and does not answer keeps it, and the operator gets an item.",
    ),
  requireResolvedThreads: z
    .boolean()
    .optional()
    .describe(
      "true: a task leaves this column, and every column right of it, only when its PR has no unresolved review thread; an unresolved one sends it back to Dev, and the worker's Dev turn lists each thread. Outdated threads count; a thread counts until someone resolves it, whoever wrote it. Defaults to true on ready-to-merge and false elsewhere; allowed on dev through ready-to-merge.",
    ),
  approvalRule: z
    .enum(APPROVAL_RULES)
    .optional()
    .describe(
      "What lets a task leave External Review. any-approval, the default: an approval by someone other than operatorGithubLogin and no changes requested by one. github-rules: that, and GitHub's review rule for the PR's base branch, from branch protection and rulesets, met on the PR's head: no changes requested (GitHub's review decision counts only once the merge state is computed), a required check completed, or, when none is required, every check except skipped ones green and at least one (no checks at all also counts); and the merge not blocked. A required check, one GitHub marks required or a context the rule lists, pending or without a run GitHub marks required holds the head on CI unless the merge state is clean, unstable or has hooks. Only on the external-review column; a disabled one ignores it.",
    ),
  quietTurnAfterMs: z
    .int()
    .min(1)
    .optional()
    .describe(
      'How long the orchestrator session holding a turn of this column may sit quiet at its prompt before the board reminds it, then raises a stuck-turn anomaly, in milliseconds. Defaults to health.idleInDevAfterMs. Named orchestrator only: allowed on an enabled column whose orchestrator is a Spur project, set here or filled board-wide; a worker or operator turn left in the column keeps health.idleInDevAfterMs.',
    ),
  noRecipientAfterMs: z
    .int()
    .min(1)
    .optional()
    .describe(
      "How long an untaken turn of this column may wait with no live session to ring before the board raises one operator item for the project and column, in milliseconds. The time runs from the later of the turn ring's creation and the moment the last session that could take it stopped being a recipient: the first of its end, leaving Spur's list or reaching a finished state (stopped, killed, errored or completed), so later changes in the same gap do not move it. Sessions that could take it are those of the column's Spur project and the task's linked orchestrator. Defaults to 600000 (10 minutes). Named orchestrator only: allowed on an enabled column whose orchestrator is a Spur project, set here or filled board-wide.",
    ),
  source: z
    .union([
      z
        .literal('manual')
        .describe('manual: the operator moves tasks into and out of the column, the default.'),
      trackerColumnSource,
    ])
    .optional()
    .describe(
      'Where ready-for-dev takes its tasks from: manual (the default), or a GitHub Project field mirrored by the board. Only on the ready-for-dev column.',
    ),
});

/** The default of `projects[].columns[].noRecipientAfterMs`. */
export const DEFAULT_NO_RECIPIENT_AFTER_MS = 600_000;

const TURN_TIMING_KEYS = ['quietTurnAfterMs', 'noRecipientAfterMs'] as const;

type ColumnConfig = z.output<typeof columnConfig>;

/**
 * The approval rule of a project's External Review: github-rules only when its enabled
 * external-review column sets it, else any-approval.
 */
export function approvalRuleOf(project: {
  columns: readonly Pick<ColumnConfig, 'id' | 'enabled' | 'approvalRule'>[];
}): ApprovalRule {
  const column = project.columns.find((entry) => entry.id === 'external-review');
  return column?.enabled === true && column.approvalRule === 'github-rules'
    ? 'github-rules'
    : 'any-approval';
}

/** The GitHub Project status a project's ready-for-dev mirrors, with its owner and number. */
export interface ReadyMirror {
  /** The Project as configured, `owner/number`. */
  project: string;
  owner: string;
  number: number;
  field: string;
  value: string;
}

/**
 * The GitHub Project status a project's ready-for-dev column mirrors: set only when the column
 * is enabled and sets a tracker source on a github-issues project, else undefined (manual).
 */
export function readyMirrorOf(project: {
  tracker: { type: string };
  columns: readonly Pick<ColumnConfig, 'id' | 'enabled' | 'source'>[];
}): ReadyMirror | undefined {
  const column = project.columns.find((entry) => entry.id === 'ready-for-dev');
  const source = column?.source;
  if (
    column?.enabled !== true ||
    typeof source !== 'object' ||
    project.tracker.type !== 'github-issues'
  )
    return undefined;
  const [owner = '', number = ''] = source.project.split('/');
  return {
    project: source.project,
    owner,
    number: Number(number),
    field: source.field,
    value: source.value,
  };
}

/** Columns a task never leaves through the Dev gate, so they cannot require resolved threads. */
const NO_THREAD_GATE: ReadonlySet<ColumnConfig['id']> = new Set([...TODO_GROUP_COLUMN_IDS, 'done']);

/**
 * The board rules: required columns present and enabled, resolved threads required only from Dev
 * to Ready to Merge, built-ins in canonical order.
 */
function checkBoard(items: readonly ColumnConfig[], ctx: z.RefinementCtx): void {
  rejectDuplicates(items, 'id', 'column', ctx);
  for (const required of REQUIRED_COLUMN_IDS) {
    const i = items.findIndex((item) => item.id === required);
    if (i === -1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Missing required column ${JSON.stringify(required)}`,
      });
    } else if (!items[i]?.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'enabled'],
        message: `Required column ${JSON.stringify(required)} cannot be disabled`,
      });
    }
  }
  items.forEach((item, i) => {
    if (item.approvalRule !== undefined && item.id !== 'external-review') {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'approvalRule'],
        message: `Column ${JSON.stringify(item.id)} cannot set approvalRule: approvalRule is allowed only on the external-review column`,
      });
    }
    if (item.source !== undefined && item.id !== 'ready-for-dev') {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'source'],
        message: `Column ${JSON.stringify(item.id)} cannot set source: source is allowed only on the ready-for-dev column`,
      });
    }
    if (item.id === 'ready-for-dev' && typeof item.source === 'object' && !item.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'source'],
        message:
          'Column "ready-for-dev" cannot mirror a GitHub Project while disabled: set enabled: true or remove source',
      });
    }
    if (item.requireResolvedThreads === true && NO_THREAD_GATE.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'requireResolvedThreads'],
        message: `Column ${JSON.stringify(item.id)} cannot require resolved threads: set it on a column from dev to ready-to-merge`,
      });
    }
  });
  let previous = -1;
  items.forEach((item, i) => {
    const position = COLUMN_IDS.indexOf(item.id);
    if (position < previous) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'id'],
        message: `Column ${JSON.stringify(item.id)} is out of order: built-in columns go in the order ${COLUMN_IDS.join(', ')}`,
      });
    }
    previous = Math.max(previous, position);
  });
}

/** One path segment with an optional trailing `/`: a top-level directory or root file name. */
const APPROVAL_WATCH_ENTRY = /^[^/\s]+\/?$/;

const projectSchema = z
  .strictObject({
    id: z
      .string()
      .refine((id) => id !== RESERVED_PROJECT, {
        message: `"${RESERVED_PROJECT}" is reserved for board-wide journal events; choose another project id`,
        abort: true,
      })
      .regex(/^[a-z][a-z0-9-]*$/, 'Expected lowercase letters, digits and dashes')
      .describe(
        'Board project id: lowercase letters, digits and dashes, unique, not _board. It names the project on its tasks, in the journal and in its source ids such as jira:<id> and github:<id>:<repo>.',
      ),
    tracker: z.discriminatedUnion('type', [jiraTracker, githubIssuesTracker]),
    repos: z
      .array(repoSlugSchema.describe('A repository as owner/name.'))
      .min(1)
      .describe(
        'GitHub repositories as owner/name whose PRs the board polls for this project, one source each. A done task is archived only after every listed repository has a complete poll since its last change.',
      ),
    reposWithoutCi: z
      .array(repoSlugSchema.describe('A repository from repos as owner/name, in any letter case.'))
      .default([])
      .describe(
        'Repos from repos that run no CI checks, in any letter case. In a listed repo, a PR whose check list on head is empty passes the Dev gate check condition instead of waiting in Dev. A list of only skipped checks still waits, and red or pending checks still count. A listed repo whose branch protection requires checks that have not reported yet also passes, so list only repos that run no checks. Without this key, a PR with no checks waits in Dev.',
      ),
    checksGate: z
      .enum(CHECKS_GATE_COLUMNS, {
        error: (issue) =>
          typeof issue.input === 'string'
            ? `checksGate ${JSON.stringify(issue.input)} is not allowed: use one of ${CHECKS_GATE_COLUMNS.join(', ')}`
            : `checksGate must be one of ${CHECKS_GATE_COLUMNS.join(', ')}`,
      })
      .default('dev')
      .describe(
        "The column whose exit requires green checks on the PR head: dev (the default), review, product-review or external-review, and the column must be enabled. Running checks, or no checks yet, hold a task only at the exit of this column. Red checks return the task to Dev from any column; a task whose turn is taken returns right after that turn's submit. A task enters ready-to-merge only with green checks. With dev, a cancelled check is red at once. With another column, a cancelled check counts as running until two complete GitHub polls after the one that saw it, about two GitHub poll intervals, and then counts as red; a new run in that window replaces it, and a source whose polls stay incomplete keeps it running. The daemon reads the key at start, so a change takes effect after a restart.",
      ),
    approvalWatch: z
      .array(
        z
          .string({ error: 'approvalWatch entries must be strings' })
          .regex(APPROVAL_WATCH_ENTRY, {
            error: (issue) =>
              `approvalWatch entry ${JSON.stringify(issue.input)} is not allowed: use one top-level directory or root file name, such as back/ or package.json, without spaces or an inner /`,
          })
          .refine((entry) => !['.', '..'].includes(entry.replace(/\/$/, '')), {
            error: (issue) =>
              `approvalWatch entry ${JSON.stringify(issue.input)} is not allowed: name a top-level directory or root file, not . or ..`,
          })
          .describe(
            'One top-level directory (back/) or root file (package.json) of the repository. The trailing / is optional: back/ and back each match a directory or a file named back. Case-sensitive.',
          ),
        { error: 'approvalWatch must be a list of top-level directories or root files' },
      )
      .min(1, {
        error: 'approvalWatch must list at least one entry; leave the key out to watch everything',
      })
      .optional()
      .describe(
        'Top-level directories and root files whose change after an approval the board points out. For each approval of an open PR given on an older commit than the head, board status and board task list every top-level entry changed by the commits after it in changedAfter, and the entries that match this list in watchedAfter. Without the key every changed top-level entry counts as watched. A hint only: no gate, move or turn reads it. The daemon reads the key at start, so a change takes effect after a restart.',
      ),
    link: z
      .strictObject({
        sources: z
          .array(
            z
              .enum(LINK_SOURCES)
              .describe('One place a PR can name its task: closing, branch or title.'),
          )
          .min(1)
          .superRefine((sources, ctx) => {
            sources.forEach((source, i) => {
              if (sources.indexOf(source) !== i)
                ctx.addIssue({
                  code: 'custom',
                  path: [i],
                  message: `Duplicate link source: ${JSON.stringify(source)}`,
                });
            });
          })
          .default([...DEFAULT_LINK.sources])
          .describe(
            'Where a PR names its task, in priority order; the first source that yields an issue number wins (for a Jira project, an issue key). closing: issues in tracker.repo the PR closes (Closes #12 in the body, or linked in the sidebar), for PRs to the default branch only; a Jira project skips it. branch: branchPattern on the head branch. title: titlePattern on the PR title.',
          ),
        branchPattern: linkPattern(
          DEFAULT_LINK.branchPattern,
          'Regular expression that starts with ^ and whose one capture group reads the issue number from a PR head branch, such as <agent>-<number>-<slug>. Branches longer than 255 characters are not matched. For a Jira project the capture group reads the issue key, such as PROJ-12, which must use one of tracker.projectKeys in any letter case; left at the default, a Jira project finds every such key in the PR head branch.',
        ),
        titlePattern: linkPattern(
          DEFAULT_LINK.titlePattern,
          'Regular expression that starts with ^ and whose one capture group reads the issue number from a PR title, such as fix(core): #12 summary. Titles longer than 255 characters are not matched. For a Jira project the capture group reads the issue key, such as PROJ-12, which must use one of tracker.projectKeys in any letter case; left at the default, a Jira project finds every such key in the PR title.',
        ),
      })
      .prefault({})
      .describe(
        "How a project links a PR to its task. A github-issues project reads an issue number from PRs in tracker.repo; a Jira project reads an issue key with one of tracker.projectKeys from PRs in repos. Left at the defaults, a Jira project links every tracker.projectKeys key (such as PROJ-12, any letter case) in the PR title or head branch. Set the sources and patterns to the branch and PR title naming rules of the repos. The board does not enforce those rules; the repo enforces them through its CI title check and its agents' skills. board doctor compares these rules with recent PRs by operatorGithubLogin.",
      ),
    operatorGithubLogin: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/, 'Expected a GitHub login')
      .describe(
        "The GitHub account agents open PRs under. PR discovery in repos keeps only PRs whose author is this login. It is not necessarily the maintainer's own account: when agents push as one account and a maintainer approves as another, set the agents' account, or no PR is discovered. Comments, reviews and approvals by this login or by a bot (GitHub App) are not external: they never return a task to Dev, approve External Review or block its approval. Every other account is external, the repo owner's and the human operator's included.",
      ),
    spurProjects: z
      .array(spurProject)
      .superRefine((items, ctx) => {
        rejectDuplicates(items, 'name', 'spur project name', ctx);
        let curator: string | undefined;
        items.forEach((item, i) => {
          if (item.role !== 'curator') return;
          if (curator !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'role'],
              message: `Second curator ${JSON.stringify(item.name)}: ${JSON.stringify(curator)} is already the curator of this board project`,
            });
          }
          curator ??= item.name;
        });
      })
      .default([])
      .describe(
        'Spur projects whose sessions work on this board project, each with a role; at most one curator. An operator listed here replaces the top-level spurProjects operator for this project. Board commands from a session whose Spur project is in no spurProjects list, here or top-level, are refused.',
      ),
    columns: z
      .array(columnConfig)
      .superRefine(checkBoard)
      .default(() =>
        COLUMNS.map(({ id, defaultEnabled }) => ({
          id,
          enabled: defaultEnabled,
          orchestrator: 'none',
          cycleLimit: DEFAULT_CYCLE_LIMIT,
          courseCheck: DEFAULT_COURSE_CHECK,
        })),
      )
      .describe(
        "The project's board columns in canonical order. todo, dev and done must be present and enabled. A column left out or disabled is skipped. Without this key, every built-in column is enabled with orchestrator none except triage, listed disabled. todo, triage and ready-for-dev form the Todo group: the dispatcher never moves a task between them.",
      ),
    dispatcher: z
      .strictObject({
        mode: z
          .enum(DISPATCHER_MODES)
          .default('shadow')
          .describe(
            'shadow: the board evaluates the column gates and records where each task would go in its shadow column, and opens no turn, doorbell or block; the column executor submits with the task key. on: the board moves the task between columns, hands the column executor a turn, and raises the cycle-limit and course-check blocks.',
          ),
        submitConfirmMs: durationMs(
          180_000,
          'How long the board waits to confirm a turn submit it accepted pending (no PR linked yet, or GitHub not confirming the head) before handing the turn back to its executor with the reason',
        ),
      })
      .prefault({})
      .describe(
        'How the board moves tasks between columns. The board records the mode it last ran with. The daemon reads the mode at start, so a change takes effect after a restart; a switch from shadow to on copies the shadow column of each task into its column, and a switch back to shadow closes the open turns and starts the shadow column from the column again.',
      ),
  })
  .superRefine((project, ctx) => {
    const watched = new Map<string, string>();
    project.approvalWatch?.forEach((entry, j) => {
      const name = entry.replace(/\/$/, '');
      const first = watched.get(name);
      if (first === undefined) {
        watched.set(name, entry);
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['approvalWatch', j],
        message: `Duplicate approvalWatch entry ${JSON.stringify(entry)}: ${JSON.stringify(first)} already names it`,
      });
    });
    const repos = new Set(project.repos.map((repo) => repo.toLowerCase()));
    project.reposWithoutCi.forEach((repo, j) => {
      if (repos.has(repo.toLowerCase())) return;
      ctx.addIssue({
        code: 'custom',
        path: ['reposWithoutCi', j],
        message: `Repository ${JSON.stringify(repo)} is not in repos`,
      });
    });
    if (!project.columns.some((column) => column.id === project.checksGate && column.enabled))
      ctx.addIssue({
        code: 'custom',
        path: ['checksGate'],
        message: `checksGate ${JSON.stringify(project.checksGate)} names a column that is absent or disabled: use one of ${CHECKS_GATE_COLUMNS.join(', ')} whose column is enabled`,
      });
    const spurNames = new Set(
      project.spurProjects
        .filter((p) => p.role === 'orchestrator' || p.role === 'curator')
        .map((p) => p.name),
    );
    project.columns.forEach(({ orchestrator }, j) => {
      if (orchestrator === 'none' || orchestrator === 'operator' || spurNames.has(orchestrator)) {
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['columns', j, 'orchestrator'],
        message: `Unknown orchestrator ${JSON.stringify(orchestrator)}: use none, operator or a spurProjects name with role orchestrator or curator`,
      });
    });
    project.columns.forEach(({ source }, j) => {
      if (typeof source !== 'object' || project.tracker.type === 'github-issues') return;
      ctx.addIssue({
        code: 'custom',
        path: ['columns', j, 'source'],
        message: `source type tracker needs a github-issues project: tracker ${JSON.stringify(project.tracker.type)} has no GitHub Project to mirror`,
      });
    });
    const curator = project.spurProjects.find((p) => p.role === 'curator')?.name;
    // `none` and `operator` are orchestrator sentinels, not Spur projects: a project with one of
    // those names orchestrates no column, so the check could never reach it.
    const orchestrators = new Set(
      project.columns
        .map((column) => column.orchestrator)
        .filter((name) => name !== 'none' && name !== 'operator'),
    );
    project.columns.forEach(({ courseCheckTo }, j) => {
      if (courseCheckTo === undefined || courseCheckTo === 'operator') return;
      const known = project.spurProjects.some((spur) => spur.name === courseCheckTo);
      if (known && (courseCheckTo === curator || orchestrators.has(courseCheckTo))) return;
      const name = JSON.stringify(courseCheckTo);
      ctx.addIssue({
        code: 'custom',
        path: ['columns', j, 'courseCheckTo'],
        message: known
          ? `courseCheckTo ${name} is not the curator and orchestrates no column: use operator, the curator or a column orchestrator`
          : `Unknown courseCheckTo ${name}: use operator or a spurProjects name`,
      });
    });
  });

/** A duration in integer milliseconds. Every duration key ends in `Ms`. */
function durationMs(fallback: number, description: string) {
  return z.int().min(1).default(fallback).describe(`${description} in milliseconds.`);
}

const MAX_POLL_INTERVAL_MS = 86_400_000;

/** Time between two polls, at most one day. */
function pollIntervalMs(fallback: number) {
  return z
    .int()
    .min(1)
    .max(MAX_POLL_INTERVAL_MS, 'Poll interval must be at most 86400000 ms (one day)')
    .default(fallback)
    .describe('Time between two polls in milliseconds.');
}

/** How often one adapter polls its source. */
function adapterSection(intervalMs: number) {
  return z.strictObject({ intervalMs: pollIntervalMs(intervalMs) }).prefault({});
}

const spurAdapterSection = z
  .strictObject({
    intervalMs: pollIntervalMs(15_000),
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .default('http://127.0.0.1:4310')
      .describe('Base URL of the local Spur HTTP API.'),
  })
  .prefault({});

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A Spur project can be listed under only one board project (#245). A session's actor is
 * `agent:<spur project>/<session>`, with no board project in it; its roles are looked up by Spur
 * project, and a curator ring picks a session by Spur project. The config is refused here rather
 * than resolving roles per board project, so every session has one owning board project.
 */
function rejectSharedSpurProjects(
  items: readonly z.output<typeof projectSchema>[],
  ctx: z.RefinementCtx,
): void {
  const owners = new Map<string, string>();
  items.forEach((project, i) => {
    project.spurProjects.forEach(({ name }, j) => {
      const owner = owners.get(name);
      if (owner === undefined) owners.set(name, project.id);
      else if (owner !== project.id) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'spurProjects', j, 'name'],
          message: `Spur project ${JSON.stringify(name)} is listed under board projects ${JSON.stringify(owner)} and ${JSON.stringify(project.id)}: list it under only one`,
        });
      }
    });
  });
}

/** A `shortName` addresses one Spur project, so it is unique across every board project. */
function rejectSharedShortNames(
  items: readonly z.output<typeof projectSchema>[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((project, i) => {
    project.spurProjects.forEach(({ shortName }, j) => {
      if (shortName === undefined) return;
      if (seen.has(shortName)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'spurProjects', j, 'shortName'],
          message: `Duplicate short name: ${JSON.stringify(shortName)}`,
        });
      }
      seen.add(shortName);
    });
  });
}

/** A Spur project bound for every board project at once, in top-level `spurProjects`. */
const boardWideEntry = z.strictObject({
  name: spurProject.shape.name.describe(
    'The name of the project in Spur. It must not also be listed under any projects[].spurProjects, and none and operator are reserved.',
  ),
  role: z
    .enum(['orchestrator', 'operator'])
    .describe(
      "orchestrator: sessions execute the listed columns in every board project that enables the column and leaves its orchestrator at none. operator: sessions act as the operator of every board project that lists no operator of its own; a project's own operator acts only in its project. At most one operator.",
    ),
  columns: z
    .array(columnId.describe('A built-in column this orchestrator executes.'))
    .optional()
    .describe(
      'Required for role orchestrator, not allowed for operator. The columns it executes board-wide. A project column whose orchestrator is set to anything but none keeps it, and a disabled column is never filled; it must fill at least one column in some board project.',
    ),
  shortName: spurProject.shape.shortName.describe(
    "The name the operator types as @<shortName> at the start of a new message in the orchestrators channel to start a conversation with this Spur project's live session. Unique across the board, top-level and projects[].spurProjects alike.",
  ),
  displayName: spurProject.shape.displayName.describe(
    "The name Slack messages this Spur project's sessions write are posted under. Defaults to the Spur project name.",
  ),
  icon: spurProject.shape.icon.describe(
    'The emoji shortcode, such as :owl:, shown on those messages instead of the role icon.',
  ),
});

type BoardWideEntry = z.output<typeof boardWideEntry>;

/** Checks within top-level `spurProjects`: R1 names, R2 reserved names, R3 shared columns, R6 operators, R8 columns. */
function checkBoardWide(items: readonly BoardWideEntry[], ctx: z.RefinementCtx): void {
  rejectDuplicates(items, 'name', 'spur project name', ctx);
  const bound = new Map<string, string>();
  let operator: string | undefined;
  items.forEach((item, i) => {
    if (item.name === 'none' || item.name === 'operator') {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'name'],
        message: `Spur project name ${JSON.stringify(item.name)} is reserved for columns[].orchestrator`,
      });
    }
    if (item.role === 'operator') {
      if (operator !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'role'],
          message: `Second board-wide operator ${JSON.stringify(item.name)}: ${JSON.stringify(operator)} is already the board-wide operator`,
        });
      }
      operator ??= item.name;
      if (item.columns !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'columns'],
          message: `Board-wide operator ${JSON.stringify(item.name)} takes no columns: remove columns, or bind the column to operator in projects[].columns`,
        });
      }
      return;
    }
    if (item.columns === undefined || item.columns.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'columns'],
        message: `Board-wide orchestrator ${JSON.stringify(item.name)} needs columns: list the columns it executes`,
      });
      return;
    }
    item.columns.forEach((column, j) => {
      if (item.columns?.indexOf(column) !== j) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'columns'],
          message: `Duplicate column: ${JSON.stringify(column)}`,
        });
        return;
      }
      const other = bound.get(column);
      if (other === undefined) bound.set(column, item.name);
      else {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'columns', j],
          message: `Column ${JSON.stringify(column)} is bound board-wide by ${JSON.stringify(other)} and ${JSON.stringify(item.name)}: bind it once`,
        });
      }
    });
  });
}

/** The board config file before the checks across its sections. */
const configObject = z.strictObject({
  projects: z
    .array(projectSchema)
    .min(1)
    .superRefine((items, ctx) => {
      rejectDuplicates(items, 'id', 'project id', ctx);
      rejectSharedSpurProjects(items, ctx);
      rejectSharedShortNames(items, ctx);
    })
    .describe(
      'Board projects, at least one. Each reads tasks from one tracker and PRs from its repos. A Spur project can be listed under only one board project; one that serves several goes in top-level spurProjects.',
    ),
  spurProjects: z
    .array(boardWideEntry)
    .superRefine(checkBoardWide)
    .default([])
    .describe(
      'Spur projects bound board-wide, each with role orchestrator or operator. A project-level binding wins for its own project. A Spur project here serves every board project it binds, and one of its sessions acts on the turns, inbox, questions and doorbells of each of them and no other.',
    ),
  operator: z.strictObject({
    slack: nonEmpty.describe(
      'Slack user ID of the operator, such as U0123456789. Slack commands, button presses and messages from anyone else are denied. A feed line the operator resolves names this user.',
    ),
  }),
  slack: z
    .strictObject({
      appName: z
        .string()
        .trim()
        .min(1)
        .default(DEFAULT_SLACK_APP_NAME)
        .describe(
          'Slack app and bot display name that board slack manifest writes when --app-name is not given.',
        ),
      command: z
        .string()
        .regex(/^\/[a-z0-9_-]+$/, 'Expected a slash command such as /board')
        .default(DEFAULT_SLACK_COMMAND)
        .describe(
          'Slash command with its leading slash. The board acts only on this command, and board slack manifest writes it when --command is not given. When slack.channels is set and SLACK_APP_CONFIG_TOKEN and slack.appId are present, board doctor compares it with the installed app.',
        ),
      appId: z
        .string()
        .regex(/^A[A-Z0-9]+$/, 'Expected a Slack app ID')
        .optional()
        .describe(
          "Slack app ID, such as A0123456789. When slack.channels is set and SLACK_APP_CONFIG_TOKEN is present, board doctor reads this app's manifest to check the installed slash command against slack.command.",
        ),
      channels: z
        .strictObject({
          orchestrators: nonEmpty
            .optional()
            .describe(
              'Slack channel ID, such as C0123456789, where the board opens a thread for each block addressed to the operator by someone else. Once either channel is set, the daemon does not start without the other channel and SLACK_BOT_TOKEN, and without SLACK_APP_TOKEN it reads nothing from Slack.',
            ),
          feed: nonEmpty
            .optional()
            .describe(
              'Slack channel ID where the board posts a line for each curator answer, each newly installed version, each revoked operator token, each `/board tokens` list and each operator item, with the buttons the operator presses. Operator items about failed Slack posts, transport health and undelivered answers, and those shown as operator blocks, get no feed line. A line whose item clears before it is first sent, such as an expired token request, is dropped. Set it together with orchestrators.',
            ),
        })
        .prefault({}),
      defaultAddressee: z
        .string()
        .optional()
        .describe(
          'The shortName, top-level or under projects[].spurProjects, of the Spur project that gets a new orchestrators-channel message which does not start with a known @<shortName>. Without it, such a message goes to the top-level spurProjects operator; without one, when any shortName is set, to the operator of the first board project that lists one; otherwise it gets one reply listing the valid prefixes, or is skipped when no shortName is configured.',
        ),
    })
    .prefault({}),
  thresholds: z
    .strictObject({
      staleMultiplier: z
        .number()
        .min(1)
        .default(3)
        .describe(
          'A source with no complete poll for this many of its poll intervals turns blind stale. board status marks that source, and an operator item whose fact is older than that, as stale.',
        ),
      blockOpenMs: durationMs(
        86_400_000,
        'How long a block may stay open before an item is raised',
      ),
    })
    .prefault({}),
  archive: z
    .strictObject({
      doneWeekday: z
        .enum(WEEKDAYS)
        .default('saturday')
        .describe(
          'Weekday whose local midnight, in digest.tz, is the weekly archive slot: tasks done before it are archived then, once their repos have a complete poll since their last change. A slot missed while the daemon was down is applied on the next tick.',
        ),
    })
    .prefault({}),
  digest: z.strictObject({
    tz: z
      .string()
      .refine(isTimeZone, 'Unknown IANA time zone')
      .describe(
        'IANA time zone, such as Europe/Berlin, for the archive.doneWeekday slot and the times shown in resolved feed lines.',
      ),
  }),
  commands: z
    .strictObject({
      retentionDays: z
        .int()
        .min(1)
        .default(7)
        .describe(
          "Days the board keeps each caller's mutation --key with its input and result. In that time the same caller and key with the same input returns the stored result, and with a different input the call is refused. A daily job deletes older keys.",
        ),
    })
    .prefault({}),
  operatorAccess: z
    .strictObject({
      unusedAfterDays: z
        .int()
        .min(1)
        .max(3650)
        .default(14)
        .describe(
          'Days an approved operator access key from board token create may go unused before board doctor warns about it.',
        ),
    })
    .prefault({}),
  doorbells: z
    .strictObject({
      firstRetryMs: durationMs(120_000, 'Wait after the first unanswered doorbell'),
      secondRetryMs: durationMs(300_000, 'Wait after the second unanswered doorbell'),
      unansweredAfterMs: durationMs(900_000, 'Wait after the third unanswered doorbell'),
    })
    .superRefine((pauses, ctx) => {
      if (pauses.secondRetryMs <= pauses.firstRetryMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['secondRetryMs'],
          message: 'Second retry pause must exceed the first retry pause',
        });
      }
      if (pauses.unansweredAfterMs <= pauses.secondRetryMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['unansweredAfterMs'],
          message: 'Final unanswered pause must exceed the second retry pause',
        });
      }
    })
    .prefault({}),
  http: z
    .strictObject({
      port: z
        .int()
        .min(0)
        .max(65_535)
        .default(DEFAULT_HTTP_PORT)
        .describe(
          "Local HTTP API port (0 assigns a free port). The default 4777 is above 4310-4399, a margin kept for Spur's server port 4310 and the ports from 4311 upward that its MCP port takes, and avoids Spur's ports 5555 and 8730-8799 and the Linux ephemeral range 32768-60999.",
        ),
    })
    .prefault({}),
  web: z
    .strictObject({
      port: z
        .int()
        .min(0)
        .max(65_535)
        .optional()
        .describe(
          'Optional web listener port (0 assigns a free port); omitted means off. Set together with publicOrigin. Must differ from http.port, including when both are 0.',
        ),
      publicOrigin: z
        .string()
        .optional()
        .describe(
          'Bare public HTTP/HTTPS origin for the web API; HTTP requires loopback. Set together with port. Every {port} is replaced with the listener port, including in hostnames. No trailing slash. The resolved origin must remain valid and HTTP loopback-only after actual-port substitution; the resolver returns no origin for an invalid actual port or resulting origin.',
        ),
      spurUiOrigin: concreteOrigin
        .optional()
        .describe(
          'Optional concrete bare origin for the Spur UI, independently of the web API. HTTP works on any host without voice; no placeholders or trailing slash. Unset or unreachable UI only warns in doctor and never blocks updates.',
        ),
    })
    .prefault({}),
  stand: z
    .strictObject({
      portRange: z
        .strictObject({
          min: z
            .int()
            .min(1024)
            .max(65_535)
            .default(DEFAULT_STAND_PORT_RANGE.min)
            .describe('Inclusive first stand port; defaults to 4780 when a range is supplied.'),
          max: z
            .int()
            .min(1024)
            .max(65_535)
            .default(DEFAULT_STAND_PORT_RANGE.max)
            .describe('Inclusive last stand port; defaults to 4799 when a range is supplied.'),
        })
        .optional()
        .describe(
          'Optional stand port range, effectively 4780..4799 when omitted. An explicit range (including {}) must exclude http.port and web.port; an omitted range preserves legacy configs and doctor warns on overlaps. pnpm stand takes its web port, and an explicit API port, from this range and refuses http.port and web.port.',
        ),
    })
    .prefault({}),
  adapters: z
    .strictObject({
      spur: spurAdapterSection,
      github: adapterSection(60_000),
      githubIssues: adapterSection(120_000),
      jira: adapterSection(120_000),
    })
    .prefault({}),
  sources: z
    .strictObject({
      authRetryMs: durationMs(900_000, 'Wait before polling a source again after an auth error'),
      goneAfterPolls: z
        .int()
        .min(1)
        .default(3)
        .describe('Complete polls an entity must be missing from before it counts as gone.'),
    })
    .prefault({}),
  github: z
    .strictObject({
      reserveRemaining: z
        .int()
        .min(0)
        .default(1000)
        .describe('GitHub API requests to leave unused in each quota window.'),
    })
    .prefault({}),
  health: z
    .strictObject({
      turnStallAfterMs: durationMs(
        600_000,
        'How long an unhealthy open-turn executor waits before a curator or operator block',
      ),
      errorAfterMs: durationMs(90_000, 'How long a session stays in error before it is flagged'),
      needsInputAfterMs: durationMs(
        120_000,
        'How long a session waits for input before it is flagged',
      ),
      idleInDevAfterMs: durationMs(
        1_800_000,
        'How long a worker session without an open PR, or the executor of a taken turn, waits at its prompt before it is flagged; an orchestrator turn uses its column quietTurnAfterMs when set',
      ),
      flipSmoothingMs: durationMs(
        30_000,
        'How long a new session health value must hold before it is reported',
      ),
      hostLoad: z
        .strictObject({
          sessions: z
            .int()
            .min(1)
            .default(3)
            .describe('Sessions entering error within the window that start an episode.'),
          windowMs: durationMs(
            60_000,
            'Window in which that many sessions entering error start a host-load episode',
          ),
          maxEpisodeMs: durationMs(
            300_000,
            'Longest a host-load episode lasts before error flags resume',
          ),
        })
        .prefault({}),
      turnWait: z
        .strictObject({
          maxWaits: z
            .int()
            .min(1)
            .default(8)
            .describe('Waits a turn may start, counted over its whole life.'),
          maxTotalMs: durationMs(7_200_000, 'Total time the waits of one turn may last'),
        })
        .prefault({}),
    })
    .prefault({}),
});

type ConfigObject = z.output<typeof configObject>;
type ProjectConfig = ConfigObject['projects'][number];
type SpurProjectConfig = ProjectConfig['spurProjects'][number];

/** The project's copy of a top-level entry: its role and Slack identity, without `columns`. */
function boardWideCopy(entry: BoardWideEntry): SpurProjectConfig {
  return {
    name: entry.name,
    role: entry.role,
    ...(entry.shortName === undefined ? {} : { shortName: entry.shortName }),
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
  };
}

/** Whether a board-wide orchestrator takes this column: listed, enabled and left at none. */
function fills(entry: BoardWideEntry, column: ProjectConfig['columns'][number]): boolean {
  return (
    column.enabled && column.orchestrator === 'none' && entry.columns?.includes(column.id) === true
  );
}

/**
 * One board project with the top-level entries applied: an orchestrator fills each listed
 * enabled column left at none, an operator joins a project without its own. Each entry that
 * binds the project is appended to its `spurProjects`.
 */
function expandProject(project: ProjectConfig, entries: readonly BoardWideEntry[]): ProjectConfig {
  const ownOperator = project.spurProjects.some((spur) => spur.role === 'operator');
  let columns = project.columns;
  const added: SpurProjectConfig[] = [];
  for (const entry of entries) {
    if (entry.role === 'operator') {
      if (!ownOperator) added.push(boardWideCopy(entry));
      continue;
    }
    if (!columns.some((column) => fills(entry, column))) continue;
    columns = columns.map((column) =>
      fills(entry, column) ? { ...column, orchestrator: entry.name } : column,
    );
    added.push(boardWideCopy(entry));
  }
  if (added.length === 0) return project;
  return { ...project, columns, spurProjects: [...project.spurProjects, ...added] };
}

function expandBoardWide(config: ConfigObject): ConfigObject {
  if (config.spurProjects.length === 0) return config;
  return {
    ...config,
    projects: config.projects.map((project) => expandProject(project, config.spurProjects)),
  };
}

/** Checks between top-level `spurProjects` and the board projects: R4, R5, R7 and R9. */
function checkBoardWideAgainstProjects(config: ConfigObject, ctx: z.RefinementCtx): void {
  const entries = config.spurProjects;
  if (entries.length === 0) return;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  config.projects.forEach((project, i) => {
    project.spurProjects.forEach((spur, j) => {
      if (!byName.has(spur.name)) return;
      ctx.addIssue({
        code: 'custom',
        path: ['projects', i, 'spurProjects', j, 'name'],
        message: `Spur project ${JSON.stringify(spur.name)} is bound board-wide in spurProjects and listed under projects[${project.id}].spurProjects as ${spur.role}: remove one; a board-wide Spur project serves every board project it binds`,
      });
    });
  });
  const projectShortNames = new Set(
    config.projects.flatMap((project) => project.spurProjects.map((spur) => spur.shortName)),
  );
  const shortNames = new Set<string>();
  entries.forEach((entry, i) => {
    const name = JSON.stringify(entry.name);
    if (entry.role === 'orchestrator') {
      if (!config.projects.some((project) => project.columns.some((c) => fills(entry, c)))) {
        ctx.addIssue({
          code: 'custom',
          path: ['spurProjects', i, 'columns'],
          message: `Board-wide orchestrator ${name} executes no column: in every board project each listed column is missing, disabled or bound to another orchestrator`,
        });
      }
    } else if (
      config.projects.every((project) =>
        project.spurProjects.some((spur) => spur.role === 'operator'),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['spurProjects', i, 'name'],
        message: `Board-wide operator ${name} serves no board project: every board project lists its own operator`,
      });
    }
    const { shortName } = entry;
    if (shortName === undefined) return;
    if (shortNames.has(shortName) || projectShortNames.has(shortName)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spurProjects', i, 'shortName'],
        message: `Duplicate short name: ${JSON.stringify(shortName)}`,
      });
    }
    shortNames.add(shortName);
  });
}

/** Whether a column, before board-wide expansion, is enabled and taken by a named Spur project. */
function namedOrchestratorColumn(
  config: ConfigObject,
  column: ProjectConfig['columns'][number],
): boolean {
  if (!column.enabled || column.orchestrator === 'operator') return false;
  if (column.orchestrator !== 'none') return true;
  return config.spurProjects.some((entry) => entry.role !== 'operator' && fills(entry, column));
}

/** `quietTurnAfterMs` and `noRecipientAfterMs` only on enabled named-orchestrator columns. */
function checkTurnTimings(config: ConfigObject, ctx: z.RefinementCtx): void {
  config.projects.forEach((project, i) => {
    const allowed = project.columns
      .filter((column) => namedOrchestratorColumn(config, column))
      .map((column) => column.id);
    project.columns.forEach((column, j) => {
      if (namedOrchestratorColumn(config, column)) return;
      for (const key of TURN_TIMING_KEYS) {
        if (column[key] === undefined) continue;
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'columns', j, key],
          message: `${key} is allowed only on an enabled column with a named orchestrator: ${
            allowed.length === 0
              ? `project ${project.id} has none`
              : `in project ${project.id} use one of ${allowed.join(', ')}`
          }`,
        });
      }
    });
  });
}

/**
 * The board config file. Every object rejects unknown keys; no key holds a secret. The parsed
 * value has top-level `spurProjects` applied to every board project's columns and
 * `spurProjects` (`expandBoardWide`), so readers of `projects[]` see the effective bindings.
 */
export const configSchema = configObject
  .superRefine(checkBoardWideAgainstProjects)
  .superRefine(checkTurnTimings)
  .superRefine((config, ctx) => {
    const { web } = config;
    if (web.publicOrigin !== undefined && !validOrigin(web.publicOrigin, web.port)) {
      ctx.addIssue({ code: 'custom', path: ['web', 'publicOrigin'], message: originError });
    }
    if ((web.port === undefined) !== (web.publicOrigin === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['web', web.port === undefined ? 'port' : 'publicOrigin'],
        message: 'Set web.port and web.publicOrigin together',
      });
    }
    if (web.port !== undefined && web.port === config.http.port) {
      ctx.addIssue({
        code: 'custom',
        path: ['web', 'port'],
        message: 'Web port must differ from http.port',
      });
    }
    const range = config.stand.portRange;
    if (range !== undefined) {
      if (range.min > range.max) {
        ctx.addIssue({
          code: 'custom',
          path: ['stand', 'portRange', 'max'],
          message: 'Range maximum must be at least its minimum',
        });
      }
      for (const [field, port] of [
        ['http', config.http.port],
        ['web', web.port],
      ] as const) {
        if (port !== undefined && port >= range.min && port <= range.max) {
          ctx.addIssue({
            code: 'custom',
            path: ['stand', 'portRange'],
            message: `Stand port range includes ${field}.port ${String(port)}`,
          });
        }
      }
    }
    const addressee = config.slack.defaultAddressee;
    if (addressee === undefined) return;
    const known =
      config.spurProjects.some(({ shortName }) => shortName === addressee) ||
      config.projects.some((project) =>
        project.spurProjects.some(({ shortName }) => shortName === addressee),
      );
    if (!known) {
      ctx.addIssue({
        code: 'custom',
        path: ['slack', 'defaultAddressee'],
        message: `Unknown short name ${JSON.stringify(addressee)}: set it as spurProjects[].shortName or projects[].spurProjects[].shortName first`,
      });
    }
  })
  .overwrite(expandBoardWide);

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/**
 * Resolve validated web settings without mutation or I/O. Returns undefined when off, or when
 * the effective port is not an integer in 0..65535 or its substituted origin violates the
 * config origin policy. Invalid overrides never expose a URL parser error or unsafe origin.
 */
export function resolveWebOrigin(web: Config['web'], actualPort?: number): string | undefined {
  if (web.port === undefined || web.publicOrigin === undefined) return undefined;
  const port = actualPort ?? web.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return undefined;
  if (!validOrigin(web.publicOrigin, port)) return undefined;
  return new URL(web.publicOrigin.replaceAll('{port}', String(port))).origin;
}

/** The top-level `spurProjects` entry named `name`: a Spur project bound board-wide. */
export function boardWideSpurProject(
  config: Config,
  name: string,
): Config['spurProjects'][number] | undefined {
  return config.spurProjects.find((entry) => entry.name === name);
}

/** The turn timings of a column a named Spur project orchestrates. */
export interface ColumnTurnTimings {
  /** The Spur project that takes the column's turns. */
  readonly orchestrator: string;
  readonly quietTurnAfterMs: number;
  readonly noRecipientAfterMs: number;
}

/**
 * The effective turn timings of a project column, defaults applied; null when the column is
 * missing, disabled or not taken by a named Spur project.
 */
export function columnTurnTimings(
  config: Config,
  projectId: string,
  column: string,
): ColumnTurnTimings | null {
  const entry = config.projects
    .find((project) => project.id === projectId)
    ?.columns.find((candidate) => candidate.id === column);
  if (
    entry === undefined ||
    !entry.enabled ||
    entry.orchestrator === 'none' ||
    entry.orchestrator === 'operator'
  )
    return null;
  return {
    orchestrator: entry.orchestrator,
    quietTurnAfterMs: entry.quietTurnAfterMs ?? config.health.idleInDevAfterMs,
    noRecipientAfterMs: entry.noRecipientAfterMs ?? DEFAULT_NO_RECIPIENT_AFTER_MS,
  };
}

/** The Spur project a new orchestrators-channel message without a known prefix goes to. */
export interface DefaultAddressee {
  readonly spurProject: string;
  readonly source: AddresseeSource;
}

/**
 * `slack.defaultAddressee`; else the board-wide operator; else, once any shortName is set, the
 * operator of the first board project that lists one; else null.
 */
export function defaultAddressee(config: Config): DefaultAddressee | null {
  const projectSpurs = config.projects.flatMap((project) => project.spurProjects);
  const named = config.slack.defaultAddressee;
  if (named !== undefined) {
    const spur = [...config.spurProjects, ...projectSpurs].find(
      ({ shortName }) => shortName === named,
    );
    if (spur !== undefined) return { spurProject: spur.name, source: 'config' };
  }
  const boardWide = config.spurProjects.find((entry) => entry.role === 'operator');
  if (boardWide !== undefined) return { spurProject: boardWide.name, source: 'board-wide' };
  const shortNames = [...config.spurProjects, ...projectSpurs].some(
    ({ shortName }) => shortName !== undefined,
  );
  if (!shortNames) return null;
  const operator = projectSpurs.find((spur) => spur.role === 'operator');
  return operator === undefined ? null : { spurProject: operator.name, source: 'project' };
}

export interface ColumnBinding {
  readonly project: string;
  readonly column: ColumnId;
  readonly orchestrator: string;
  readonly source: ColumnBindingSource;
}

export interface OperatorBinding {
  readonly project: string;
  readonly operator: string;
  readonly source: OperatorBindingSource;
}

export interface ConfigBindings {
  readonly columns: ColumnBinding[];
  readonly operators: OperatorBinding[];
  readonly defaultAddressee: DefaultAddressee | null;
}

/**
 * The effective column orchestrators and operators of `projects`, in config order, and the
 * default Slack addressee. Columns that are disabled or left at none have no row; a project
 * operator acts only in the project that lists it (`isOperator`).
 */
export function configBindings(config: Config, projects: ReadonlySet<string>): ConfigBindings {
  const source = (name: string) =>
    boardWideSpurProject(config, name) === undefined ? 'project' : 'board-wide';
  const operatorsOf = (project: Config['projects'][number]) =>
    project.spurProjects.filter((spur) => spur.role === 'operator');
  const served = config.projects.filter((project) => projects.has(project.id));
  return {
    columns: served.flatMap((project) =>
      project.columns
        .filter((column) => column.enabled && column.orchestrator !== 'none')
        .map((column) => ({
          project: project.id,
          column: column.id,
          orchestrator: column.orchestrator,
          source: source(column.orchestrator),
        })),
    ),
    operators: served.flatMap((project) =>
      operatorsOf(project).map((spur): OperatorBinding => ({
        project: project.id,
        operator: spur.name,
        source: source(spur.name),
      })),
    ),
    defaultAddressee: defaultAddressee(config),
  };
}

/** Recognized names in the private secrets.env file; values never belong in config.yaml. */
export const SECRET_ENV_KEYS = [
  {
    name: 'GITHUB_TOKEN',
    requiredWhen: 'always',
    purpose:
      'Read GitHub repositories and check runs; also read:project when a ready-for-dev column mirrors a GitHub Project.',
  },
  { name: 'JIRA_EMAIL', requiredWhen: 'jira', purpose: 'Jira account email.' },
  { name: 'JIRA_API_TOKEN', requiredWhen: 'jira', purpose: 'Jira API token.' },
  { name: 'SLACK_BOT_TOKEN', requiredWhen: 'slack', purpose: 'Slack bot Web API token.' },
  { name: 'SLACK_APP_TOKEN', requiredWhen: 'slack', purpose: 'Slack app-level Socket Mode token.' },
  {
    name: 'SLACK_APP_CONFIG_TOKEN',
    requiredWhen: 'optional',
    purpose: 'Verify the installed slash command through the Slack app manifest API.',
  },
  {
    name: 'SLACK_API_URL',
    requiredWhen: 'optional',
    purpose:
      'Override the Slack API URL for local testing. https:, or http: only on a loopback host.',
  },
] as const;

export function requiredSecretKeys(config: Config): string[] {
  const jira = config.projects.some((project) => project.tracker.type === 'jira');
  const slack = Boolean(config.slack.channels.feed || config.slack.channels.orchestrators);
  return SECRET_ENV_KEYS.filter(
    ({ requiredWhen }) =>
      requiredWhen === 'always' ||
      (requiredWhen === 'jira' && jira) ||
      (requiredWhen === 'slack' && slack),
  ).map(({ name }) => name);
}

/** The JSON Schema committed as `packages/contracts/config.schema.json`. */
export function configJsonSchema() {
  return z.toJSONSchema(configSchema, { io: 'input' });
}
