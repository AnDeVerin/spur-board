import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

// The harness scrubs BOARD_* from the environment, so BOARD_HOME is always passed explicitly.
function daemonEnv(home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, BOARD_HOME: home, ...env };
}

/** Starts src/main.ts, the file the `daemon` script runs, as a child process. */
export function spawnDaemon(
  home: string,
  env: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [MAIN], { env: daemonEnv(home, env) });
}

/** Runs a daemon that is expected to exit on its own, and returns its status and output. */
export function runDaemonToExit(
  home: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [MAIN], {
    env: daemonEnv(home, env),
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Resolves with the first JSON stdout line whose `msg` is `msg`; rejects if the child exits first. */
export function waitForLine(
  child: ChildProcessWithoutNullStreams,
  msg: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null): void => {
      reject(new Error(`daemon exited (${String(code)}) before "${msg}": ${stderr}`));
    };
    lines.on('line', (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed['msg'] !== msg) return;
      child.off('exit', onExit);
      child.stderr.off('data', onStderr);
      resolve(parsed);
    });
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}
