#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
  const manifest = /** @type {unknown} */ (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  );
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('Invalid package version.');
  }
  process.stdout.write(`${manifest.version}\n`);
} else if (argv.length === 1 && argv[0] === 'mcp') {
  const { startMcp } = await import('./mcp.ts');
  startMcp();
} else {
  const { runCli } = await import('./cli.ts');
  process.exitCode = await runCli(argv);
}
