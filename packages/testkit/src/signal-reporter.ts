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

/**
 * Prints the running test files and tests when the Vitest main process gets SIGTERM. A test
 * that signals its own process group (for example `process.kill(0)`) kills the whole run
 * without a failing test; this line names the files that were running at that moment (#884).
 * Vitest's own SIGTERM handler still sets the exit code and exits.
 */
export default class SignalReporter implements Reporter {
  private readonly running = new Map<string, Set<string>>();
  private root = process.cwd();

  private readonly onSigterm = (): void => {
    process.stderr.write(describeRunning(this.running));
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
    this.running.get(this.fileOf(testCase.module))?.add(testCase.fullName);
  }

  onTestCaseResult(testCase: TestCase): void {
    this.running.get(this.fileOf(testCase.module))?.delete(testCase.fullName);
  }

  private fileOf(testModule: TestModule): string {
    return `${relative(this.root, testModule.moduleId)} [${testModule.project.name}]`;
  }
}
