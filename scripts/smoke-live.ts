import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { UserId } from '../packages/contracts/src/index.ts';
import { liveCases } from '../packages/gateway-testkit/src/cases.ts';
import type { LiveRunReport } from '../packages/gateway-slack/test/live-conformance.ts';

const channelVariable = 'BOARD_LIVE_CHANNEL';

class PreflightError extends Error {}

interface LiveSettings {
  token: string;
  appToken: string;
  channel: string;
  operator: UserId;
}

/** Check all local safety conditions before constructing a Slack client. */
export async function liveSettings(
  env: Readonly<Record<string, string | undefined>>,
): Promise<LiveSettings> {
  if (env['CI'] === 'true') throw new PreflightError('Live conformance is disabled in CI.');
  const channel = env[channelVariable];
  if (channel === undefined || !/^[CG][A-Z0-9]{8,}$/.test(channel)) {
    throw new PreflightError(`Set ${channelVariable} to a test channel ID.`);
  }
  const [{ loadConfig, resolvePaths }, { userIdSchema }] = await Promise.all([
    import('../packages/daemon/src/config.ts'),
    import('../packages/contracts/src/index.ts'),
  ]);
  const loaded = loadConfig(resolvePaths(env, homedir()));
  if (
    channel === loaded.config.slack.channels.orchestrators ||
    channel === loaded.config.slack.channels.feed
  ) {
    throw new PreflightError('The test channel must differ from configured destinations.');
  }
  if (env['SLACK_API_URL'] || loaded.secrets['SLACK_API_URL']) {
    throw new PreflightError('API URL overrides are not allowed for a live run.');
  }
  const token = loaded.secrets['SLACK_BOT_TOKEN'];
  const appToken = loaded.secrets['SLACK_APP_TOKEN'];
  if (!token || !appToken) {
    throw new PreflightError('The local secrets file needs both Slack tokens.');
  }
  return { token, appToken, channel, operator: userIdSchema.parse(loaded.config.operator.slack) };
}

function sdkVersions(): { web: string; socket: string } {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../packages/gateway-slack/package.json', import.meta.url), 'utf8'),
  );
  if (typeof raw !== 'object' || raw === null || !('dependencies' in raw)) {
    throw new Error('Slack SDK versions unavailable');
  }
  const dependencies = raw.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new Error('Slack SDK versions unavailable');
  }
  const web = '@slack/web-api' in dependencies ? dependencies['@slack/web-api'] : undefined;
  const socket =
    '@slack/socket-mode' in dependencies ? dependencies['@slack/socket-mode'] : undefined;
  if (typeof web !== 'string' || typeof socket !== 'string') {
    throw new Error('Slack SDK versions unavailable');
  }
  return { web, socket };
}

/** The report contains only known case titles and controlled observations. */
export function formatLiveReport(report: LiveRunReport): string {
  const versions = sdkVersions();
  const titles = new Map(liveCases.map((item) => [item.id, item.title]));
  const lines = [
    `Live conformance report — ${report.date}`,
    `Slack SDKs: @slack/web-api ${versions.web}; @slack/socket-mode ${versions.socket}`,
    ...report.results.map(
      (result) =>
        `${result.status.toUpperCase()} ${result.id}: ${titles.get(result.id) ?? 'case'} — ${result.observation}`,
    ),
  ];
  return lines.join('\n');
}

async function main(): Promise<number> {
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    const settings = await liveSettings(process.env);
    const { runLiveConformance } =
      await import('../packages/gateway-slack/test/live-conformance.ts');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    const report = await runLiveConformance({
      ...settings,
      prompt: async (_id, instruction, _context, signal) => {
        await terminal?.question(`${instruction}\nPress Enter after the action.\n`, { signal });
      },
    });
    process.stdout.write(`${formatLiveReport(report)}\n`);
    return report.results.every((result) => result.status === 'pass') ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof PreflightError ? error.message : 'Live conformance could not finish.'}\n`,
    );
    return 1;
  } finally {
    terminal?.close();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
