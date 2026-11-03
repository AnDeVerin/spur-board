import { spawn } from 'node:child_process';
import type { SpurPort } from '@spur-board/core';

/** Send a doorbell through Spur without invoking a shell. */
export function createSpurPort(): SpurPort {
  return {
    send(session, text) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn('spur', ['send', session, text], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('error', () => {
          reject(new Error('spur send failed to start'));
        });
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`spur send failed (${String(code)}): ${stderr.trim()}`));
        });
      });
    },
  };
}
