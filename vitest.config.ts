import { defineConfig } from 'vitest/config';

// GitHub Actions gets failure annotations and a JUnit file in reports/ for the run's artifact.
// Local runs keep the Vitest default reporters.
const ci =
  process.env['GITHUB_ACTIONS'] === 'true'
    ? {
        reporters: ['default', 'github-actions', 'junit'],
        outputFile: { junit: 'reports/junit.xml' },
      }
    : {};

// The only Vitest config: every test runs through the testkit harness.
export default defineConfig({
  test: {
    ...ci,
    // Workers must be child processes that inherit the scrubbed env. With
    // `threads`, /proc/self/environ would be the unscrubbed main process's.
    pool: 'forks',
    globalSetup: ['./packages/testkit/src/global-setup.ts'],
    setupFiles: ['./packages/testkit/src/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [
            '**/*.integration.test.ts',
            'packages/cli/test/startup.test.ts',
            'scripts/hooks.test.ts',
            'packages/daemon/test/main.test.ts',
            'packages/daemon/test/single-instance.test.ts',
            'packages/stand/test/fake-cli.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'startup',
          include: ['packages/cli/test/startup.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts'],
          exclude: ['packages/stand/test/scenarios.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'stand',
          include: ['packages/stand/test/scenarios.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: [
            'scripts/hooks.test.ts',
            'packages/daemon/test/main.test.ts',
            'packages/daemon/test/single-instance.test.ts',
            'packages/stand/test/fake-cli.test.ts',
          ],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
