import { SLACK_BOT_SCOPES } from '@spur-board/contracts';
import YAML from 'yaml';
import { CliError } from './exit-codes.ts';

export interface SlackManifestOptions {
  appName?: string;
  command?: string;
}

export function renderSlackManifest(options: SlackManifestOptions = {}): string {
  const appName = (options.appName ?? 'spur-board').trim();
  const command = options.command ?? '/board';
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
