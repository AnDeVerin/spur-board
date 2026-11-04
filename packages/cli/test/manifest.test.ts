import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { CliError } from '../src/exit-codes.ts';
import { renderSlackManifest } from '../src/manifest.ts';

const expectedScopes = [
  'chat:write',
  'chat:write.customize',
  'groups:history',
  'groups:read',
  'app_mentions:read',
  'commands',
  'reactions:write',
];

interface ParsedManifest {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string };
    slash_commands: { command: string; usage_hint: string }[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    socket_mode_enabled: boolean;
  };
}

function assertManifest(text: string, appName: string, command: string): void {
  const document = YAML.parseDocument(text);
  expect(document.errors).toEqual([]);
  const manifest = document.toJS() as ParsedManifest;
  expect(manifest.display_information.name).toBe(appName);
  expect(manifest.features.bot_user.display_name).toBe(appName);
  expect(manifest.features.slash_commands[0]?.command).toBe(command);
  expect(manifest.features.slash_commands[0]?.usage_hint).toBe('[task <KEY> [history]]');
  expect(manifest.oauth_config.scopes.bot).toEqual(expectedScopes);
  expect(manifest.settings.event_subscriptions.bot_events).toEqual([
    'message.groups',
    'app_mention',
  ]);
  expect(manifest.settings.interactivity.is_enabled).toBe(true);
  expect(manifest.settings.socket_mode_enabled).toBe(true);
}

async function commandOutput(args: string[]): Promise<string> {
  const output = { stdout: '', stderr: '' };
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
  };
  expect(await runCli(['slack', 'manifest', ...args], { env: {}, io })).toBe(0);
  expect(output.stderr).toBe('');
  return output.stdout;
}

describe('slack manifest', () => {
  it('prints a default manifest with the exact bot scopes and M1 usage hint', async () => {
    const text = await commandOutput([]);
    assertManifest(text, 'spur-board', '/board');
    expect(text).toMatchInlineSnapshot(`
      "_metadata:
        major_version: 1
        minor_version: 1
      display_information:
        name: spur-board
        description: Board updates and commands
      features:
        bot_user:
          display_name: spur-board
        slash_commands:
          - command: /board
            description: Show board tasks and command help
            usage_hint: "[task <KEY> [history]]"
            should_escape: false
      oauth_config:
        scopes:
          bot:
            - chat:write
            - chat:write.customize
            - groups:history
            - groups:read
            - app_mentions:read
            - commands
            - reactions:write
      settings:
        event_subscriptions:
          bot_events:
            - message.groups
            - app_mention
        interactivity:
          is_enabled: true
        socket_mode_enabled: true
      "
    `);
  });

  it('uses operator-selected names without changing permissions or events', async () => {
    const text = await commandOutput(['--app-name', 'My Board', '--command', '/board-me']);
    assertManifest(text, 'My Board', '/board-me');
    expect(text).toMatchInlineSnapshot(`
      "_metadata:
        major_version: 1
        minor_version: 1
      display_information:
        name: My Board
        description: Board updates and commands
      features:
        bot_user:
          display_name: My Board
        slash_commands:
          - command: /board-me
            description: Show board tasks and command help
            usage_hint: "[task <KEY> [history]]"
            should_escape: false
      oauth_config:
        scopes:
          bot:
            - chat:write
            - chat:write.customize
            - groups:history
            - groups:read
            - app_mentions:read
            - commands
            - reactions:write
      settings:
        event_subscriptions:
          bot_events:
            - message.groups
            - app_mention
        interactivity:
          is_enabled: true
        socket_mode_enabled: true
      "
    `);
  });

  it('rejects blank app names and invalid slash commands', () => {
    expect(() => renderSlackManifest({ appName: '  ' })).toThrow(CliError);
    for (const command of ['board', '/', '/board name', '/board/again']) {
      expect(() => renderSlackManifest({ command })).toThrow(CliError);
    }
  });

  it('returns a usage error for an invalid command flag', async () => {
    const output = { stdout: '', stderr: '' };
    const io: CliIo = {
      isTTY: false,
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    };
    expect(await runCli(['slack', 'manifest', '--command', 'board'], { env: {}, io })).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('usage');
  });
});
