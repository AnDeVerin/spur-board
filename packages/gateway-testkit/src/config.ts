/**
 * The config `slack` block with both Slack channels set, so the board writes Slack rows: for
 * tests that run a fake gateway. Without it the board runs with Slack off.
 */
export const SLACK_ON_CONFIG = {
  channels: { orchestrators: 'C000000001', feed: 'C000000002' },
} as const;
