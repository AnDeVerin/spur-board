// The combined check state the stand's GitHub PR fake reports for a PR's checks.
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
