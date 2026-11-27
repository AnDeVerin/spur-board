// Check responses for the stand's GitHub fake.
import type { Pr } from './github-pr-control.ts';

/** GitHub's combined state: any failure wins, then anything still running. */
export function rollupState(contexts: readonly Pr['contexts'][number][]): string {
  const failed = contexts.some((context) =>
    context.__typename === 'StatusContext'
      ? context.state === 'FAILURE' || context.state === 'ERROR'
      : context.status === 'COMPLETED' &&
        ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(
          context.conclusion ?? '',
        ),
  );
  if (failed) return 'FAILURE';
  const running = contexts.some((context) =>
    context.__typename === 'StatusContext'
      ? context.state === 'PENDING' || context.state === 'EXPECTED'
      : context.status !== 'COMPLETED',
  );
  return running ? 'PENDING' : 'SUCCESS';
}

export function branchCheckRun(
  name: string,
  conclusion: string,
  event: string,
  at: string,
  detailsUrl: string,
) {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    startedAt: at,
    completedAt: at,
    detailsUrl,
    checkSuite: {
      createdAt: at,
      workflowRun: {
        event,
        workflow: { id: event === 'push' ? 'W_stand_ci' : 'W_stand_nightly' },
      },
    },
  };
}
