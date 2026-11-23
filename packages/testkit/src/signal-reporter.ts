import { writeFileSync, writeSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';

/** The lines printed for a SIGTERM: each running test file, with its running tests. */
export function describeRunning(running: ReadonlyMap<string, ReadonlySet<string>>): string {
  if (running.size === 0) return 'vitest: received SIGTERM with no test file running\n';
  const lines = [`vitest: received SIGTERM with ${String(running.size)} test file(s) running:`];
  for (const [file, tests] of running) {
    lines.push(`  ${file}`);
    for (const test of tests) lines.push(`    > ${test}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface WriteAllDeps {
  /** Writes from the start of `bytes` and returns how many it wrote; throws on error. */
  write: (bytes: Uint8Array) => number;
  now: () => number;
  /** Waits briefly before a retry after EAGAIN. */
  pause: () => void;
}

const stderrDeps: WriteAllDeps = {
  write: (bytes) => writeSync(2, bytes),
  now: () => Date.now(),
  pause: () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  },
};

/**
 * Writes all of `text` synchronously before the process exits. libuv makes a piped stderr
 * non-blocking and `process.stderr.write` can leave the text queued, so an exit right after it
 * loses the text. This loops on partial writes and retries EAGAIN until `deadlineMs`, so a
 * reader that never drains cannot hang the exit. Returns whether all of it was written.
 */
export function writeAll(text: string, deadlineMs = 2_000, deps = stderrDeps): boolean {
  const bytes = Buffer.from(text);
  const deadline = deps.now() + deadlineMs;
  let offset = 0;
  while (offset < bytes.length) {
    if (deps.now() > deadline) return false;
    try {
      offset += deps.write(bytes.subarray(offset));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return false;
      deps.pause();
    }
  }
  return true;
}

/**
 * Prints the test files and tests running when the Vitest main process gets SIGTERM. A test
 * that signals its own process group (for example `process.kill(0)`) kills the whole run
 * without a failing test; the list narrows the sender to the files running at that moment, but
 * does not identify it (#884). Vitest's own SIGTERM handler still sets the exit code and exits.
 *
 * `SIGNAL_REPORTER_READY`, set only by this reporter's own test, names a file written each
 * time the reporter records a running test, so the test can signal once the reporter knows.
 */
export default class SignalReporter implements Reporter {
  private readonly running = new Map<string, Set<string>>();
  private root = process.cwd();
  private readonly readyFile = process.env['SIGNAL_REPORTER_READY'];

  private readonly onSigterm = (): void => {
    writeAll(describeRunning(this.running));
    process.off('SIGTERM', this.onSigterm);
    // With no other listener left, die of the signal as Node would without this one.
    if (process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM');
  };

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
    // First, so Vitest's own once-listener is still counted when this one runs.
    process.prependListener('SIGTERM', this.onSigterm);
    vitest.onClose(() => {
      process.off('SIGTERM', this.onSigterm);
    });
  }

  onTestModuleStart(testModule: TestModule): void {
    this.running.set(this.fileOf(testModule), new Set());
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.running.delete(this.fileOf(testModule));
  }

  onTestCaseReady(testCase: TestCase): void {
    const tests = this.running.get(this.fileOf(testCase.module));
    tests?.add(testCase.fullName);
    if (tests && this.readyFile !== undefined) writeFileSync(this.readyFile, testCase.fullName);
  }

  onTestCaseResult(testCase: TestCase): void {
    this.running.get(this.fileOf(testCase.module))?.delete(testCase.fullName);
  }

  private fileOf(testModule: TestModule): string {
    return `${relative(this.root, testModule.moduleId)} [${testModule.project.name}]`;
  }
}
