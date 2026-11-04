import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const binary = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));

describe('board startup', () => {
  it('prints its version in under 150 ms', () => {
    const start = performance.now();
    const result = spawnSync(process.execPath, [binary, '--version'], { encoding: 'utf8' });
    const elapsed = performance.now() - start;
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.0.0');
    expect(result.stderr).toBe('');
    expect(elapsed).toBeLessThan(150);
  });
});
