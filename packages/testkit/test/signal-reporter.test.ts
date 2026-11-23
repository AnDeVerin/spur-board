import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeRunning, writeAll, type WriteAllDeps } from '../src/signal-reporter.ts';

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

// A fake stderr: `steps` answers each write in turn with a byte count or an error code, and
// every write and pause moves the fake clock one tick.
function fakeStderr(steps: (number | string)[]) {
  const written: string[] = [];
  let clock = 0;
  let pauses = 0;
  const deps: WriteAllDeps = {
    write: (bytes) => {
      clock += 1;
      const step = steps.shift() ?? bytes.length;
      if (typeof step === 'string') throw Object.assign(new Error(step), { code: step });
      const count = Math.min(step, bytes.length);
      written.push(Buffer.from(bytes.subarray(0, count)).toString());
      return count;
    },
    now: () => clock,
    pause: () => {
      clock += 1;
      pauses += 1;
    },
  };
  return { deps, written, pauses: () => pauses };
}

describe('writeAll', () => {
  it('continues after partial writes until all of the text is out', () => {
    const fake = fakeStderr([3, 2]);
    expect(writeAll('abcdefgh', 100, fake.deps)).toBe(true);
    expect(fake.written).toEqual(['abc', 'de', 'fgh']);
  });

  it('retries EAGAIN after a pause', () => {
    const fake = fakeStderr(['EAGAIN', 'EAGAIN']);
    expect(writeAll('abc', 100, fake.deps)).toBe(true);
    expect(fake.written).toEqual(['abc']);
    expect(fake.pauses()).toBe(2);
  });

  it('gives up at the deadline while the reader does not drain', () => {
    const fake = fakeStderr(Array<string>(50).fill('EAGAIN'));
    expect(writeAll('abc', 10, fake.deps)).toBe(false);
    expect(fake.written).toEqual([]);
  });

  it('gives up on another write error', () => {
    const fake = fakeStderr(['EPIPE']);
    expect(writeAll('abc', 100, fake.deps)).toBe(false);
    expect(fake.pauses()).toBe(0);
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
      write(
        root,
        'packages/cli/test/hang.test.ts',
        `
import { it } from 'vitest';
it('waits for the signal', async () => {
  await new Promise((done) => setTimeout(done, 30_000));
}, 60_000);
`,
      );
      // The reporter writes this file once it has recorded the running test.
      const ready = join(root, 'reporter-ready');
      const run = spawn(
        process.execPath,
        [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'unit'],
        {
          cwd: root,
          env: { ...process.env, GITHUB_ACTIONS: 'false', SIGNAL_REPORTER_READY: ready },
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
      let deadline: NodeJS.Timeout | undefined;
      try {
        await vi.waitFor(
          () => {
            expect(run.exitCode, output).toBeNull();
            expect(existsSync(ready)).toBe(true);
          },
          { timeout: 15_000, interval: 50 },
        );
        run.kill('SIGTERM');
        // Well under the 30 s test timeout, so a run that never closes still reaches the
        // finally blocks below, which kill it and remove the fixture.
        const closeDeadline = new Promise<never>((_, fail) => {
          deadline = setTimeout(() => {
            fail(new Error(`the run did not close within 10 s of SIGTERM:\n${output}`));
          }, 10_000);
        });
        expect(await Promise.race([exited, closeDeadline]), output).toBe(143);
      } finally {
        clearTimeout(deadline);
        run.kill('SIGKILL');
      }
      expect(readFileSync(ready, 'utf8')).toBe('waits for the signal');
      expect(output).toContain('vitest: received SIGTERM with 1 test file(s) running:');
      expect(output).toContain('  packages/cli/test/hang.test.ts [unit]');
      expect(output).toContain('    > waits for the signal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
