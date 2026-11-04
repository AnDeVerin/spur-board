import { describe, expect, it } from 'vitest';
import {
  buildSteps,
  mcpPackageSmokeCommands,
  parsePushRefs,
  prePushWorkers,
  pushRanges,
  selectPlan,
} from './check.ts';

const packageDirs = ['packages/cli', 'packages/daemon'];
const base = { kind: 'base' as const, ref: 'main', sha: 'abc' };

describe('pushed ref ranges', () => {
  const head = 'a'.repeat(40);
  const previous = 'b'.repeat(40);
  const zero = '0'.repeat(40);

  it('uses the remote old object for an existing ref', () => {
    const refs = parsePushRefs(`refs/heads/feature ${head} refs/heads/feature ${previous}\n`);
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, base)).toEqual([{ from: previous, to: head }]);
  });

  it('keeps a comparison range for every ref in a multi-ref push', () => {
    const otherPrevious = 'c'.repeat(40);
    const refs = parsePushRefs(
      `refs/heads/first ${head} refs/heads/first ${previous}\n` +
        `refs/heads/second ${head} refs/heads/second ${otherPrevious}\n`,
    );
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, base)).toEqual([
      { from: previous, to: head },
      { from: otherPrevious, to: head },
    ]);
  });

  it('uses the main merge base for a new remote ref', () => {
    const refs = parsePushRefs(`refs/heads/feature ${head} refs/heads/feature ${zero}\n`);
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, base)).toEqual([{ from: 'abc', to: head }]);
  });

  it('checks each pushed ref and refuses another branch outside the checkout', () => {
    const refs = parsePushRefs(
      `refs/heads/current ${head} refs/heads/current ${previous}\n` +
        `refs/heads/other ${'c'.repeat(40)} refs/heads/other ${previous}\n`,
    );
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, base)).toEqual({
      error:
        'pre-push: refs/heads/other is not checked out at HEAD; check out the ref before pushing it',
    });
  });

  it('skips a deletion because it pushes no new code', () => {
    const refs = parsePushRefs(`(delete) ${zero} refs/heads/old ${previous}\n`);
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, base)).toEqual([]);
  });

  it('requires a base for a new ref and rejects malformed input', () => {
    const refs = parsePushRefs(`refs/heads/feature ${head} refs/heads/feature ${zero}\n`);
    if ('error' in refs) throw new Error(refs.error);
    expect(pushRanges(refs, head, { kind: 'full', reason: 'no base ref' })).toEqual({
      error: 'pre-push: no base ref; create or update a local main or origin/main ref, then retry',
    });
    expect(parsePushRefs('')).toHaveProperty('error');
    expect(parsePushRefs('bad line\n')).toHaveProperty('error');
  });
});

describe('pre-push selection', () => {
  it('keeps a root documentation change in changed mode without package checks', () => {
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'README.md', deleted: false }],
      packageDirs,
    });
    expect(plan).toMatchObject({ mode: 'changed', packageDirs: [] });
    if ('error' in plan) throw new Error(plan.error);
    const steps = buildSteps(plan, true);
    expect(steps.map((step) => step.name)).toEqual(['format', 'lint', 'types', 'knip', 'test']);
    expect(steps.filter((step) => 'commands' in step).map((step) => step.name)).toEqual(['format']);
  });

  it('checks all affected packages for a shared config change without full mode', () => {
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'tsconfig.base.json', deleted: false }],
      packageDirs,
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan).toMatchObject({ mode: 'changed', packageDirs });
    const steps = buildSteps(plan, true);
    const types = steps.find((step) => step.name === 'types');
    if (!types || !('commands' in types)) throw new Error('missing type checks');
    expect(types.commands).toHaveLength(packageDirs.length);
    const tests = steps.find((step) => step.name === 'test');
    if (!tests || !('commands' in tests)) throw new Error('missing unit tests');
    expect(tests.commands[0]?.args).toEqual([
      'run',
      '--passWithNoTests',
      '--maxWorkers',
      '2',
      '--project',
      'unit',
      'packages/cli/',
      'packages/daemon/',
    ]);
  });

  it('selects only a directly changed package and unit tests with two workers', () => {
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'packages/cli/src/main.ts', deleted: false }],
      packageDirs,
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.packageDirs).toEqual(['packages/cli']);
    const steps = buildSteps(plan, true);
    const commands = steps.flatMap((step) => ('commands' in step ? step.commands : []));
    expect(commands.find((command) => command.cmd.endsWith('/vitest'))?.args).toEqual([
      'run',
      '--passWithNoTests',
      '--maxWorkers',
      '2',
      '--project',
      'unit',
      'packages/cli/',
    ]);
    expect(commands.map((command) => command.args.join(' ')).join(' ')).not.toMatch(
      /startup|integration|process|package-smoke|knip/,
    );
    expect(commands.filter((command) => command.cmd.endsWith('/tsc'))).toHaveLength(1);
  });

  it('does not format deleted files but checks their package', () => {
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'packages/daemon/src/old.ts', deleted: true }],
      packageDirs,
    });
    expect(plan).toMatchObject({
      formatFiles: [],
      lintFiles: [],
      packageDirs: ['packages/daemon'],
    });
  });

  it('fails with recovery guidance when there is no base', () => {
    expect(
      selectPlan({
        full: false,
        prePush: true,
        base: { kind: 'full', reason: 'no base ref' },
        changed: [],
        packageDirs,
      }),
    ).toEqual({
      error: 'pre-push: no base ref; create or update a local main or origin/main ref, then retry',
    });
  });

  it('validates the worker override', () => {
    expect(prePushWorkers(undefined)).toBe(2);
    expect(prePushWorkers('3')).toBe(3);
    for (const invalid of ['0', '-1', '1.5', 'nope', '9007199254740992'])
      expect(prePushWorkers(invalid)).toHaveProperty('error');
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'packages/daemon/src/main.ts', deleted: false }],
      packageDirs,
    });
    if ('error' in plan) throw new Error(plan.error);
    const tests = buildSteps(plan, true, 3).find((step) => step.name === 'test');
    if (!tests || !('commands' in tests)) throw new Error('missing test commands');
    expect(tests.commands[0]?.args).toContain('3');
  });
});

describe('ordinary and full process selection', () => {
  it('runs daemon process tests once for a daemon-only change', () => {
    const plan = selectPlan({
      full: false,
      prePush: false,
      base,
      changed: [{ path: 'packages/daemon/src/main.ts', deleted: false }],
      packageDirs,
    });
    if ('error' in plan) throw new Error(plan.error);
    const tests = buildSteps(plan, false).find((step) => step.name === 'test');
    if (!tests || !('commands' in tests)) throw new Error('missing test commands');
    expect(tests.commands[0]?.args).toEqual([
      'run',
      '--passWithNoTests',
      '--project',
      'unit',
      '--project',
      'integration',
      '--project',
      'process',
      'packages/daemon/',
    ]);
    expect(tests.commands).toHaveLength(1);
  });

  it('runs all projects once for a global hook change and a full check', () => {
    for (const changed of [[{ path: 'scripts/hooks.ts', deleted: false }], []]) {
      const plan = selectPlan({
        full: changed.length === 0,
        prePush: false,
        base,
        changed,
        packageDirs,
      });
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.mode).toBe('full');
      const tests = buildSteps(plan, false).find((step) => step.name === 'test');
      if (!tests || !('commands' in tests)) throw new Error('missing test commands');
      expect(tests.commands[0]?.args).toEqual([
        'run',
        '--project',
        'unit',
        '--project',
        'integration',
        '--project',
        'process',
      ]);
      expect(tests.commands.filter((command) => command.args.includes('--project'))).toHaveLength(
        2,
      );
      expect(tests.commands[1]?.args).toContain('startup');
    }
  });
});

describe('MCP package smoke selection', () => {
  it('runs for an affected CLI package', () => {
    expect(mcpPackageSmokeCommands('changed', ['packages/cli'])).toEqual([
      { cmd: 'node', args: ['scripts/package-smoke-mcp.ts'] },
    ]);
  });

  it('runs for a full check', () => {
    expect(mcpPackageSmokeCommands('full', [])).toHaveLength(1);
  });

  it('does not run for unrelated packages', () => {
    expect(mcpPackageSmokeCommands('changed', ['packages/core'])).toEqual([]);
  });
});
