// The adapters package: starts the runner that polls every source and reports to core.
import {
  AdapterError,
  mirrorSourceId,
  prSourceId,
  readyMirrorOf,
  trackerSourceId,
  type Adapter,
  type AdapterCore,
  type Config,
  type MirrorFailureCode,
} from '@spur-board/contracts';
import { githubSources } from './github/index.ts';
import { createGithubIssuesAdapter } from './github/issues.ts';
import { createGithubProjectAdapter } from './github/projectMirror.ts';
import { createJiraAdapter } from './jira/jira.ts';
import { startRunner, type PollFailure, type StartedRunner } from './runner/runner.ts';
import { createSpurAdapter, SPUR_MAX_BACKOFF_MS, type SpurNotice } from './spur/spur.ts';

export type { AdapterCore, SourceState } from '@spur-board/contracts';
export type { AdapterRunner, PollFailure, StartedRunner } from './runner/runner.ts';
export { sampleLinkRules } from './github/linkSample.ts';
export { readBranchRule } from './github/branchRule.ts';
export { readProjectMirror } from './github/projectMirror.ts';
// Board doctor classifies its own GitHub probes with the same rules as the PR source.
export { classifyHttpFailure } from './runner/http.ts';
export {
  checkAccessDenied,
  graphEnvelopeWire,
  graphqlFailure,
  teamScopeDenied,
} from './github/client.ts';

export interface StartAdaptersOptions {
  secrets?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  now: () => number;
  warn?: (message: string) => void;
  /** Every failed poll step and rejected source report. */
  onPollFailure?: (failure: PollFailure) => void;
  onSpurNotice?: (notice: SpurNotice) => void | Promise<void>;
  oneShot?: boolean;
  jiraSearchMethod?: 'GET';
}

function blindSource(
  id: string,
  intervalMs: number,
  message: string,
  code?: MirrorFailureCode,
): Adapter {
  return {
    id,
    intervalMs,
    poll: () =>
      Promise.reject(new AdapterError('config', message, code === undefined ? {} : { code })),
  };
}

/** Starts polling each configured source. */
export function startAdapters(
  config: Config,
  core: AdapterCore,
  options: StartAdaptersOptions,
): StartedRunner {
  const secrets = options.secrets ?? {};
  const githubToken = secrets['GITHUB_TOKEN'];
  const entries: {
    adapter: Adapter;
    reserveRemaining?: number;
    repo?: string;
    defaultFailureCode?: MirrorFailureCode;
  }[] = [];
  for (const project of config.projects) {
    if (project.tracker.type === 'jira') {
      const tracker = project.tracker;
      const id = trackerSourceId(project);
      const email = secrets['JIRA_EMAIL'];
      const token = secrets['JIRA_API_TOKEN'];
      entries.push({
        adapter:
          email && token
            ? createJiraAdapter({
                id,
                tracker: () => tracker,
                credentials: { email, token },
                now: options.now,
                intervalMs: config.adapters.jira.intervalMs,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                warn: options.warn ?? (() => undefined),
                ...(options.jiraSearchMethod === undefined
                  ? {}
                  : { searchMethod: options.jiraSearchMethod }),
              })
            : blindSource(id, config.adapters.jira.intervalMs, 'Jira credential is missing'),
      });
    } else {
      const id = trackerSourceId(project);
      const intervalMs = config.adapters.githubIssues.intervalMs;
      entries.push({
        adapter: githubToken
          ? createGithubIssuesAdapter({
              id,
              tracker: project.tracker,
              token: githubToken,
              now: options.now,
              intervalMs,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            })
          : blindSource(id, intervalMs, 'GitHub credential is missing'),
        reserveRemaining: config.github.reserveRemaining,
      });
      const mirror = readyMirrorOf(project);
      const mirrorId = mirrorSourceId(project);
      if (mirror !== undefined && mirrorId !== undefined)
        entries.push({
          adapter: githubToken
            ? createGithubProjectAdapter({
                id: mirrorId,
                repo: project.tracker.repo,
                mirror,
                token: githubToken,
                now: options.now,
                intervalMs,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              })
            : blindSource(
                mirrorId,
                intervalMs,
                'GitHub credential is missing',
                'mirror_project_forbidden',
              ),
          // Twice the reserve, so the mirror freezes before PR detail reads defer for budget.
          reserveRemaining: 2 * config.github.reserveRemaining,
          defaultFailureCode: 'mirror_read_failed',
        });
    }
  }
  if (githubToken) {
    entries.push(
      ...githubSources(config, {
        token: githubToken,
        now: options.now,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }).map(({ adapter, reserveRemaining, repo }) => ({ adapter, reserveRemaining, repo })),
    );
  } else {
    for (const project of config.projects) {
      for (const repo of project.repos) {
        entries.push({
          adapter: blindSource(
            prSourceId(project.id, repo),
            config.adapters.github.intervalMs,
            'GitHub credential is missing',
          ),
        });
      }
    }
  }
  const notices = new Set<Promise<void>>();
  const runner = startRunner({
    entries: [
      ...entries,
      {
        adapter: createSpurAdapter({
          baseUrl: config.adapters.spur.baseUrl,
          intervalMs: config.adapters.spur.intervalMs,
          flipSmoothingMs: config.health.flipSmoothingMs,
          now: options.now,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          warn: options.warn,
          onNotice: (notice) => {
            const pending = Promise.resolve().then(() => options.onSpurNotice?.(notice));
            notices.add(pending);
            void pending.then(
              () => notices.delete(pending),
              () => notices.delete(pending),
            );
            return pending;
          },
        }),
        maxBackoffMs: SPUR_MAX_BACKOFF_MS,
      },
    ],
    core,
    config,
    now: options.now,
    ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
    onFailure: options.onPollFailure,
  });
  return {
    budgetWaits: runner.budgetWaits,
    firstAttempts: runner.firstAttempts,
    pollPr: runner.pollPr,
    async stop() {
      await runner.stop();
      await Promise.allSettled([...notices]);
    },
  };
}
