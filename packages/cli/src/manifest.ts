import { readFileSync } from 'node:fs';
import {
  DEFAULT_SLACK_APP_NAME,
  DEFAULT_SLACK_COMMAND,
  SLACK_BOT_SCOPES,
  configSchema,
} from '@spur-board/contracts';
import YAML from 'yaml';
import { configFile } from './config.ts';
import { CliError } from './exit-codes.ts';

export interface SlackManifestOptions {
  appName?: string;
  command?: string;
}

export function loadSlackManifestDefaults(
  env: NodeJS.ProcessEnv,
  home: string,
): SlackManifestOptions {
  let contents: string;
  try {
    contents = readFileSync(configFile(env, home), 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw new CliError(
      'config',
      undefined,
      undefined,
      'Read config.yaml before generating a manifest.',
    );
  }
  const document = YAML.parseDocument(contents);
  if (document.errors.length > 0) {
    throw new CliError('config', undefined, undefined, 'Fix the YAML in config.yaml.');
  }
  const parsed = configSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.path.map(String).join('.') || 'config.yaml';
    throw new CliError('config', undefined, undefined, `Fix ${key} in config.yaml.`);
  }
  return { appName: parsed.data.slack.appName, command: parsed.data.slack.command };
}

export function renderSlackManifest(options: SlackManifestOptions = {}): string {
  const appName = (options.appName ?? DEFAULT_SLACK_APP_NAME).trim();
  const command = options.command ?? DEFAULT_SLACK_COMMAND;
  if (!appName) {
    throw new CliError('usage', undefined, undefined, 'Set a nonempty --app-name.');
  }
  if (!/^\/[a-z0-9_-]+$/.test(command)) {
    throw new CliError(
      'usage',
      undefined,
      undefined,
      'Set --command to a slash command such as /board.',
    );
  }

  return YAML.stringify(
    {
      _metadata: { major_version: 1, minor_version: 1 },
      display_information: {
        name: appName,
        description: 'Board updates and commands',
      },
      features: {
        bot_user: { display_name: appName },
        slash_commands: [
          {
            command,
            description: 'Show board tasks and command help',
            usage_hint: '[task <KEY> [history]]',
            should_escape: false,
          },
        ],
      },
      oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
      settings: {
        event_subscriptions: { bot_events: ['message.groups', 'app_mention'] },
        interactivity: { is_enabled: true },
        socket_mode_enabled: true,
      },
    },
    { lineWidth: 0 },
  );
}
