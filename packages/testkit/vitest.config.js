// Vitest reads a config only from its root dir; a run started here would skip the root harness (#866).
export default {
  plugins: [
    {
      name: 'testkit-root-only',
      config() {
        throw new Error(
          'testkit: Vitest started in packages/testkit runs without the test harness. ' +
            'Run it from the repo root: pnpm exec vitest run packages/testkit/test/<file>',
        );
      },
    },
  ],
};
