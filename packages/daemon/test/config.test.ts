import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolvePaths } from '../src/config.ts';
import { makeHome, VALID_CONFIG_YAML } from './home.ts';

const SECRET_NAME = 'DAEMON_TEST_API_KEY';
const SECRETS_TEXT = `${SECRET_NAME}=value-to-hide-123456\nexport OTHER_VALUE="two words"\n`;

function load(home: string): ReturnType<typeof loadConfig> {
  return loadConfig(resolvePaths({ BOARD_HOME: home }, '/unused'));
}

function configError(home: string): string {
  try {
    load(home);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('loadConfig did not throw');
}

describe('resolvePaths', () => {
  it('puts all four files flat in BOARD_HOME', () => {
    expect(resolvePaths({ BOARD_HOME: '/b', XDG_DATA_HOME: '/d' }, '/h')).toEqual({
      configFile: '/b/config.yaml',
      secretsFile: '/b/secrets.env',
      dbFile: '/b/board.sqlite',
      lockFile: '/b/board.lock',
    });
  });

  it('makes a relative BOARD_HOME absolute', () => {
    expect(resolvePaths({ BOARD_HOME: 'rel' }, '/h').lockFile).toBe(
      join(process.cwd(), 'rel', 'board.lock'),
    );
  });

  it('uses XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    expect(resolvePaths({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' }, '/h')).toEqual({
      configFile: '/c/spur-board/config.yaml',
      secretsFile: '/c/spur-board/secrets.env',
      dbFile: '/d/spur-board/board.sqlite',
      lockFile: '/d/spur-board/board.lock',
    });
  });

  it('falls back to the home directory', () => {
    expect(resolvePaths({}, '/h')).toEqual({
      configFile: '/h/.config/spur-board/config.yaml',
      secretsFile: '/h/.config/spur-board/secrets.env',
      dbFile: '/h/.local/share/spur-board/board.sqlite',
      lockFile: '/h/.local/share/spur-board/board.lock',
    });
  });

  it('treats an empty or relative XDG dir as unset', () => {
    expect(resolvePaths({ XDG_CONFIG_HOME: '', XDG_DATA_HOME: 'data' }, '/h')).toEqual(
      resolvePaths({}, '/h'),
    );
  });
});

describe('loadConfig', () => {
  it('loads a valid config with defaults and the secrets map', () => {
    const { config, secrets } = load(makeHome({ secrets: SECRETS_TEXT }));
    expect(config.thresholds.staleMultiplier).toBe(3);
    expect(config.projects[0]?.id).toBe('board');
    expect(secrets).toEqual({ [SECRET_NAME]: 'value-to-hide-123456', OTHER_VALUE: 'two words' });
    expect(process.env[SECRET_NAME]).toBeUndefined();
    expect(process.env['OTHER_VALUE']).toBeUndefined();
  });

  it('accepts a missing secrets.env', () => {
    expect(load(makeHome()).secrets).toEqual({});
  });

  it('names the missing config file', () => {
    const home = makeHome({ config: null });
    expect(configError(home)).toContain(join(home, 'config.yaml'));
  });

  it('reports a YAML syntax error with line and column', () => {
    const message = configError(makeHome({ config: 'projects: []\nbad: : value\n' }));
    expect(message).toContain('invalid YAML');
    expect(message).toContain('line 2, column');
  });

  it('lists each invalid field by path, with a hint', () => {
    const home = makeHome({
      config: VALID_CONFIG_YAML.replace('repo: example-org/board', 'repo: bad') + 'extra: 1\n',
    });
    const message = configError(home);
    expect(message).toContain('  projects.0.tracker.repo: Expected owner/name');
    expect(message).toContain('  (root): ');
    expect(message).toContain(
      `hint: fix these fields in ${join(home, 'config.yaml')} and start the daemon again`,
    );
  });

  it('refuses the reserved project id', () => {
    const message = configError(
      makeHome({ config: VALID_CONFIG_YAML.replace('id: board', 'id: _board') }),
    );
    expect(message).toContain('  projects.0.id: "_board" is reserved');
    expect(message).not.toContain('Expected lowercase');
  });

  it('refuses a secrets.env readable by others', () => {
    const home = makeHome({ secrets: SECRETS_TEXT });
    chmodSync(join(home, 'secrets.env'), 0o644);
    const message = configError(home);
    expect(message).toContain(join(home, 'secrets.env'));
    expect(message).toContain('chmod 600');
    expect(message).not.toContain('value-to-hide-123456');
  });

  it('refuses a group-readable secrets.env', () => {
    expect(configError(makeHome({ secrets: SECRETS_TEXT, secretsMode: 0o640 }))).toContain(
      'chmod 600',
    );
  });

  it('refuses a group-writable secrets.env', () => {
    const message = configError(makeHome({ secrets: SECRETS_TEXT, secretsMode: 0o620 }));
    expect(message).toContain('0620');
    expect(message).toContain('chmod 600');
    expect(message).not.toContain('value-to-hide-123456');
  });
});
