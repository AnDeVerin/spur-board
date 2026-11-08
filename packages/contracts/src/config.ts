import { z } from 'zod';
import { COLUMN_IDS, REQUIRED_COLUMN_IDS } from './enums.ts';

export const DEFAULT_HTTP_PORT = 4311;
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

/** Default `tracker.branchPattern`: the number in `<agent>-<number>-<slug>` branch names. */
const DEFAULT_BRANCH_PATTERN = '^[A-Za-z][A-Za-z0-9]*-([1-9][0-9]{0,14})(?:-|$)';

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

const QUANTIFIER = /\*|\+|\?|\{(\d+)(?:(,)(\d*))?\}/y;

/**
 * Whether a pattern that already compiles can backtrack super-linearly or reads outside plain
 * matching: a back-reference (`\1`, `\k<name>`), a lookaround, a group repeated more than
 * once whose body holds a quantifier or an alternation (`(a+)+`, `(a|aa)+`, `(a*){3}`), or more
 * than two quantifiers that repeat more than once (`.*.*.*`), counted over the whole pattern.
 * With at most two such repeats a match on a branch of at most 255 characters costs about n^2
 * steps. The check is conservative: it also refuses harmless forms such as `(a|b)+`.
 */
function backtracks(pattern: string): boolean {
  // One entry per open group, the root first: whether its body holds a quantifier or `|`.
  const open = [false];
  const mark = () => {
    open[open.length - 1] = true;
  };
  let i = 0;
  let repeated = 0;
  // Reads a quantifier at `i`; returns whether it repeats more than once, `undefined` if none.
  const quantifier = (): boolean | undefined => {
    QUANTIFIER.lastIndex = i;
    const match = QUANTIFIER.exec(pattern);
    if (match === null) return undefined;
    i = QUANTIFIER.lastIndex;
    if (pattern[i] === '?') i += 1;
    const [token, min, comma, max] = match;
    let repeats: boolean;
    if (token === '?') repeats = false;
    else if (min === undefined) repeats = true;
    else if (comma === undefined) repeats = Number(min) > 1;
    else repeats = max === '' || Number(max) > 1;
    if (repeats) repeated += 1;
    return repeats;
  };
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '\\') {
      if (/[1-9k]/.test(pattern[i + 1] ?? '')) return true;
      i += 2;
    } else if (char === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (char === '(') {
      if (/^\(\?<?[=!]/.test(pattern.slice(i))) return true;
      open.push(false);
      i =
        pattern[i + 1] === '?' ? pattern.indexOf(pattern[i + 2] === '<' ? '>' : ':', i) + 1 : i + 1;
      continue;
    } else if (char === ')') {
      const risky = open.pop() ?? false;
      i += 1;
      const repeats = quantifier();
      if (repeats === true && risky) return true;
      if (risky || repeats !== undefined) mark();
      continue;
    } else {
      if (char === '|') mark();
      i += 1;
      if (char === '|' || char === '^' || char === '$') continue;
    }
    if (quantifier() !== undefined) mark();
  }
  return repeated > 2;
}

const branchPattern = nonEmpty
  .superRefine((pattern, ctx) => {
    if (captureGroups(pattern) !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Expected a regular expression with exactly one capture group',
      });
    else if (backtracks(pattern))
      ctx.addIssue({
        code: 'custom',
        message:
          'Expected a regular expression with at most two repeated parts and no nested quantifiers, back-references or lookarounds',
      });
  })
  .default(DEFAULT_BRANCH_PATTERN)
  .describe(
    'Regular expression whose one capture group reads the issue number from a PR head branch, such as <agent>-<number>-<slug>. Used only when the PR has no closing issue reference in the tracker repository; PRs to a non-default base branch rely on it. At most two repeated parts (such as *, + or {2,}); no nested or alternated repeats, back-references or lookarounds. Branches longer than 255 characters are skipped.',
  );

const githubIssuesTracker = z
  .strictObject({
    type: z.literal('github-issues'),
    repo: repoSlugSchema,
    label: nonEmpty.optional(),
    milestone: nonEmpty.optional(),
    branchPattern,
  })
  .superRefine((tracker, ctx) => {
    if ((tracker.label === undefined) === (tracker.milestone === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'Set exactly one of label or milestone',
      });
    }
  });

const spurProject = z.strictObject({
  name: nonEmpty,
  role: z.enum(['worker', 'operator']),
});

const columnConfig = z.strictObject({
  id: z.enum(COLUMN_IDS, {
    error: (issue) =>
      typeof issue.input === 'string'
        ? `Unknown column ${JSON.stringify(issue.input)}: custom columns arrive with custom matchers and are not supported yet. Built-in columns: ${COLUMN_IDS.join(', ')}`
        : undefined,
  }),
  enabled: z.boolean().default(true),
  orchestrator: nonEmpty.default('none'),
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
    operatorGithubLogin: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'Expected a GitHub login'),
    spurProjects: z
      .array(spurProject)
      .superRefine((items, ctx) => {
        rejectDuplicates(items, 'name', 'spur project name', ctx);
      })
      .default([]),
    columns: z
      .array(columnConfig)
      .superRefine(checkBoard)
      .default(() => COLUMN_IDS.map((id) => ({ id, enabled: true, orchestrator: 'none' }))),
  })
  .superRefine((project, ctx) => {
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

/** The board config file. Every object rejects unknown keys; no key holds a secret. */
export const configSchema = z.strictObject({
  projects: z
    .array(projectSchema)
    .min(1)
    .superRefine((items, ctx) => {
      rejectDuplicates(items, 'id', 'project id', ctx);
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
        .describe('Local HTTP API port (0 assigns a free port).'),
    })
    .prefault({}),
  adapters: z
    .strictObject({
      spur: spurAdapterSection,
      github: adapterSection(60_000),
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
        'How long a worker session without an open PR waits at its prompt before it is flagged',
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
