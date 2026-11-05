import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { UserId } from '../packages/contracts/src/index.ts';
import { liveCases, type LiveCaseId } from '../packages/gateway-testkit/src/cases.ts';
import type { LiveRunReport } from '../packages/gateway-slack/test/live-conformance.ts';

const channelVariable = 'BOARD_LIVE_CHANNEL';
const channelNameVariable = 'BOARD_LIVE_CHANNEL_NAME';

class PreflightError extends Error {}

interface LiveSettings {
  token: string;
  appToken: string;
  channel: string;
  channelName: string;
  operator: UserId;
}

/** A focused rerun creates its own root thread and reports only the selected case. */
export function selectedLiveCases(args: readonly string[]): readonly LiveCaseId[] | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === '--case' && args[1] === 'guided-mention') {
    return ['guided-mention'];
  }
  throw new PreflightError('Use --case guided-mention for a focused live run.');
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
  const channelName = env[channelNameVariable];
  if (channelName === undefined || !/^[a-z0-9_-]{1,79}$/.test(channelName)) {
    throw new PreflightError(`Set ${channelNameVariable} to the designated test channel name.`);
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
  return {
    token,
    appToken,
    channel,
    channelName,
    operator: userIdSchema.parse(loaded.config.operator.slack),
  };
}

/** Reject a channel unless Slack confirms the designated private destination. */
export async function verifyLiveChannel(
  settings: Pick<LiveSettings, 'channel' | 'channelName'>,
  lookup: (channel: string) => Promise<unknown>,
): Promise<void> {
  const response: unknown = await lookup(settings.channel);
  const metadata =
    typeof response === 'object' &&
    response !== null &&
    'ok' in response &&
    response.ok === true &&
    'channel' in response
      ? response.channel
      : undefined;
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('id' in metadata) ||
    metadata.id !== settings.channel ||
    !('name' in metadata) ||
    metadata.name !== settings.channelName ||
    !('is_private' in metadata) ||
    metadata.is_private !== true ||
    !('is_im' in metadata) ||
    metadata.is_im !== false ||
    !('is_mpim' in metadata) ||
    metadata.is_mpim !== false ||
    !('is_member' in metadata) ||
    metadata.is_member !== true ||
    !('is_shared' in metadata) ||
    metadata.is_shared !== false ||
    !('is_ext_shared' in metadata) ||
    metadata.is_ext_shared !== false ||
    !('is_archived' in metadata) ||
    metadata.is_archived !== false
  ) {
    throw new PreflightError('The live channel must match the designated private test channel.');
  }
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
    `${report.rateLimit.status === 'not-run' ? 'NOT RUN' : report.rateLimit.status.toUpperCase()} rate-limit: ${report.rateLimit.observation}`,
  ];
  return lines.join('\n');
}

async function main(): Promise<number> {
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    const settings = await liveSettings(process.env);
    const caseIds = selectedLiveCases(process.argv.slice(2));
    if (!process.stdin.isTTY) {
      throw new PreflightError('Live conformance requires an interactive terminal.');
    }
    const { createApi } = await import('../packages/gateway-slack/src/api.ts');
    const api = createApi({ token: settings.token });
    await verifyLiveChannel(settings, (channel) => api.conversations.info({ channel }));
    const { runLiveConformance } =
      await import('../packages/gateway-slack/test/live-conformance.ts');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    const report = await runLiveConformance({
      ...settings,
      ...(caseIds === undefined ? {} : { caseIds }),
      prompt: async (_id, instruction, _context, signal) => {
        await terminal?.question(`${instruction}\nPress Enter after the action.\n`, { signal });
      },
    });
    process.stdout.write(`${formatLiveReport(report)}\n`);
    return report.results.every((result) => result.status === 'pass') &&
      report.rateLimit.status !== 'fail'
      ? 0
      : 1;
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
