import { defineConfig } from 'vitest/config';

// GitHub Actions gets failure annotations and a JUnit file in reports/ for the run's artifact.
// Local runs keep the Vitest default reporter. Both print the running test files on SIGTERM.
const signals = './packages/testkit/src/signal-reporter.ts';
const reporting =
  process.env['GITHUB_ACTIONS'] === 'true'
    ? {
        reporters: ['default', 'github-actions', 'junit', signals],
        outputFile: { junit: 'reports/junit.xml' },
      }
    : { reporters: ['default', signals] };

// The only Vitest config: every test runs through the testkit harness.
export default defineConfig({
  test: {
    ...reporting,
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
            'packages/testkit/test/web-assets.test.ts',
            'packages/daemon/test/main.test.ts',
            'packages/daemon/test/single-instance.test.ts',
            'packages/stand/test/fake-cli.test.ts',
            'packages/web/test/kit.test.ts',
            'packages/testkit/test/signal-reporter.test.ts',
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
            'packages/testkit/test/web-assets.test.ts',
            'packages/daemon/test/main.test.ts',
            'packages/daemon/test/single-instance.test.ts',
            'packages/stand/test/fake-cli.test.ts',
            'packages/web/test/kit.test.ts',
            'packages/testkit/test/signal-reporter.test.ts',
          ],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
