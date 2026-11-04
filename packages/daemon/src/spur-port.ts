import { spawn } from 'node:child_process';
import type { SpurPort } from '@spur-board/core';

const SEND_TIMEOUT_MS = 8_000;
const KILL_GRACE_MS = 200;

/** Send a doorbell through Spur without invoking a shell. */
export function createSpurPort(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; killGraceMs?: number } = {},
): SpurPort {
  return {
    send(session, text) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn('spur', ['send', session, text], {
          stdio: ['ignore', 'ignore', 'pipe'],
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        let stderr = '';
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            child.kill('SIGKILL');
          }, options.killGraceMs ?? KILL_GRACE_MS);
        }, options.timeoutMs ?? SEND_TIMEOUT_MS);
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-1024);
        });
        child.once('error', () => {
          clearTimeout(timeout);
          if (killTimer !== undefined) clearTimeout(killTimer);
          reject(new Error('spur send failed to start'));
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          if (killTimer !== undefined) clearTimeout(killTimer);
          if (timedOut) {
            reject(new Error('spur send timed out'));
            return;
          }
          if (code === 0) resolve();
          else reject(new Error(`spur send failed (${String(code)}): ${stderr.trim()}`));
        });
      });
    },
  };
}
