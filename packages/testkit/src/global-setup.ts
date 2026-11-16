import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { scrubEnv } from './env.ts';

declare module 'vitest' {
  interface ProvidedContext {
    harnessRoot: string;
    webAssetsRoot: string;
  }
}

const DIRS = {
  HOME: 'home',
  TMPDIR: 'tmp',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'runtime',
} as const;

/**
 * Runs once in the Vitest main process, before any worker forks. Workers inherit
 * `process.env` from here, so the scrub also keeps secrets out of their OS environ.
 */
export default function setup(project: TestProject): () => void {
  scrubEnv(process.env);

  const root = mkdtempSync(join(tmpdir(), 'spur-board-test-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('XDG_')) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  for (const [name, sub] of Object.entries(DIRS)) {
    const dir = join(root, sub);
    mkdirSync(dir, { mode: 0o700 });
    process.env[name] = dir;
  }

  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
  };
  const webRoot = join(project.config.root, 'packages/web');
  const webAssetsRoot = join(root, 'web');
  // Vitest runs root global setup once, before any selected project's worker pool.
  // Always rebuild into this run's owned directory; never clean shared workspace assets.
  const built = spawnSync(
    process.execPath,
    [
      join(webRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      webAssetsRoot,
      '--emptyOutDir',
    ],
    { cwd: webRoot, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
  );
  if (built.status !== 0) {
    cleanup();
    const message = `Test web asset build failed: ${built.stderr || built.stdout}`;
    process.stderr.write(`${message}\n`);
    throw new Error(message, {
      cause: built.error,
    });
  }
  project.provide('harnessRoot', root);
  project.provide('webAssetsRoot', webAssetsRoot);
  return cleanup;
}
