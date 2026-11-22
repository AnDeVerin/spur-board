import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, onTestFinished } from 'vitest';

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

/** Board projects alpha and beta both list Spur project shared, which the config refuses. */
export const SHARED_SPUR_PROJECT_CONFIG_YAML = `projects:
${['alpha', 'beta']
  .map(
    (id) => `  - id: ${id}
    tracker:
      type: github-issues
      repo: example-org/${id}
      label: board
    repos: [example-org/${id}]
    operatorGithubLogin: octocat
    spurProjects:
      - name: shared
        role: worker
`,
  )
  .join('')}operator:
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
  /** Test listener port; a distinct port is chosen when omitted. */
  httpPort?: number;
}

function nextHttpPort(): number {
  // Stay below the Linux ephemeral range used by outbound test connections.
  return 20_000 + Math.floor(Math.random() * 10_000);
}

/**
 * Removes `dir` after the current test's afterEach hooks, or after the enclosing suite when
 * called outside a test. Never fails a test; global teardown removes what is left.
 */
function removeAfterTest(dir: string): void {
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Global teardown and the next run's sweep remove what is left.
    }
  };
  try {
    onTestFinished(remove);
  } catch {
    try {
      afterAll(remove);
    } catch {
      // Not inside a suite either: global teardown removes it.
    }
  }
}

/**
 * A fresh BOARD_HOME directory with config.yaml and, if asked, secrets.env. It is removed
 * after the test, or after the suite when made outside a test.
 */
export function makeHome(options: HomeOptions = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'daemon-home-'));
  removeAfterTest(home);
  const config = options.config === undefined ? VALID_CONFIG_YAML : options.config;
  if (config !== null) {
    writeFileSync(
      join(home, 'config.yaml'),
      `${config}\nhttp:\n  port: ${String(options.httpPort ?? nextHttpPort())}\n`,
    );
  }
  if (options.secrets !== undefined) {
    const file = join(home, 'secrets.env');
    writeFileSync(file, options.secrets);
    chmodSync(file, options.secretsMode ?? 0o600);
  }
  return home;
}
