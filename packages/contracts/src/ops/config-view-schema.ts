import { z } from 'zod';
import { configSchema } from '../config.ts';
import { COLUMN_IDS, DISPATCHER_MODES } from '../enums.ts';

export const configViewSchema = z
  .strictObject({
    projects: z
      .array(
        z.strictObject({
          id: z.string().min(1).describe('Board project ID.'),
          columns: z
            .array(
              z.strictObject({
                id: z.enum(COLUMN_IDS).describe('Enabled column in canonical order.'),
                executor: z
                  .strictObject({
                    kind: z
                      .enum(['dispatcher', 'worker', 'orchestrator', 'curator', 'operator'])
                      .describe(
                        'Configured executor; worker falls back to operator without a live worker.',
                      ),
                    name: z
                      .string()
                      .nullable()
                      .describe('Named Spur project, or null for automatic routing.'),
                  })
                  .describe('Effective column executor.'),
              }),
            )
            .describe('Enabled board columns.'),
          dispatcher: z
            .strictObject({ mode: z.enum(DISPATCHER_MODES).describe('Effective dispatcher mode.') })
            .describe('Dispatcher configuration.'),
          spurProjects: z
            .array(
              z.strictObject({
                name: z.string().min(1).describe('Spur project name.'),
                role: configSchema.shape.projects.element.shape.spurProjects.unwrap().element.shape
                  .role,
                displayName: z
                  .string()
                  .min(1)
                  .describe('Configured display name, falling back to project name.'),
              }),
            )
            .describe('Effective Spur project bindings.'),
          ticketBrowseBase: z
            .url({ protocol: /^https?$/ })
            .nullable()
            .describe(
              'Ticket page prefix; append a task key such as PROJ-12. <baseUrl>/browse/ for a Jira project; null when the tracker has none, as for GitHub Issues.',
            ),
        }),
      )
      .describe('Effective projects visible to this caller.'),
    web: z
      .strictObject({
        publicOrigin: z
          .url({ protocol: /^https?$/ })
          .nullable()
          .describe(
            'Origin the board web listener answers on; null when the listener is off or not bound yet.',
          ),
        spurUiOrigin: z
          .url({ protocol: /^https?$/ })
          .nullable()
          .describe(
            'Origin of the Spur web UI clients link sessions to; null when not configured.',
          ),
      })
      .describe('Web origins of the board listener and the Spur UI.'),
  })
  .describe('Allowlisted effective configuration without credentials or adapter settings.');
