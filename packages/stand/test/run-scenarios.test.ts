import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scenarioPattern, unmatchedNames } from '../src/run-scenarios.ts';
import { scenarioNames } from '../src/scenarios/index.ts';

const SCRIPT = fileURLToPath(new URL('../src/run-scenarios.ts', import.meta.url));
const DESCRIBES = ['each scenario', 'curator scenarios', 'dispatcher scenarios'];

describe('scenarioPattern', () => {
  it('selects only the tests of its own name for every registered pair', () => {
    const names = scenarioNames();
    for (const a of names) {
      const own = new RegExp(scenarioPattern([a]));
      expect(own.test(`snapshots ${a} reaches wait scenario after a restore-reset`), a).toBe(true);
      for (const describe of DESCRIBES) {
        expect(own.test(`${describe} ${a}: seeds the state`), a).toBe(true);
        for (const b of names) {
          if (b === a) continue;
          expect(own.test(`${describe} ${b}: seeds the state`), `${a} vs ${b}`).toBe(false);
          expect(
            own.test(`snapshots ${b} reaches wait scenario after a restore-reset`),
            `${a} vs ${b}`,
          ).toBe(false);
        }
      }
    }
  });

  it('joins several names and escapes regex characters', () => {
    expect(scenarioPattern(['empty', 'a.b'])).toBe('(^| )(empty|a\\.b)[: ]');
  });
});

describe('unmatchedNames', () => {
  const report = (status: string) => ({
    testResults: [
      {
        assertionResults: [
          { fullName: 'each scenario x: seeds', status },
          { fullName: 'each scenario y: seeds', status: 'passed' },
        ],
      },
    ],
  });

  it('reports a name whose tests were all skipped', () => {
    expect(unmatchedNames(['x', 'y'], report('skipped'))).toEqual(['x']);
  });

  it('counts a failed test as run', () => {
    expect(unmatchedNames(['x', 'y'], report('failed'))).toEqual([]);
  });

  it('reports every name for an empty report', () => {
    expect(unmatchedNames(['x'], {})).toEqual(['x']);
  });
});

describe('run-scenarios CLI', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('refuses an unknown name before vitest starts and lists the known names', () => {
    const result = run('empty', 'nope');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown scenario nope; use one of empty, columns-basic');
    expect(result.stdout).toBe('');
  });

  it.each([[[]], [['--help']]])('prints usage for %j', (args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm stand:scenarios <name>...');
    expect(result.stderr).toContain('source-blind');
  });
});
