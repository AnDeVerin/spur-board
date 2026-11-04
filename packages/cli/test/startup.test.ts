import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const binary = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('board startup', () => {
  it('prints its version in under 150 ms', () => {
    // Concurrent test workers can delay one child; require the median startup to meet the budget.
    const launches = Array.from({ length: 3 }, () => {
      const start = performance.now();
      const result = spawnSync(process.execPath, [binary, '--version'], { encoding: 'utf8' });
      const elapsed = performance.now() - start;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(manifest.version);
      expect(result.stderr).toBe('');
      return elapsed;
    });
    const median = launches.sort((a, b) => a - b)[1];
    expect(median).toBeLessThan(150);
  });
});
