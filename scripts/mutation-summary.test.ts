import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarizeMutation } from './mutation-summary.ts';

function mutants(...statuses: string[]) {
  return statuses.map((status, index) => ({ id: String(index), mutatorName: 'X', status }));
}

describe('summarizeMutation', () => {
  it('scores killed and timed-out mutants over valid ones and counts each file', () => {
    const report = {
      schemaVersion: '2',
      files: {
        'b.ts': {
          mutants: mutants('Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Pending'),
        },
        'a.ts': {
          mutants: mutants('Killed', 'Killed', 'Killed', 'Timeout', 'Survived', 'Ignored'),
        },
      },
    };

    // detected 4 (3 killed + 1 timeout), valid 4 + 2 survived + 1 no coverage = 7 -> 57.14%.
    expect(summarizeMutation(report).split('\n')).toEqual([
      '## Mutation score',
      '',
      'Score only, no threshold: a low score does not fail this workflow.',
      '',
      'Total score: 57.14%',
      '',
      '| File | Killed | Timeout | Survived | No coverage | Ignored | Errors |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| a.ts | 3 | 1 | 1 | 0 | 1 | 0 |',
      '| b.ts | 0 | 0 | 1 | 1 | 0 | 2 |',
      '',
    ]);
  });

  it('prints n/a when no mutant is valid', () => {
    const report = { files: { 'a.ts': { mutants: mutants('Ignored', 'CompileError') } } };

    expect(summarizeMutation(report)).toContain('Total score: n/a\n');
  });

  it('rejects a report without a files object', () => {
    expect(() => summarizeMutation({ schemaVersion: '2' })).toThrow('missing a files object');
    expect(() => summarizeMutation(null)).toThrow('missing a files object');
  });
});

describe('mutation-summary.ts CLI', () => {
  const script = fileURLToPath(new URL('mutation-summary.ts', import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('exits 2 without a report path', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('exits 1 on an invalid report and prints the summary of a valid one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutation-summary-'));
    const invalid = join(dir, 'invalid.json');
    const valid = join(dir, 'valid.json');
    writeFileSync(invalid, '{"files": 1}');
    writeFileSync(valid, JSON.stringify({ files: { 'a.ts': { mutants: mutants('Killed') } } }));

    const failed = run([invalid]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('cannot summarize');

    const passed = run([valid]);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('Total score: 100.00%');
  });
});
