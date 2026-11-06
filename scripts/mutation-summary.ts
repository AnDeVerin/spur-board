// Turns a Stryker JSON report (mutation-testing-report-schema) into a Markdown job summary.
import { readFileSync } from 'node:fs';

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

function main(args: string[]): number {
  const path = args[0];
  if (!path) {
    console.error('usage: node scripts/mutation-summary.ts <report.json>');
    return 2;
  }
  try {
    process.stdout.write(summarizeMutation(JSON.parse(readFileSync(path, 'utf8'))));
    return 0;
  } catch (error) {
    console.error(`mutation-summary: cannot summarize ${path}`, error);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
