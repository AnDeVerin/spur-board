import { describe, expect, it } from 'vitest';
import { packageSmokeCommands } from './check.ts';

describe('package smoke selection', () => {
  it('runs for an affected CLI package', () => {
    expect(packageSmokeCommands('changed', ['packages/cli'])).toEqual([
      { cmd: 'node', args: ['scripts/package-smoke.ts'] },
    ]);
  });

  it('runs for a full check', () => {
    expect(packageSmokeCommands('full', [])).toHaveLength(1);
  });

  it('does not run for unrelated packages', () => {
    expect(packageSmokeCommands('changed', ['packages/core'])).toEqual([]);
  });
});
