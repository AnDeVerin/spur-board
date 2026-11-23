import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeRunning } from '../src/signal-reporter.ts';

const repository = resolve(import.meta.dirname, '../../..');

function write(root: string, name: string, content: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('describeRunning', () => {
  it('names each running file and its running tests', () => {
    const running = new Map([
      ['packages/cli/test/update.test.ts [unit]', new Set(['U8: a killed update'])],
      ['packages/contracts/test/config.test.ts [unit]', new Set<string>()],
    ]);
    expect(describeRunning(running)).toBe(
      [
        'vitest: received SIGTERM with 2 test file(s) running:',
        '  packages/cli/test/update.test.ts [unit]',
        '    > U8: a killed update',
        '  packages/contracts/test/config.test.ts [unit]',
        '',
      ].join('\n'),
    );
  });

  it('says when no file is running', () => {
    expect(describeRunning(new Map())).toBe('vitest: received SIGTERM with no test file running\n');
  });
});

describe('SIGTERM to a test run', () => {
  it('prints the running test file and test from the root config, then exits 143', async () => {
    const root = mkdtempSync(join(tmpdir(), 'signal-reporter-'));
    try {
      write(root, 'package.json', '{"type":"module"}');
      cpSync(join(repository, 'vitest.config.ts'), join(root, 'vitest.config.ts'));
      cpSync(join(repository, 'packages/testkit/src'), join(root, 'packages/testkit/src'), {
        recursive: true,
      });
      symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
      // The global setup builds web assets with packages/web's vite; a stub keeps it instant.
      write(
        root,
        'packages/web/node_modules/vite/bin/vite.js',
        `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), 'assets');
`,
      );
      const started = join(root, 'started');
      write(
        root,
        'packages/cli/test/hang.test.ts',
        `
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
it('waits for the signal', async () => {
  // Vitest sends test events to the main process at most every 100 ms; the marker comes
  // well after this test's ready event has left the worker.
  await new Promise((done) => setTimeout(done, 1_000));
  writeFileSync(${JSON.stringify(started)}, 'yes');
  await new Promise((done) => setTimeout(done, 30_000));
}, 60_000);
`,
      );
      const run = spawn(
        process.execPath,
        [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit'],
        {
          cwd: root,
          env: { ...process.env, GITHUB_ACTIONS: 'false' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      run.stdout.setEncoding('utf8').on('data', (text: string) => (output += text));
      run.stderr.setEncoding('utf8').on('data', (text: string) => (output += text));
      const exited = new Promise<number | null>((done) => {
        // `close`, not `exit`: it fires after the piped output is read to the end.
        run.once('close', (code) => {
          done(code);
        });
      });
      try {
        await vi.waitFor(
          () => {
            expect(run.exitCode, output).toBeNull();
            expect(existsSync(started)).toBe(true);
          },
          { timeout: 20_000, interval: 50 },
        );
        run.kill('SIGTERM');
        expect(await exited, output).toBe(143);
      } finally {
        run.kill('SIGKILL');
      }
      expect(output).toContain('vitest: received SIGTERM with 1 test file(s) running:');
      expect(output).toContain('  packages/cli/test/hang.test.ts [unit]');
      expect(output).toContain('    > waits for the signal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
