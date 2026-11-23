import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mergeMutationReports, summarizeMutation } from './mutation-summary.ts';

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

describe('mergeMutationReports', () => {
  it('joins the files of every shard report', () => {
    const a = { files: { 'a.ts': { mutants: mutants('Killed') } } };
    const b = { files: { 'b.ts': { mutants: mutants('Survived') } } };

    expect(mergeMutationReports([a, b])).toEqual({ files: { ...a.files, ...b.files } });
  });

  it('rejects a file named by two reports and a report without files', () => {
    const a = { files: { 'a.ts': { mutants: mutants('Killed') } } };

    expect(() => mergeMutationReports([a, a])).toThrow('a.ts is in two reports');
    expect(() => mergeMutationReports([a, { schemaVersion: '2' }])).toThrow(
      'missing a files object',
    );
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

  it('summarizes the shard reports together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutation-summary-'));
    const first = join(dir, 'first.json');
    const second = join(dir, 'second.json');
    writeFileSync(first, JSON.stringify({ files: { 'a.ts': { mutants: mutants('Killed') } } }));
    writeFileSync(second, JSON.stringify({ files: { 'b.ts': { mutants: mutants('Survived') } } }));

    const result = run([first, second]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Total score: 50.00%');
    expect(result.stdout).toContain('| a.ts | 1 |');
    expect(result.stdout).toContain('| b.ts | 0 |');

    const repeated = run([first, first]);
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('a.ts is in two reports');
  });
});

describe('mutation.yml shards', () => {
  const source = readFileSync(
    new URL('../.github/workflows/mutation.yml', import.meta.url),
    'utf8',
  );
  const workflow = parse(source) as {
    jobs: { mutation: { strategy: { matrix: { shard: { name: string; mutate: string }[] } } } };
  };
  const shards = workflow.jobs.mutation.strategy.matrix.shard;

  it('mutates every domain file once: the last shard takes what the others do not name', () => {
    const named = shards.slice(0, -1).map((shard) => shard.mutate);
    for (const file of named) expect(file).toMatch(/^packages\/core\/src\/domain\/[\w/-]+\.ts$/);
    expect(shards.at(-1)?.mutate.split(',')).toEqual([
      'packages/core/src/domain/**/*.ts',
      ...named.map((file) => `!${file}`),
    ]);
    expect(new Set(shards.map((shard) => shard.name)).size).toBe(shards.length);
  });
});
