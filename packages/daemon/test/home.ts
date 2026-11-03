import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VALID_CONFIG_YAML = `projects:
  - id: board
    tracker:
      type: github-issues
      repo: example-org/board
      label: board
    repos: [example-org/board]
    operatorGithubLogin: octocat
operator:
  slack: U0000000000
digest:
  tz: UTC
`;

interface HomeOptions {
  /** config.yaml text; null leaves the file out. Defaults to VALID_CONFIG_YAML. */
  config?: string | null;
  /** secrets.env text; left out when undefined. */
  secrets?: string;
  /** Mode for secrets.env; defaults to 0o600. */
  secretsMode?: number;
}

/** A fresh BOARD_HOME directory with config.yaml and, if asked, secrets.env. */
export function makeHome(options: HomeOptions = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'daemon-home-'));
  const config = options.config === undefined ? VALID_CONFIG_YAML : options.config;
  if (config !== null) writeFileSync(join(home, 'config.yaml'), config);
  if (options.secrets !== undefined) {
    const file = join(home, 'secrets.env');
    writeFileSync(file, options.secrets);
    chmodSync(file, options.secretsMode ?? 0o600);
  }
  return home;
}
