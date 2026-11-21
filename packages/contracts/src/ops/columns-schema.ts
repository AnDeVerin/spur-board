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
                'Alternative completion routes: eligible linked merged PR with a tracker-done ticket (GitHub closed or effective Jira doneStatuses), or a done ticket without open linked PRs/live workers after fresh complete non-blind repository and Spur observations. Missing/unconfirmed merged-ticket status holds dispatch; a ticket that stays non-done and changed in any way at or after the newest merge, in filter or manually included, resumes work; a ticket untouched since the merge stays unconfirmed; when no merged PR has a stored merge time (facts from before the dispatcher), work resumes once the ticket, in filter or manually included, is observed open at or past the judged PR last update plus the tracker interval. Blind GitHub and pending submits hold both routes. Includes eligibility/readability, non-archived scope and dispatcher-mode qualifications.',
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
                .describe(
                  'Applicable return triggers, course-check rounds and completion/reopening qualifications.',
                ),
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
                      'Counted returns before a course check; zero disables it. Executor, feedback and thread returns count; draft, conflict and red CI do not. With External Review enabled, returns for external comments count toward its courseCheck instead, as does each external change request on a new PR head while in Dev, once per head.',
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
                      "Question escalation starting at the first recipient: the executor, or the task's live worker in a column with no executor bound; self-role steps are skipped using runtime routing.",
                    ),
                  noRecipient: z
                    .strictObject({
                      operatorItemAfterMs: z
                        .int()
                        .min(1)
                        .describe(
                          'Effective noRecipientAfterMs before one operator item per project/column for untaken named-orchestrator turns without a recipient; a positive duration, not a zero-disabled policy.',
                        ),
                      text: z
                        .string()
                        .describe(
                          'Wait origin, recipient eligibility, source readiness, item clearing and no-reroute qualifications.',
                        ),
                    })
                    .nullable()
                    .describe(
                      'Untaken named-turn no-recipient policy; null for Todo or columns without a named orchestrator. The turn keeps waiting while the operator item is raised.',
                    ),
                  silent: z
                    .strictObject({
                      remindAfterMs: z
                        .int()
                        .min(0)
                        .describe(
                          'Idle time before reminder for the configured agent executor: effective quietTurnAfterMs for a named turn, global idle threshold for a worker turn. Existing turns retain role-based timing.',
                        ),
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
                  kind: z
                    .enum(['manual', 'dispatcher', 'mirror'])
                    .describe(
                      'Current placement mechanism; mirror: a GitHub Project field places tasks in ready-for-dev.',
                    ),
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
