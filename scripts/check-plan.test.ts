import { describe, expect, it } from 'vitest';
import { runSteps, statusLine } from './check.ts';
import { parseNameStatus, planCheck, resolveBase } from './check-plan.ts';

describe('resolveBase', () => {
  const facts = {
    insideWorkTree: true,
    headExists: true,
    originMainMergeBase: 'aaa',
    mainMergeBase: 'bbb',
  };

  it('runs everything outside a git work tree', () => {
    expect(resolveBase({ ...facts, insideWorkTree: false })).toEqual({
      kind: 'full',
      reason: 'not a git repository',
    });
  });

  it('runs everything on an unborn HEAD', () => {
    expect(resolveBase({ ...facts, headExists: false })).toEqual({
      kind: 'full',
      reason: 'no commits yet',
    });
  });

  it('prefers origin/main', () => {
    expect(resolveBase(facts)).toEqual({ kind: 'base', ref: 'origin/main', sha: 'aaa' });
  });

  it('falls back to main', () => {
    expect(resolveBase({ ...facts, originMainMergeBase: null })).toEqual({
      kind: 'base',
      ref: 'main',
      sha: 'bbb',
    });
  });

  it('runs everything without a base ref', () => {
    expect(resolveBase({ ...facts, originMainMergeBase: null, mainMergeBase: null })).toEqual({
      kind: 'full',
      reason: 'no base ref',
    });
  });
});

describe('parseNameStatus', () => {
  it('marks only D as deleted', () => {
    expect(parseNameStatus('M\ta.ts\nA\tb.ts\nD\tc.ts\n')).toEqual([
      { path: 'a.ts', deleted: false },
      { path: 'b.ts', deleted: false },
      { path: 'c.ts', deleted: true },
    ]);
  });

  it('reads a --no-renames rename as D plus A', () => {
    expect(parseNameStatus('D\told.ts\nA\tnew.ts')).toEqual([
      { path: 'old.ts', deleted: true },
      { path: 'new.ts', deleted: false },
    ]);
  });

  it('reads a three-field rename line', () => {
    expect(parseNameStatus('R100\told\tnew')).toEqual([
      { path: 'old', deleted: true },
      { path: 'new', deleted: false },
    ]);
  });

  it('reads a three-field copy line as the new path only', () => {
    expect(parseNameStatus('C100\tsrc\tnew')).toEqual([{ path: 'new', deleted: false }]);
  });
});

describe('planCheck', () => {
  const packageDirs = ['packages/contracts', 'packages/testkit'];
  const everything = { formatFiles: ['.'], lintFiles: ['.'], packageDirs };

  it('runs everything with --full', () => {
    expect(planCheck({ full: true, changed: [], packageDirs })).toEqual({
      mode: 'full',
      reason: '--full',
      ...everything,
    });
  });

  it.each(['.gitignore', 'pnpm-lock.yaml', 'tsconfig.base.json', 'scripts/check.ts'])(
    'runs everything when %s changes',
    (path) => {
      expect(
        planCheck({
          full: false,
          changed: [
            { path: 'packages/contracts/src/index.ts', deleted: false },
            { path, deleted: false },
          ],
          packageDirs,
        }),
      ).toEqual({ mode: 'full', reason: `${path} changed`, ...everything });
    },
  );

  it('checks an untracked file in a package', () => {
    const plan = planCheck({
      full: false,
      changed: [{ path: 'packages/contracts/src/new.ts', deleted: false }],
      packageDirs,
    });
    expect(plan).toMatchObject({
      mode: 'changed',
      formatFiles: ['packages/contracts/src/new.ts'],
      lintFiles: ['packages/contracts/src/new.ts'],
      packageDirs: ['packages/contracts'],
    });
  });

  it('keeps the package of a deleted file but does not lint the file', () => {
    const plan = planCheck({
      full: false,
      changed: [
        { path: 'packages/contracts/src/old.ts', deleted: true },
        { path: 'packages/contracts/src/new.ts', deleted: false },
      ],
      packageDirs,
    });
    expect(plan).toMatchObject({
      mode: 'changed',
      formatFiles: ['packages/contracts/src/new.ts'],
      lintFiles: ['packages/contracts/src/new.ts'],
      packageDirs: ['packages/contracts'],
    });
  });

  it('only formats a root Markdown change', () => {
    expect(
      planCheck({ full: false, changed: [{ path: 'README.md', deleted: false }], packageDirs }),
    ).toMatchObject({
      mode: 'changed',
      formatFiles: ['README.md'],
      lintFiles: [],
      packageDirs: [],
    });
  });

  it('does nothing without changes', () => {
    expect(planCheck({ full: false, changed: [], packageDirs })).toEqual({
      mode: 'none',
      reason: 'no changes',
      formatFiles: [],
      lintFiles: [],
      packageDirs: [],
    });
  });
});

describe('runSteps', () => {
  const exit = (code: number) => ({
    cmd: process.execPath,
    args: ['-e', `process.exit(${String(code)})`],
  });

  it('runs every step and returns the first failing exit code', () => {
    const lines: string[] = [];
    const code = runSteps(
      [
        { name: 'a', commands: [exit(0)] },
        { name: 'b', commands: [exit(3), exit(0)] },
        { name: 'c', skip: 'nothing to do' },
        { name: 'd', commands: [exit(5)] },
      ],
      (line) => lines.push(line),
    );
    expect(code).toBe(3);
    expect(lines).toEqual([
      'check: a ok',
      'check: b FAIL (exit 3)',
      'check: c skipped (nothing to do)',
      'check: d FAIL (exit 5)',
    ]);
  });

  it('returns 127 when a command cannot start', () => {
    expect(
      runSteps([{ name: 'x', commands: [{ cmd: '/nonexistent/tool', args: [] }] }], () => {}),
    ).toBe(127);
  });

  it('prints the final status line', () => {
    expect(statusLine(0)).toBe('CHECK PASS');
    expect(statusLine(3)).toBe('CHECK FAIL (exit 3)');
  });
});
