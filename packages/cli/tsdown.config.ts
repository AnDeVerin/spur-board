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
  // Rolldown names a shared chunk after its last module, so a new shared module can rename a chunk.
  // Give every shared chunk one fixed prefix, which the package allowlist admits
  // (scripts/package.ts).
  outputOptions: {
    chunkFileNames: 'chunk-[hash].mjs',
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
