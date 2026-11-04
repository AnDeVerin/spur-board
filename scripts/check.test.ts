import { describe, expect, it } from 'vitest';
import { buildSteps, mcpPackageSmokeCommands, prePushWorkers, selectPlan } from './check.ts';

const packageDirs = ['packages/cli', 'packages/daemon'];
const base = { kind: 'base' as const, ref: 'main', sha: 'abc' };

describe('pre-push selection', () => {
  it('keeps root changes in changed mode without unrelated checks', () => {
    const plan = selectPlan({
      full: false,
      prePush: true,
      base,
      changed: [{ path: 'scripts/hooks.ts', deleted: false }],
      packageDirs,
    });
    expect(plan).toMatchObject({ mode: 'changed', packageDirs: [] });
    if ('error' in plan) throw new Error(plan.error);
    const steps = buildSteps(plan, true);
    expect(steps.map((step) => step.name)).toEqual(['format', 'lint', 'types', 'knip', 'test']);
    expect(steps.filter((step) => 'commands' in step).map((step) => step.name)).toEqual([
      'format',
      'lint',
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
