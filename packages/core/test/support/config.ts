import { configSchema } from '@spur-board/contracts';

/** Both Slack channels set, so the board writes Slack messages: spread into a test config. */
export const SLACK_ON = { channels: { orchestrators: 'C000000001', feed: 'C000000002' } };

/** A parsed one-project GitHub-issues config; parsing applies the schema defaults. */
export const testConfig = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [{ name: 'web', role: 'worker' }],
      columns: [
        { id: 'todo', orchestrator: 'none' },
        { id: 'ready-for-dev', orchestrator: 'none' },
        { id: 'dev', orchestrator: 'none' },
        { id: 'review', orchestrator: 'none' },
        { id: 'qa', orchestrator: 'none' },
        { id: 'ready-to-merge', orchestrator: 'none' },
        { id: 'done', orchestrator: 'none' },
      ],
    },
  ],
  operator: { slack: 'operator' },
  slack: SLACK_ON,
  digest: { tz: 'UTC' },
});

/** `testConfig` with Slack off: no operator and no slack block. */
export const slackOffConfig = configSchema.parse({
  projects: testConfig.projects,
  digest: { tz: 'UTC' },
});
