import { z } from 'zod';

/** Longest `fix` text the daemon sends in one doctor check, in characters. */
export const DOCTOR_FIX_MAX = 300;

/**
 * The oldest Spur release with every Spur API the Board calls: transition polling
 * (`GET /sessions/transitions`, Spur #1447). Bump it with the feature that needs a newer Spur.
 */
export const SPUR_MIN_VERSION = '1.53.0';

/** The `slack.configured` fix when neither slack.channels nor operator.slack is set. */
export const SLACK_OFF_FIX =
  'Slack off: questions addressed to you are in board inbox operator and the web inbox. A new token needs Slack approval, so outside Spur only tokens approved earlier work, until board token revoke. Run the spur-board-setup skill to add Slack.';

/** The `slack.configured` fix when operator.slack is set but slack.channels is not. */
export const SLACK_PARTLY_FIX =
  'Slack is partly configured: operator.slack is set but slack.channels is not, so nothing reaches Slack and questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to set slack.channels, or remove operator.slack to run without Slack.';

const DOCTOR_STATUSES = ['pass', 'fail', 'warning'] as const;

const checkShape = {
  id: z.string(),
  status: z.enum(DOCTOR_STATUSES),
  blocking: z.boolean(),
  fix: z.string().nullable(),
};

/** The body of `GET /v1/doctor`, as the daemon sends it; core parses every outgoing report. */
export const doctorReportSchema = z.strictObject({
  version: z.string().min(1).max(50),
  checks: z
    .array(
      z.strictObject({
        ...checkShape,
        id: checkShape.id.regex(/^(?:[a-z][a-z._]+|web\.spurUiOrigin)$/).max(60),
        fix: z.string().max(DOCTOR_FIX_MAX).nullable(),
      }),
    )
    .max(30),
});

/**
 * The daemon report as the CLI reads it: a newer daemon may add check ids, longer text or keys,
 * so this has no bounds and drops unknown keys. A new status value is still rejected, so adding
 * one breaks every older CLI that reads the report.
 */
export const remoteDoctorReportSchema = z.object({
  version: z.string(),
  checks: z.array(z.object(checkShape)),
});

export type DoctorCheck = z.output<typeof doctorReportSchema>['checks'][number];
export type DoctorReport = z.output<typeof doctorReportSchema>;
