import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    client: 'src/client.ts',
    daemon: '../daemon/src/main.ts',
    mcp: 'src/mcp.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  clean: true,
  // Rolldown names a shared chunk after its last module. Keep the chunk holding `src/config.ts`
  // named `config-*`, which the package allowlist admits (scripts/package.ts), whichever module
  // ends up last in it.
  outputOptions: {
    chunkFileNames: (chunk) =>
      `${chunk.moduleIds.some((id) => /[\\/]cli[\\/]src[\\/]config\.ts$/.test(id)) ? 'config' : '[name]'}-[hash].mjs`,
  },
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
      /^@modelcontextprotocol\/server(?:\/|$)/,
    ],
  },
});
