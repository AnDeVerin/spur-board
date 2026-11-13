import { z } from 'zod';
import { COLUMN_IDS, DISPATCHER_MODES, REQUIRED_COLUMN_IDS } from './enums.ts';

/**
 * The daemon's default loopback port. It sits above 4310-4399, a margin the board keeps for
 * Spur's server port 4310 and the ports from 4311 upward that Spur's MCP port takes. It also
 * avoids Spur's web UI port 5555, its Playwright sidecars 8730-8799 and the Linux ephemeral
 * range 32768-60999.
 */
export const DEFAULT_HTTP_PORT = 4777;
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

const jiraTracker = z.strictObject({
  type: z.literal('jira'),
  baseUrl: z.url({ protocol: /^https?$/ }),
  jql: nonEmpty,
  doneStatuses: z.array(nonEmpty).min(1),
  readyStatuses: z.array(nonEmpty).min(1),
  projectKeys: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Expected a Jira project key like PROJ'))
    .default([]),
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
    type: z.literal('github-issues'),
    repo: repoSlugSchema,
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
    .enum(['worker', 'operator', 'curator'])
    .describe(
      "worker: sessions of this Spur project may link to this project's tasks through their PR or branch. operator: sessions act as the operator. curator: sessions answer the questions no column orchestrator takes and escalate the rest to the operator; a board project has at most one.",
    ),
});

const DEFAULT_CYCLE_LIMIT = 10;

const columnConfig = z.strictObject({
  id: z.enum(COLUMN_IDS, {
    error: (issue) =>
      typeof issue.input === 'string'
        ? `Unknown column ${JSON.stringify(issue.input)}: custom columns arrive with custom matchers and are not supported yet. Built-in columns: ${COLUMN_IDS.join(', ')}`
        : undefined,
  }),
  enabled: z.boolean().default(true),
  orchestrator: nonEmpty.default('none'),
  cycleLimit: z
    .int()
    .min(1)
    .default(DEFAULT_CYCLE_LIMIT)
    .describe(
      'How many times a task may return to Dev from this column before the board stops it for the operator. Returns by the column executor, changes requested and external comments count; a conflict, red CI and a draft do not.',
    ),
});

type ColumnConfig = z.output<typeof columnConfig>;

/** The board rules: required columns present and enabled, built-ins in canonical order. */
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

const projectSchema = z
  .strictObject({
    id: z
      .string()
      .refine((id) => id !== RESERVED_PROJECT, {
        message: `"${RESERVED_PROJECT}" is reserved for board-wide journal events; choose another project id`,
        abort: true,
      })
      .regex(/^[a-z][a-z0-9-]*$/, 'Expected lowercase letters, digits and dashes'),
    tracker: z.discriminatedUnion('type', [jiraTracker, githubIssuesTracker]),
    repos: z.array(repoSlugSchema).min(1),
    reposWithoutCi: z
      .array(repoSlugSchema)
      .default([])
      .describe(
        'Repos from repos that run no CI checks, in any letter case. In a listed repo, a PR whose check list on head is empty passes the Dev gate check condition instead of waiting in Dev. A list of only skipped checks still waits, and red or pending checks still count. A listed repo whose branch protection requires checks that have not reported yet also passes, so list only repos that run no checks. Without this key, a PR with no checks waits in Dev.',
      ),
    link: z
      .strictObject({
        sources: z
          .array(z.enum(LINK_SOURCES))
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
        "The GitHub account agents open PRs under. PR discovery in repos keeps only PRs whose author is this login. It is not necessarily the maintainer's own account: when agents push as one account and a maintainer approves as another, set the agents' account, or no PR is discovered.",
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
      .default([]),
    columns: z
      .array(columnConfig)
      .superRefine(checkBoard)
      .default(() =>
        COLUMN_IDS.map((id) => ({
          id,
          enabled: true,
          orchestrator: 'none',
          cycleLimit: DEFAULT_CYCLE_LIMIT,
        })),
      ),
    dispatcher: z
      .strictObject({
        mode: z
          .enum(DISPATCHER_MODES)
          .default('shadow')
          .describe(
            'shadow: the board evaluates the column gates and records where each task would go in its shadow column, and opens no turn, doorbell or block; the column executor submits with the task key. on: the board moves the task between columns, hands the column executor a turn and raises the cycle-limit block.',
          ),
      })
      .prefault({})
      .describe(
        'How the board moves tasks between columns. The board records the mode it last ran with. The daemon reads the mode at start, so a change takes effect after a restart; a switch from shadow to on copies the shadow column of each task into its column, and a switch back to shadow starts the shadow column from the column again.',
      ),
  })
  .superRefine((project, ctx) => {
    const repos = new Set(project.repos.map((repo) => repo.toLowerCase()));
    project.reposWithoutCi.forEach((repo, j) => {
      if (repos.has(repo.toLowerCase())) return;
      ctx.addIssue({
        code: 'custom',
        path: ['reposWithoutCi', j],
        message: `Repository ${JSON.stringify(repo)} is not in repos`,
      });
    });
    const spurNames = new Set(project.spurProjects.map((p) => p.name));
    project.columns.forEach(({ orchestrator }, j) => {
      if (orchestrator === 'none' || orchestrator === 'operator' || spurNames.has(orchestrator)) {
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['columns', j, 'orchestrator'],
        message: `Unknown orchestrator ${JSON.stringify(orchestrator)}: use none, operator or a spurProjects name`,
      });
    });
  });

/** A duration in integer milliseconds. Every duration key ends in `Ms`. */
function durationMs(fallback: number, description: string) {
  return z.int().min(1).default(fallback).describe(`${description} in milliseconds.`);
}

/** How often one adapter polls its source. */
function adapterSection(intervalMs: number) {
  return z
    .strictObject({ intervalMs: durationMs(intervalMs, 'Time between two polls') })
    .prefault({});
}

const spurAdapterSection = z
  .strictObject({
    intervalMs: durationMs(15_000, 'Time between two polls'),
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

/** A session belongs to one board project, so a Spur project can be listed under only one. */
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

/** The board config file. Every object rejects unknown keys; no key holds a secret. */
export const configSchema = z.strictObject({
  projects: z
    .array(projectSchema)
    .min(1)
    .superRefine((items, ctx) => {
      rejectDuplicates(items, 'id', 'project id', ctx);
      rejectSharedSpurProjects(items, ctx);
    }),
  operator: z.strictObject({ slack: nonEmpty }),
  slack: z
    .strictObject({
      appName: z.string().trim().min(1).default(DEFAULT_SLACK_APP_NAME),
      command: z
        .string()
        .regex(/^\/[a-z0-9_-]+$/, 'Expected a slash command such as /board')
        .default(DEFAULT_SLACK_COMMAND),
      appId: z
        .string()
        .regex(/^A[A-Z0-9]+$/, 'Expected a Slack app ID')
        .optional(),
      channels: z
        .strictObject({
          orchestrators: nonEmpty.optional(),
          feed: nonEmpty.optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  thresholds: z
    .strictObject({
      staleMultiplier: z.number().min(1).default(3),
      blockOpenMs: durationMs(
        86_400_000,
        'How long a block may stay open before an item is raised',
      ),
    })
    .prefault({}),
  archive: z.strictObject({ doneWeekday: z.enum(WEEKDAYS).default('saturday') }).prefault({}),
  digest: z.strictObject({ tz: z.string().refine(isTimeZone, 'Unknown IANA time zone') }),
  commands: z.strictObject({ retentionDays: z.int().min(1).default(7) }).prefault({}),
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
      errorAfterMs: durationMs(90_000, 'How long a session stays in error before it is flagged'),
      needsInputAfterMs: durationMs(
        120_000,
        'How long a session waits for input before it is flagged',
      ),
      idleInDevAfterMs: durationMs(
        1_800_000,
        'How long a worker session without an open PR, or the executor of a taken turn, waits at its prompt before it is flagged',
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
    })
    .prefault({}),
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/** Recognized names in the private secrets.env file; values never belong in config.yaml. */
export const SECRET_ENV_KEYS = [
  {
    name: 'GITHUB_TOKEN',
    requiredWhen: 'always',
    purpose: 'Read GitHub repositories and check runs.',
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
    purpose: 'Override the Slack API URL for local testing.',
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
