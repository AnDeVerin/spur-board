import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mergeMutationReports, replaceHtmlReport, summarizeMutation } from './mutation-summary.ts';

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
  const common = {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    projectRoot: '/repo',
    framework: { name: 'StrykerJS', version: '10.1.1' },
  };
  const test = (id: string, name: string, line: number) => ({
    id,
    name,
    location: { start: { line, column: 1 } },
  });

  it('joins the files of every shard report', () => {
    const a = { files: { 'a.ts': { mutants: mutants('Killed') } } };
    const b = { files: { 'b.ts': { mutants: mutants('Survived') } } };

    expect(mergeMutationReports([a, b])).toEqual({ files: { ...a.files, ...b.files } });
  });

  it('keeps the shared fields, drops the shard mutate and renumbers the tests', () => {
    const gates = {
      ...common,
      config: { mutate: ['gates.ts'], concurrency: 4 },
      testFiles: {
        'gates.test.ts': { source: 'g', tests: [test('0', 'gate', 3)] },
        'shared.test.ts': { source: 's', tests: [test('1', 'shared', 7)] },
      },
      files: {
        'gates.ts': {
          language: 'typescript',
          mutants: [
            { id: '0', status: 'Killed', coveredBy: ['0', '1'], killedBy: ['1'] },
            { id: '1', status: 'NoCoverage', coveredBy: [] },
          ],
        },
      },
    };
    const rest = {
      ...common,
      config: { mutate: ['**/*.ts', '!gates.ts'], concurrency: 4 },
      testFiles: {
        'shared.test.ts': { source: 's', tests: [test('0', 'shared', 7), test('1', 'other', 9)] },
      },
      files: {
        'rest.ts': {
          language: 'typescript',
          mutants: [{ id: '0', status: 'Survived', coveredBy: ['1', '0'] }],
        },
      },
    };

    expect(mergeMutationReports([gates, rest])).toEqual({
      ...common,
      config: { concurrency: 4 },
      testFiles: {
        'gates.test.ts': { source: 'g', tests: [test('0', 'gate', 3)] },
        'shared.test.ts': { source: 's', tests: [test('1', 'shared', 7), test('2', 'other', 9)] },
      },
      files: {
        'gates.ts': gates.files['gates.ts'],
        'rest.ts': {
          language: 'typescript',
          mutants: [{ id: '0', status: 'Survived', coveredBy: ['2', '1'] }],
        },
      },
    });
  });

  it('rejects shards that differ in a shared field or in config beyond mutate', () => {
    const report = (extra: object) => ({ ...common, ...extra, files: {} });

    expect(() =>
      mergeMutationReports([report({}), report({ thresholds: { high: 90, low: 60 } })]),
    ).toThrow('the shards differ in thresholds');
    expect(() => mergeMutationReports([report({}), report({ system: { ci: true } })])).toThrow(
      'the shards differ in system',
    );
    expect(() =>
      mergeMutationReports([
        report({ config: { mutate: ['a.ts'], concurrency: 4 } }),
        report({ config: { mutate: ['b.ts'], concurrency: 2 } }),
      ]),
    ).toThrow('differ in config beyond mutate');
  });

  it('rejects a mutant that names a test its shard does not list', () => {
    const report = {
      files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed', killedBy: ['5'] }] } },
    };

    expect(() => mergeMutationReports([report])).toThrow('a.ts names unknown test 5');
  });

  it('rejects a file named by two reports and a report without files', () => {
    const a = { files: { 'a.ts': { mutants: mutants('Killed') } } };

    expect(() => mergeMutationReports([a, a])).toThrow('a.ts is in two reports');
    expect(() => mergeMutationReports([a, { schemaVersion: '2' }])).toThrow(
      'missing a files object',
    );
  });
});

/** The script part of a Stryker 10 HTML page (html-reporter.js) around its report line. */
function strykerHtml(reportLiteral: string): string {
  return [
    '<script>',
    "      const app = document.querySelector('mutation-test-report-app');",
    `      app.report = ${reportLiteral};`,
    '      function updateTheme() {',
    '</script>',
  ].join('\n');
}

describe('replaceHtmlReport', () => {
  it('replaces the embedded report and breaks up tags as Stryker does', () => {
    const report = { files: { 'a.ts': { source: 'if (a </script> b) $& $1' } } };
    const page = replaceHtmlReport(strykerHtml('{"files":{}}'), report);

    expect(page).toBe(strykerHtml(JSON.stringify(report).replace(/</g, '<"+"')));
    expect(page).not.toContain('</script> b');
    const literal = page.split('app.report = ')[1]?.split(';\n')[0] ?? '';
    expect(JSON.parse(literal.replaceAll('<"+"', '<'))).toEqual(report);
  });

  it('rejects a page without exactly one report line', () => {
    expect(() => replaceHtmlReport('<html></html>', {})).toThrow('exactly one');
    expect(() => replaceHtmlReport(strykerHtml('{}') + strykerHtml('{}'), {})).toThrow(
      'exactly one',
    );
    expect(() => replaceHtmlReport('app.report = {}\n', {})).toThrow('does not end with ";"');
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

  it('writes the merged mutation.json and mutation.html with --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutation-summary-'));
    const a = { files: { 'a.ts': { mutants: mutants('Killed') } } };
    const b = { files: { 'b.ts': { mutants: mutants('Survived') } } };
    for (const [name, report] of [
      ['gates', a],
      ['rest', b],
    ] as const) {
      mkdirSync(join(dir, 'shards', name), { recursive: true });
      writeFileSync(join(dir, 'shards', name, 'mutation.json'), JSON.stringify(report));
      writeFileSync(
        join(dir, 'shards', name, 'mutation.html'),
        strykerHtml(JSON.stringify(report)),
      );
    }
    const out = join(dir, 'mutation');
    const shards = ['gates', 'rest'].map((name) => join(dir, 'shards', name, 'mutation.json'));

    const result = run(['--out', out, ...shards]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Total score: 50.00%');
    const merged = { files: { ...a.files, ...b.files } };
    expect(JSON.parse(readFileSync(join(out, 'mutation.json'), 'utf8'))).toEqual(merged);
    expect(readFileSync(join(out, 'mutation.html'), 'utf8')).toBe(
      strykerHtml(JSON.stringify(merged)),
    );

    writeFileSync(join(dir, 'shards', 'gates', 'mutation.html'), '<html></html>');
    const broken = run(['--out', join(dir, 'broken'), ...shards]);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('exactly one');
    expect(run(['--out']).status).toBe(2);
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
