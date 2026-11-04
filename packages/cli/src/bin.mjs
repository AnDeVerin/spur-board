#!/usr/bin/env node

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write('0.0.0\n');
} else {
  const { runCli } = await import('./cli.ts');
  process.exitCode = await runCli(argv);
}
