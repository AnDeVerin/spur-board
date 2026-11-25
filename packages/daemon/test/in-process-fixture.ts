import { join } from 'node:path';
import { configSchema, type Config } from '@spur-board/contracts';
import type { tickBoard } from '@spur-board/core';
import { acquireLock, type startInProcessDaemon } from '../src/in-process.ts';

export const configFor = (port: number) =>
  configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'example/repo' },
        repos: ['example/repo'],
        operatorGithubLogin: 'operator',
      },
    ],
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
    http: { port },
  });

/** What `daemonOptions` varies per test. */
export interface DaemonOptionsInput {
  tick: typeof tickBoard;
  port?: number;
  lines?: string[];
  shutdownTimeoutMs?: number;
  registerFatal?: (handler: (err: unknown) => void) => void;
  config?: Config;
  secrets?: Readonly<Record<string, string>>;
}

/** In-process daemon options: files under `home`, a real lock, a tick the test controls. */
export function daemonOptions(
  home: string,
  input: DaemonOptionsInput,
): Parameters<typeof startInProcessDaemon>[0] {
  return {
    paths: {
      configFile: join(home, 'config.yaml'),
      secretsFile: join(home, 'secrets.env'),
      dbFile: join(home, 'board.sqlite'),
      lockFile: join(home, 'board.lock'),
    },
    loadConfig: () => ({
      config: input.config ?? configFor(input.port ?? 0),
      secrets: input.secrets ?? {},
    }),
    acquireLock,
    clock: { now: () => Date.now() },
    stdout: {
      write(line: string) {
        input.lines?.push(line);
      },
    },
    writeErr(text) {
      throw new Error(text);
    },
    ports: {
      tick: input.tick,
      startAdapters: () => ({ stop: () => Promise.resolve() }),
    },
    ...(input.registerFatal === undefined ? {} : { registerFatal: input.registerFatal }),
    ...(input.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: input.shutdownTimeoutMs }),
  };
}
