import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

/** Where the stand guard looks for the live config with no BOARD_HOME or XDG_CONFIG_HOME. */
export function liveConfigDir(osHome: string): string {
  return join(osHome, '.config', 'spur-board');
}

/**
 * Writes a minimal valid live board `config.yaml` into `dir`: `http.port` 4777 unless given, and
 * `web` and `stand.portRange` only when given.
 */
export function writeLiveConfig(
  dir: string,
  options: {
    httpPort?: number;
    web?: { port: number; publicOrigin: string };
    portRange?: { min: number; max: number };
  } = {},
): string {
  const config = {
    projects: [
      {
        id: 'board',
        tracker: { type: 'github-issues', repo: 'example/board', label: 'board' },
        repos: ['example/board'],
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'U0000000000' },
    slack: { channels: { feed: 'C000000002' } },
    digest: { tz: 'UTC' },
    http: { port: options.httpPort ?? 4777 },
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.portRange === undefined ? {} : { stand: { portRange: options.portRange } }),
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.yaml');
  writeFileSync(file, YAML.stringify(config));
  return file;
}
