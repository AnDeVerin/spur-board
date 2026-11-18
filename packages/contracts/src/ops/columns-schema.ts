import { z } from 'zod';
import {
  CHECKS_GATE_COLUMNS,
  COLUMN_GROUPS,
  COLUMN_IDS,
  GATE_CONDITIONS,
  ADDRESSEE_ROLES,
} from '../enums.ts';
import { configViewSchema } from './config-view-schema.ts';
import { statusSessionFactsSchema } from './schemas.ts';

const configProject = configViewSchema.shape.projects.element;
const session = z.strictObject({
  id: statusSessionFactsSchema.shape.id,
  links: statusSessionFactsSchema.shape.links,
});
const destination = z.strictObject({
  role: z.enum(ADDRESSEE_ROLES).describe('Runtime addressee role.'),
  project: z
    .string()
    .nullable()
    .describe('Named Spur project, or null for the operator or task worker.'),
  displayName: z
    .string()
    .nullable()
    .describe('Configured display name, falling back to project name.'),
  session: session
    .nullable()
    .describe(
      'Project-selected live session, as in doctor; task-linked or author sessions can override it. Null when absent or task-specific.',
    ),
  text: z.string().describe('Routing and no-session behavior.'),
});

export const columnsDescribeOutputSchema = z.strictObject({
  projects: z
    .array(
      z.strictObject({
        id: configProject.shape.id,
        dispatcher: configProject.shape.dispatcher,
        checksGate: z
          .enum(CHECKS_GATE_COLUMNS)
          .describe('Effective column requiring green checks.'),
        reposWithoutCi: z
          .array(z.string())
          .describe(
            'Repositories whose open PR with no checks and no required checks passes CI; does not waive failed or pending checks.',
          ),
        resolvedThreadsFrom: z
          .enum(COLUMN_IDS)
          .nullable()
          .describe('Leftmost enabled thread gate, or null when none.'),
        completion: z
          .strictObject({
            to: z
              .literal('done')
              .describe('Completion destination, separate from ordinary gate progression.'),
            text: z
              .string()
              .describe(
                'Alternative completion routes: eligible linked merged PR with a tracker-done ticket (GitHub closed or effective Jira doneStatuses), or a done ticket without open linked PRs/live workers after fresh complete non-blind repository and Spur observations. Missing/unconfirmed merged-ticket status holds dispatch; confirmed-open evidence after the effective tracker interval, in filter or manually included, resumes work. Blind GitHub and pending submits hold both routes. Includes eligibility/readability, non-archived scope and dispatcher-mode qualifications.',
              ),
          })
          .describe(
            'Project-wide completion route from any column other than Done. Completion bypasses normal gates; it is not conjoined with exit.conditions.',
          ),
        columns: z
          .array(
            z.strictObject({
              id: z.enum(COLUMN_IDS).describe('Enabled column in canonical order.'),
              name: z.string().describe('Human column name.'),
              group: z
                .enum(COLUMN_GROUPS)
                .optional()
                .describe('Group, present only for Todo columns.'),
              exit: z
                .strictObject({
                  to: z
                    .enum(COLUMN_IDS)
                    .nullable()
                    .describe(
                      'Next normal gate destination, skipping the remaining Todo group; null at the last enabled stage before Done and at Done itself. The project completion route separately describes entry into Done.',
                    ),
                  conditions: z
                    .array(
                      z.strictObject({
                        id: z
                          .enum([...GATE_CONDITIONS, 'work_started'])
                          .describe(
                            'Condition identifier; each rule appears at its effective owner.',
                          ),
                        text: z
                          .string()
                          .describe('Canonical positive exit rule, independent of task state.'),
                      }),
                    )
                    .describe(
                      'Own gate conditions; gates accumulate from earlier enabled columns. Passing them alone never moves into Done. The separate project completion route bypasses these gates rather than adding a conjunctive requirement.',
                    ),
                })
                .describe(
                  'Normal gate progression and effective own rules; completion into Done is described separately at project level.',
                ),
              returns: z
                .array(z.string())
                .describe('Applicable return triggers and completion/reopening qualifications.'),
              limits: z
                .strictObject({
                  cycleLimit: z
                    .int()
                    .min(1)
                    .describe(
                      'Counted returns before operator hold; takes precedence over courseCheck.',
                    ),
                  courseCheck: z
                    .int()
                    .min(0)
                    .describe(
                      'Counted returns before a course check; zero disables it. Executor, feedback and thread returns count; draft, conflict and red CI do not.',
                    ),
                  courseCheckTo: destination.describe(
                    'Resolved course-check destination; missing live recipient falls back to operator.',
                  ),
                })
                .nullable()
                .describe('Return limits, or null when the column cannot return to Dev.'),
              executor: z
                .strictObject({
                  kind: configProject.shape.columns.element.shape.executor.shape.kind,
                  project: destination.shape.project,
                  role: configProject.shape.spurProjects.element.shape.role
                    .nullable()
                    .describe('Configured Spur role, or null for automatic/operator routing.'),
                  displayName: destination.shape.displayName,
                  session: destination.shape.session,
                  text: z
                    .string()
                    .describe('Turn ownership, fallback and project-selected session scope.'),
                })
                .describe(
                  'Effective executor; Todo does not open turns, Done may open an agent wrap-up turn.',
                ),
              escalation: z
                .strictObject({
                  chain: z
                    .array(destination)
                    .describe(
                      'Question escalation starting at the executor; self-role steps are skipped using runtime routing.',
                    ),
                  silent: z
                    .strictObject({
                      remindAfterMs: z
                        .int()
                        .min(0)
                        .describe('Idle time for a taken agent turn before reminder.'),
                      operatorItemAfterReminderReadMs: z
                        .int()
                        .min(0)
                        .describe(
                          'Further quiet time after reminder read/current quiet period before operator item.',
                        ),
                      unhealthyAfterMs: z
                        .int()
                        .min(0)
                        .describe('Unhealthy executor episode before operator item.'),
                      text: z
                        .string()
                        .describe('Timing origins, pauses and dispatcher-mode qualification.'),
                    })
                    .nullable()
                    .describe(
                      'Taken-agent-turn silence policy; null for operator, dispatcher and Todo.',
                    ),
                })
                .describe('Question and silent-executor escalation.'),
              movedBy: z
                .strictObject({
                  kind: z.enum(['manual', 'dispatcher']).describe('Current placement mechanism.'),
                  text: z
                    .string()
                    .describe('How the column is entered, including shadow-mode qualification.'),
                })
                .describe('Column placement policy.'),
            }),
          )
          .describe('Enabled columns only, in canonical order.'),
      }),
    )
    .describe(
      'Effective configured projects visible to the caller; bounded by config and built-in columns.',
    ),
});
