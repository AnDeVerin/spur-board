// The adapters package: starts the runner that polls every source and reports to core.
import { AdapterError, type Adapter, type AdapterCore, type Config } from '@spur-board/contracts';
import { githubSources } from './github/index.ts';
import { createGithubIssuesAdapter } from './github/issues.ts';
import { createJiraAdapter } from './jira/jira.ts';
import { startRunner, type AdapterRunner, type PollFailure } from './runner/runner.ts';
import { createSpurAdapter, type SpurNotice } from './spur/spur.ts';

export type { AdapterCore, SourceState } from '@spur-board/contracts';
export type { AdapterRunner, PollFailure } from './runner/runner.ts';
export { sampleLinkRules } from './github/linkSample.ts';

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

function blindSource(id: string, intervalMs: number, message: string): Adapter {
  return {
    id,
    intervalMs,
    poll: () => Promise.reject(new AdapterError('config', message)),
  };
}

/** Starts polling each configured source. */
export function startAdapters(
  config: Config,
  core: AdapterCore,
  options: StartAdaptersOptions,
): AdapterRunner {
  const secrets = options.secrets ?? {};
  const githubToken = secrets['GITHUB_TOKEN'];
  const entries: { adapter: Adapter; reserveRemaining?: number; repo?: string }[] = [];
  for (const project of config.projects) {
    if (project.tracker.type === 'jira') {
      const tracker = project.tracker;
      const id = `jira:${project.id}`;
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
      const id = `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`;
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
            `github:${project.id}:${repo.toLowerCase()}`,
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
      },
    ],
    core,
    config,
    now: options.now,
    ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
    onFailure: options.onPollFailure,
  });
  return {
    firstAttempts: runner.firstAttempts,
    pollPr: runner.pollPr,
    async stop() {
      await runner.stop();
      await Promise.allSettled([...notices]);
    },
  };
}
