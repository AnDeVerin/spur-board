import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { scrubEnv } from './env.ts';

declare module 'vitest' {
  interface ProvidedContext {
    harnessRoot: string;
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

  project.provide('harnessRoot', root);
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
