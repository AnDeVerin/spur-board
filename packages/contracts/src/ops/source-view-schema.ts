import { z } from 'zod';
import { commitShaSchema, webUrl } from '../facts.ts';

/** The stored colour of a repository's default-branch head, as status.get shows it. */
export const defaultBranchViewSchema = z
  .strictObject({
    branch: z.string().min(1).describe('Name of the default branch.'),
    state: z.enum(['red', 'green']).describe('Colour of the default-branch head.'),
    sha: commitShaSchema.describe(
      'Head commit when this colour was first read; while red, the first red commit.',
    ),
    since: z.iso.datetime().describe('When the board first read this colour.'),
    confirmedAt: z.iso
      .datetime()
      .describe('When a poll last read this colour; a poll that reads no colour keeps it.'),
    check: z.string().min(1).nullable().describe('Name of the first failing check, or null.'),
    url: webUrl.nullable().describe('Web URL of the failing run, or null.'),
  })
  .describe(
    'Colour of the default-branch head. It is red when the latest check run of a push-triggered workflow finished without success (failed, cancelled, timed out) or a commit status failed; scheduled, manual and other runs and check runs outside workflows are ignored, and branch protection is not read.',
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
        "Whether the daemon's adapter runner has put off this source's next regular poll for a rate limit: the last regular poll in this daemon run either reported a budget under github.reserveRemaining (GitHub sources, complete or not) or failed as throttled, with or without a retry time (any source), and the paused poll has not started yet. Held in memory, so false after a restart until a poll pauses again; a stored budget or an on-demand refresh never sets it.",
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
        'GitHub pull request sources only: the default-branch colour, red when the latest check run of a push-triggered workflow finished without success (failed, cancelled, timed out) or a commit status failed (scheduled and other runs ignored, branch protection not read); null until a poll reads it.',
      ),
  })
  .describe('Freshness and availability of one source.');
