// Turns Stryker JSON reports (mutation-testing-report-schema), one per mutation shard, into one
// Markdown job summary and, with --out, one merged JSON report and HTML page.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COLUMNS = ['Killed', 'Timeout', 'Survived', 'No coverage', 'Ignored', 'Errors'] as const;
type Column = (typeof COLUMNS)[number];
type Counts = Record<Column, number>;

const COLUMN_BY_STATUS: Record<string, Column> = {
  Killed: 'Killed',
  Timeout: 'Timeout',
  Survived: 'Survived',
  NoCoverage: 'No coverage',
  Ignored: 'Ignored',
  CompileError: 'Errors',
  RuntimeError: 'Errors',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyCounts(): Counts {
  return { Killed: 0, Timeout: 0, Survived: 0, 'No coverage': 0, Ignored: 0, Errors: 0 };
}

function countMutants(mutants: unknown, file: string): Counts {
  if (!Array.isArray(mutants)) throw new Error(`mutation report: ${file} has no mutants array`);
  const counts = emptyCounts();
  for (const mutant of mutants) {
    const status = isRecord(mutant) ? mutant['status'] : undefined;
    const column = typeof status === 'string' ? COLUMN_BY_STATUS[status] : undefined;
    if (column) counts[column] += 1;
  }
  return counts;
}

/** Detected (killed or timed out) over valid mutants, as Stryker scores it; errors and ignored are left out. */
function score(counts: Counts): string {
  const detected = counts.Killed + counts.Timeout;
  const valid = detected + counts.Survived + counts['No coverage'];
  return valid === 0 ? 'n/a' : `${((detected / valid) * 100).toFixed(2)}%`;
}

/** The Markdown summary of a parsed Stryker JSON report; throws when it has no `files` object. */
export function summarizeMutation(report: unknown): string {
  const files = isRecord(report) ? report['files'] : undefined;
  if (!isRecord(files)) throw new Error('mutation report: missing a files object');
  const total = emptyCounts();
  const rows: string[] = [];
  for (const name of Object.keys(files).sort()) {
    const entry = files[name];
    const counts = countMutants(isRecord(entry) ? entry['mutants'] : undefined, name);
    for (const column of COLUMNS) total[column] += counts[column];
    rows.push(`| ${name} | ${COLUMNS.map((column) => String(counts[column])).join(' | ')} |`);
  }
  return [
    '## Mutation score',
    '',
    'Score only, no threshold: a low score does not fail this workflow.',
    '',
    `Total score: ${score(total)}`,
    '',
    `| File | ${COLUMNS.join(' | ')} |`,
    `| --- | ${COLUMNS.map(() => '---:').join(' | ')} |`,
    ...rows,
    '',
  ].join('\n');
}

/** Top-level report fields the merge rebuilds; every other field must be the same in each shard. */
const MERGED_FIELDS = new Set(['files', 'testFiles', 'config']);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function remapIds(ids: unknown, testIds: Map<string, string>, file: string): unknown {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids))
    throw new Error(`mutation report: ${file} has a mutant with bad test ids`);
  return ids.map((id) => {
    const merged = typeof id === 'string' ? testIds.get(id) : undefined;
    if (merged === undefined)
      throw new Error(`mutation report: ${file} names unknown test ${String(id)}`);
    return merged;
  });
}

/**
 * One full report from the reports of the mutation shards. Each shard mutates its own files, so a
 * file named by two reports throws. Stryker numbers tests per run, so the tests get new ids: one
 * per test file, name and location, shared by the shards that ran it, and the mutants' `coveredBy`
 * and `killedBy` follow. The shard configs differ only in `mutate`, which the merged config drops;
 * any other field that differs between shards throws.
 */
export function mergeMutationReports(reports: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const files: Record<string, unknown> = {};
  const testFiles: Record<string, { tests: unknown[] } & Record<string, unknown>> = {};
  const idByTest = new Map<string, string>();
  let config: Record<string, unknown> | undefined;
  for (const [index, report] of reports.entries()) {
    const shard = isRecord(report) ? report['files'] : undefined;
    if (!isRecord(report) || !isRecord(shard)) {
      throw new Error('mutation report: missing a files object');
    }
    const fields = Object.entries(report).filter(([key]) => !MERGED_FIELDS.has(key));
    if (index === 0) Object.assign(merged, Object.fromEntries(fields));
    for (const key of new Set([...Object.keys(merged), ...fields.map(([key]) => key)])) {
      if (!sameJson(merged[key], report[key])) {
        throw new Error(`mutation report: the shards differ in ${key}`);
      }
    }
    const shardConfig = { ...(isRecord(report['config']) ? report['config'] : {}) };
    delete shardConfig['mutate'];
    if (index > 0 && !sameJson(config, shardConfig)) {
      throw new Error('mutation report: the shards differ in config beyond mutate');
    }
    config = shardConfig;

    const testIds = new Map<string, string>();
    const shardTests = isRecord(report['testFiles']) ? report['testFiles'] : {};
    for (const [name, entry] of Object.entries(shardTests)) {
      const tests = isRecord(entry) ? entry['tests'] : undefined;
      if (!isRecord(entry) || !Array.isArray(tests)) {
        throw new Error(`mutation report: test file ${name} has no tests array`);
      }
      const target = (testFiles[name] ??= { ...entry, tests: [] });
      for (const test of tests) {
        if (!isRecord(test) || typeof test['id'] !== 'string') {
          throw new Error(`mutation report: test file ${name} has a test without an id`);
        }
        const key = JSON.stringify([name, test['name'], test['location']]);
        let id = idByTest.get(key);
        if (id === undefined) {
          id = String(idByTest.size);
          idByTest.set(key, id);
          target.tests.push({ ...test, id });
        }
        testIds.set(test['id'], id);
      }
    }

    for (const [name, entry] of Object.entries(shard)) {
      if (Object.hasOwn(files, name)) throw new Error(`mutation report: ${name} is in two reports`);
      const mutants = isRecord(entry) ? entry['mutants'] : undefined;
      if (!isRecord(entry) || !Array.isArray(mutants)) {
        throw new Error(`mutation report: ${name} has no mutants array`);
      }
      files[name] = {
        ...entry,
        mutants: mutants.map((mutant: unknown) => {
          if (!isRecord(mutant)) return mutant;
          const coveredBy = remapIds(mutant['coveredBy'], testIds, name);
          const killedBy = remapIds(mutant['killedBy'], testIds, name);
          return {
            ...mutant,
            ...(coveredBy === undefined ? {} : { coveredBy }),
            ...(killedBy === undefined ? {} : { killedBy }),
          };
        }),
      };
    }
  }
  if (config !== undefined && Object.keys(config).length > 0) merged['config'] = config;
  if (Object.keys(testFiles).length > 0) merged['testFiles'] = testFiles;
  merged['files'] = files;
  return merged;
}

const HTML_MARKER = 'app.report = ';

/**
 * A shard's self-contained Stryker HTML page with its embedded report replaced by `report`, so
 * the merged report needs no Stryker install. Stryker 10's html reporter writes the report as one
 * `app.report = <json>;` line, with `<` broken up as its `escapeHtmlTags` does
 * (`@stryker-mutator/core` `dist/src/reporters/html-reporter.js`); throws unless the page has that
 * line exactly once.
 */
export function replaceHtmlReport(html: string, report: unknown): string {
  const start = html.indexOf(HTML_MARKER);
  if (start === -1 || html.indexOf(HTML_MARKER, start + 1) !== -1) {
    throw new Error(`mutation report: the HTML page needs exactly one "${HTML_MARKER}" line`);
  }
  const from = start + HTML_MARKER.length;
  const end = html.indexOf(';\n', from);
  const newline = html.indexOf('\n', from);
  if (end === -1 || end + 1 !== newline) {
    throw new Error('mutation report: the HTML report line does not end with ";"');
  }
  const json = JSON.stringify(report).replace(/</g, '<"+"');
  return html.slice(0, from) + json + html.slice(end);
}

const USAGE = 'usage: node scripts/mutation-summary.ts [--out <dir>] <report.json>...';

/**
 * Prints the summary of the shard reports. With `--out`, also writes the merged `mutation.json`
 * and `mutation.html` to that directory; the page comes from the `mutation.html` next to the
 * first report.
 */
function main(args: string[]): number {
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? undefined : args[outIndex + 1];
  const paths =
    outIndex === -1 ? args : args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (paths.length === 0 || (outIndex !== -1 && (out === undefined || out.startsWith('-')))) {
    console.error(USAGE);
    return 2;
  }
  try {
    const reports = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as unknown);
    const merged = mergeMutationReports(reports);
    const summary = summarizeMutation(merged);
    if (out !== undefined) {
      const html = readFileSync(join(dirname(paths[0] ?? ''), 'mutation.html'), 'utf8');
      const page = replaceHtmlReport(html, merged);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'mutation.json'), JSON.stringify(merged));
      writeFileSync(join(out, 'mutation.html'), page);
    }
    process.stdout.write(summary);
    return 0;
  } catch (error) {
    console.error(`mutation-summary: cannot summarize ${paths.join(' ')}`, error);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
