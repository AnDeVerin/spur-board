import { defineConfig } from 'vitest/config';

// The only Vitest config: every test runs through the testkit harness.
export default defineConfig({
  test: {
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
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts'],
        },
      },
    ],
  },
});
