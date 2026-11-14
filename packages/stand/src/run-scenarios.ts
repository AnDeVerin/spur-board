// Runs the stand tests of the named scenarios only: `pnpm stand:scenarios <name>...`. It checks
// the names against the registry before Vitest starts, selects the tests by an anchored `-t`
// pattern, and fails when a name ran no test, because Vitest exits 0 when `-t` matches nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioNames } from './scenarios/index.ts';

/** The slice of Vitest's JSON report this script reads. */
interface Report {
  testResults?: { assertionResults?: { fullName?: string; status?: string }[] }[];
}

const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches `<describe> <name>: ...` and `<describe> <name> reaches ...`, but not a name that only
 * ends or starts with `<name>`, such as `dispatch-source-blind` or `source-blind-jira`.
 */
export const scenarioPattern = (names: readonly string[]): string =>
  `(^| )(${names.map(escape).join('|')})[: ]`;

/** The names with no `passed` or `failed` test in the report. */
export function unmatchedNames(names: readonly string[], report: Report): string[] {
  const ran = (report.testResults ?? [])
    .flatMap(({ assertionResults }) => assertionResults ?? [])
    .filter(({ status }) => status === 'passed' || status === 'failed')
    .map(({ fullName }) => fullName ?? '');
  return names.filter((name) => {
    const own = new RegExp(scenarioPattern([name]));
    return !ran.some((fullName) => own.test(fullName));
  });
}

function main(args: readonly string[]): number {
  const known = scenarioNames();
  if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) {
    process.stderr.write(`usage: pnpm stand:scenarios <name>...\nscenarios: ${known.join(', ')}\n`);
    return 2;
  }
  const unknown = args.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    process.stderr.write(
      `stand:scenarios: unknown scenario ${unknown}; use one of ${known.join(', ')}\n`,
    );
    return 2;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir = mkdtempSync(join(tmpdir(), 'stand-scenarios-'));
  try {
    const reportFile = join(dir, 'report.json');
    const run = spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      [
        'run',
        '--project',
        'stand',
        '-t',
        scenarioPattern(args),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (run.error !== undefined) throw run.error;
    if (run.status !== 0) return run.status ?? 1;
    if (!existsSync(reportFile)) {
      process.stderr.write('stand:scenarios: vitest wrote no report\n');
      return 1;
    }
    const missed = unmatchedNames(args, JSON.parse(readFileSync(reportFile, 'utf8')) as Report);
    for (const name of missed) process.stderr.write(`stand:scenarios: ${name} matched no test\n`);
    return missed.length === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
