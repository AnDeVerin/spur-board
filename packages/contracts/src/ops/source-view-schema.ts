import { z } from 'zod';
import { MIRROR_FAILURE_CODES } from '../adapters.ts';
import { commitShaSchema, webUrl } from '../facts.ts';

/** The stored colour of a repository's default branch, as status.get shows it. */
export const defaultBranchViewSchema = z
  .strictObject({
    branch: z.string().min(1).describe('Name of the default branch.'),
    state: z.enum(['red', 'green']).describe('Last settled colour read for the default branch.'),
    sha: commitShaSchema.describe(
      'Checked commit when this colour was first read. While red, the first red commit.',
    ),
    since: z.iso.datetime().describe('When the board first read this colour.'),
    confirmedAt: z.iso
      .datetime()
      .describe(
        'When a poll last read this colour, including via a checked parent of an unchecked head. A poll without a settled result keeps this time.',
      ),
    check: z.string().min(1).nullable().describe('Name of the first failing check, or null.'),
    url: webUrl.nullable().describe('Web URL of the failing run, or null.'),
  })
  .describe(
    'Colour of the newest commit with counted checks among the default-branch head and its seven nearest first parents. Red means a failed commit status or a latest push-triggered workflow check with a completed result other than success, neutral or skipped. Scheduled, manual and non-workflow checks are ignored, and branch protection is not read. Each settled read updates the colour used by the operator item. A poll without a settled result keeps the stored colour and operator item.',
  );
export type DefaultBranchView = z.output<typeof defaultBranchViewSchema>;

export const sourceViewSchema = z
  .strictObject({
    pointsLastHour: z
      .int()
      .nonnegative()
      .optional()
      .describe('Reported source points consumed during the preceding hour.'),
    source: z.string().min(1).describe('Adapter source identifier.'),
    project: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Board project whose tracker or repository this source polls; null for the shared spur source.',
      ),
    observedAt: z.iso.datetime().nullable().describe('Time of the latest observation, if any.'),
    lastCompleteAt: z.iso
      .datetime()
      .nullable()
      .describe('Time of the latest complete observation.'),
    blindReason: z
      .enum(['auth', 'config', 'stale'])
      .nullable()
      .describe('Why this source is blind, or null when it is usable.'),
    message: z.string().nullable().describe('Short explanation of the source state.'),
    failure: z
      .strictObject({
        code: z.enum(MIRROR_FAILURE_CODES).describe('Mirror failure code.'),
        message: z.string().min(1).describe('What the last poll failed on.'),
      })
      .nullable()
      .optional()
      .describe(
        'Why the last poll failed, or null after a delivered batch; present only on github-project: sources.',
      ),
    budget: z
      .strictObject({
        remaining: z.int().nonnegative().describe('Requests or points the source still allowed.'),
        limit: z
          .int()
          .positive()
          .nullable()
          .describe('Full budget the source restores at reset, or null when it reported none.'),
        resetAt: z.iso.datetime().describe('When the source said it restores the full budget.'),
      })
      .nullable()
      .describe(
        'Request budget from the last poll of this source that reported one, or null when none did.',
      ),
    stale: z.boolean().describe('Whether facts from this source exceed their freshness threshold.'),
    waitsForBudget: z
      .boolean()
      .describe(
        "Whether the daemon's adapter runner has put off this source's next regular poll for a rate limit: the last regular poll in this daemon run either reported a budget under github.reserveRemaining (GitHub sources, complete or not) or failed as throttled, with or without a retry time (any source), or failed in any other way while the last budget a poll of this run reported, an on-demand refresh included, is under github.reserveRemaining with a future reset (this case also ends at that reset), and the paused poll has not started yet. Held in memory, so false after a restart until a poll pauses again; a stored budget or an on-demand refresh never sets it.",
      ),
    healthySince: z.iso
      .datetime()
      .nullable()
      .describe(
        'When this source became usable (not blind) in this daemon run: its first non-blind observation since daemon start or since it was last blind. Stale, warming-up or budget-wait spells that did not make it blind do not move it. Null while blind or before that observation. Resets when the daemon restarts; compare with daemon.startedAt.',
      ),
    warmingUp: z
      .boolean()
      .describe('Whether this source needs a complete poll in this daemon run.'),
    defaultBranch: defaultBranchViewSchema
      .nullable()
      .optional()
      .describe(
        'GitHub pull request sources only. The stored default-branch colour from the newest checked commit in the poll window, or null until a poll reads a settled result.',
      ),
  })
  .describe('Freshness and availability of one source.');
