import { z } from 'zod';

/** Longest `fix` text the daemon sends in one doctor check, in characters. */
export const DOCTOR_FIX_MAX = 300;

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
        id: checkShape.id.regex(/^[a-z][a-z._]+$/).max(60),
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
