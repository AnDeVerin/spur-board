import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    client: 'src/client.ts',
    daemon: '../daemon/src/main.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  deps: {
    alwaysBundle: [/^@spur-board\//],
    neverBundle: [
      'better-sqlite3',
      '@slack/socket-mode',
      '@slack/web-api',
      'fastify',
      'kysely',
      'pino',
      'yaml',
    ],
  },
});
