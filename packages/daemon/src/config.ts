import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { configSchema, type Config } from '@spur-board/contracts';
import YAML from 'yaml';

/** A config or secrets file the daemon cannot use. The message is meant for the operator. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface Paths {
  configFile: string;
  secretsFile: string;
  dbFile: string;
  lockFile: string;
}

const APP = 'spur-board';

/** An empty or relative XDG directory counts as unset, as the XDG spec says. */
function xdgDir(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/**
 * BOARD_HOME holds all four files flat. Without it the config lives in the XDG config dir and
 * the database and its lock in the XDG data dir.
 */
export function resolvePaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Paths {
  const boardHome = env['BOARD_HOME'];
  if (boardHome !== undefined && boardHome !== '') {
    const dir = resolve(boardHome);
    return {
      configFile: join(dir, 'config.yaml'),
      secretsFile: join(dir, 'secrets.env'),
      dbFile: join(dir, 'board.sqlite'),
      lockFile: join(dir, 'board.lock'),
    };
  }
  const configDir = join(xdgDir(env['XDG_CONFIG_HOME'], join(home, '.config')), APP);
  const dataDir = join(xdgDir(env['XDG_DATA_HOME'], join(home, '.local', 'share')), APP);
  return {
    configFile: join(configDir, 'config.yaml'),
    secretsFile: join(configDir, 'secrets.env'),
    dbFile: join(dataDir, 'board.sqlite'),
    lockFile: join(dataDir, 'board.lock'),
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function readConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      throw new ConfigError(`config file not found: ${file}`, { cause: err });
    }
    throw err;
  }
  const hint = `hint: fix these fields in ${file} and start the daemon again`;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    const lines = doc.errors.map((error) => `  ${error.message}`);
    throw new ConfigError([`invalid YAML in ${file}:`, ...lines, hint].join('\n'));
  }
  const result = configSchema.safeParse(doc.toJS());
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) =>
        `  ${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
    );
    throw new ConfigError([`invalid config in ${file}:`, ...lines, hint].join('\n'));
  }
  return result.data;
}

/** secrets.env is optional. It must not be readable by group or others. */
function readSecrets(file: string): Readonly<Record<string, string>> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if (isNotFound(err)) return Object.freeze({});
    throw err;
  }
  try {
    const mode = fstatSync(fd).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new ConfigError(
        `${file} has mode ${mode.toString(8).padStart(4, '0')} and is readable by others; run chmod 600 ${file}`,
      );
    }
    const secrets: Record<string, string> = {};
    for (const [name, value] of Object.entries(parseEnv(readFileSync(fd, 'utf8')))) {
      if (value !== undefined) secrets[name] = value;
    }
    return Object.freeze(secrets);
  } finally {
    closeSync(fd);
  }
}

/** Reads and validates config.yaml and secrets.env. Never writes to the environment. */
export function loadConfig(paths: Paths): {
  config: Config;
  secrets: Readonly<Record<string, string>>;
} {
  return { config: readConfig(paths.configFile), secrets: readSecrets(paths.secretsFile) };
}
