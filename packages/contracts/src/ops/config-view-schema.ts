import { z } from 'zod';
import { MIRROR_FAILURE_CODES } from '../adapters.ts';
import { configSchema } from '../config.ts';
import { CHECKS_GATE_COLUMNS, COLUMN_GROUPS, COLUMN_IDS, DISPATCHER_MODES } from '../enums.ts';

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
                        'Configured executor; worker falls back to operator without a live worker, except in Done, which then opens no turn; unbound Review, Product Review, QA and Ready to Merge read operator.',
                      ),
                    name: z
                      .string()
                      .nullable()
                      .describe('Named Spur project, or null for automatic routing.'),
                  })
                  .describe('Effective column executor.'),
                group: z
                  .enum(COLUMN_GROUPS)
                  .optional()
                  .describe('Column group; present only on Todo-group columns.'),
                source: z
                  .discriminatedUnion('kind', [
                    z.strictObject({
                      kind: z
                        .literal('manual')
                        .describe('manual: the operator places tasks in this column.'),
                    }),
                    z.strictObject({
                      kind: z
                        .literal('mirror')
                        .describe(
                          'mirror: the board places tasks between todo and ready-for-dev from a GitHub Project field.',
                        ),
                      tracker: z.literal('github-project').describe('The mirrored tracker.'),
                      name: z
                        .string()
                        .min(1)
                        .describe(
                          'Title of the GitHub Project from its last complete read, else project.',
                        ),
                      project: z
                        .string()
                        .min(1)
                        .describe('The configured Project as owner/number.'),
                      field: z.string().min(1).describe('The configured single-select field.'),
                      value: z
                        .string()
                        .min(1)
                        .describe('The configured option that places a task in ready-for-dev.'),
                      health: z
                        .enum(['healthy', 'degraded', 'failing'])
                        .describe(
                          'Health of the github-project source, by the rule of status.get services.',
                        ),
                      readAt: z.iso
                        .datetime()
                        .nullable()
                        .describe('Poll start of the last complete read, or null before one.'),
                      error: z
                        .strictObject({
                          code: z.enum(MIRROR_FAILURE_CODES).describe('Mirror failure code.'),
                          message: z.string().min(1).describe('What the last read failed on.'),
                        })
                        .optional()
                        .describe(
                          'Why the last read failed; positions stay as the last complete read left them. Absent after a complete read.',
                        ),
                    }),
                  ])
                  .optional()
                  .describe(
                    'Where the column takes its tasks from; present only on Todo-group columns.',
                  ),
                quietTurnAfterMs: z
                  .int()
                  .min(1)
                  .optional()
                  .describe(
                    'Effective quiet time of an orchestrator turn before its reminder, in milliseconds; present only on columns with a named orchestrator.',
                  ),
                noRecipientAfterMs: z
                  .int()
                  .min(1)
                  .optional()
                  .describe(
                    'Effective wait of an untaken turn with no live session before the operator item, in milliseconds; present only on columns with a named orchestrator.',
                  ),
                quietAfterMs: z
                  .int()
                  .min(300_000)
                  .optional()
                  .describe(
                    'How long a task waits in External Review without a new external review round before the operator item, in milliseconds; present only on the external-review column when above 0.',
                  ),
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
          checksGate: z
            .enum(CHECKS_GATE_COLUMNS)
            .describe(
              'The column whose exit waits for green checks, as the running daemon read it at start; dev when not configured.',
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
            'Origin of the Spur web UI clients link sessions to; HTTP works on any host without voice. Null when not configured; UI reachability only warns in doctor and never blocks updates.',
          ),
      })
      .describe('Web origins of the board listener and the Spur UI.'),
  })
  .describe('Allowlisted effective configuration without credentials or adapter settings.');
