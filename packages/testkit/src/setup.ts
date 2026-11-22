import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import { DIRS } from './global-setup.ts';
import { installNetworkGuard } from './network.ts';

function parentCommand(): string {
  try {
    return readFileSync(`/proc/${String(process.ppid)}/cmdline`, 'utf8')
      .replaceAll('\0', ' ')
      .trim()
      .slice(0, 200);
  } catch {
    return 'unknown';
  }
}

/**
 * A runner can hand workers an env without the harness dirs (its own TMPDIR or HOME). Pin them
 * back to this run's root so every temp dir a test makes stays under it.
 */
function pinRunDirs(): void {
  const root = inject('harnessRoot') as string | undefined;
  if (root === undefined) {
    throw new Error(
      'run tests through the root vitest config; global setup did not provide harnessRoot',
    );
  }
  const previousTmp = process.env['TMPDIR'];
  let changed = false;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('XDG_') && !(name in DIRS)) Reflect.deleteProperty(process.env, name);
  }
  for (const [name, sub] of Object.entries(DIRS)) {
    const dir = join(root, sub);
    if (process.env[name] !== dir) {
      changed = true;
      process.env[name] = dir;
    }
  }
  if (changed) {
    // Straight to stderr: the default reporter hides console output of passing files.
    process.stderr.write(
      `testkit: re-pinned HOME, TMPDIR and XDG_* to ${root} (TMPDIR was ${String(previousTmp)}, ` +
        `STRYKER_MUTATOR_WORKER=${String(process.env['STRYKER_MUTATOR_WORKER'])}, ` +
        `parent: ${parentCommand()})\n`,
    );
  }
}

pinRunDirs();
installNetworkGuard();
