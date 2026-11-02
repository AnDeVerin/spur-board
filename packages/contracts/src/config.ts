import { z } from 'zod';
import { COLUMN_IDS, REQUIRED_COLUMN_IDS } from './enums.ts';

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
const repoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Expected owner/name');

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
});

const githubIssuesTracker = z
  .strictObject({
    type: z.literal('github-issues'),
    repo: repoSlug,
    label: nonEmpty.optional(),
    milestone: nonEmpty.optional(),
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
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Expected lowercase letters, digits and dashes'),
    tracker: z.discriminatedUnion('type', [jiraTracker, githubIssuesTracker]),
    repos: z.array(repoSlug).min(1),
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
  thresholds: z.strictObject({ staleMultiplier: z.number().min(1).default(3) }).prefault({}),
  archive: z.strictObject({ doneWeekday: z.enum(WEEKDAYS).default('saturday') }).prefault({}),
  digest: z.strictObject({ tz: z.string().refine(isTimeZone, 'Unknown IANA time zone') }),
  commands: z.strictObject({ retentionDays: z.int().min(1).default(7) }).prefault({}),
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/** The JSON Schema committed as `packages/contracts/config.schema.json`. */
export function configJsonSchema() {
  return z.toJSONSchema(configSchema, { io: 'input' });
}
