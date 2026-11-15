import { z } from 'zod';

export const sourceViewSchema = z
  .strictObject({
    pointsLastHour: z
      .int()
      .nonnegative()
      .optional()
      .describe('Reported source points consumed during the preceding hour.'),
    source: z.string().min(1).describe('Adapter source identifier.'),
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
    warmingUp: z
      .boolean()
      .describe('Whether this source needs a complete poll in this daemon run.'),
  })
  .describe('Freshness and availability of one source.');
