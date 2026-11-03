// `pnpm guardrails [base]`: reports the changes to tests and checks a pull request must explain in
// its `## Changed checks` section. Locally it compares committed HEAD with its merge base with
// <base> (default origin/main). In a `pull_request` run it compares the merge ref with its first
// parent and fails when a reported file is missing from the PR description.
// Imports only `node:` builtins and ./check-plan.ts, so the CI job skips `pnpm install`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseNameStatus } from './check-plan.ts';

export const RULE_IDS = [
  'deleted-test',
  'fewer-expects',
  'added-skip',
  'snapshot',
  'config',
  'testkit',
  'added-escape',
] as const;

type RuleId = (typeof RULE_IDS)[number];

const RULE_TEXT: Record<RuleId, string> = {
  'deleted-test': 'deleted or renamed test file',
  'fewer-expects': 'fewer expect assertions',
  'added-skip': 'added .skip, .todo or .only',
  snapshot: 'changed snapshot or golden file',
  config: 'changed test, lint, TypeScript or CI config',
  testkit: 'changed shared test kit',
  'added-escape': 'added eslint-disable, @ts-expect-error, @ts-ignore or as any',
};

export interface Hunk {
  removed: string[];
  added: string[];
}

/** One changed file. `baseText`/`headText` are set for every M test file and M package.json. */
export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D';
  hunks: Hunk[];
  baseText?: string;
  headText?: string;
}

interface Finding {
  path: string;
  rule: RuleId;
  detail: string;
}

const CODE = /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/;
const WHOLE_FILE_CONFIG = [
  /^\.github\//,
  /(^|\/)eslint\.config\./,
  /^eslint\//,
  /(^|\/)vitest\.config\./,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^knip\.json$/,
  /(^|\/)\.prettierrc/,
  /^\.prettierignore$/,
  /^renovate\.json$/,
  /^scripts\//,
  /^\.pnpmfile\.[cm]?js$/,
  /^\.npmrc$/,
  /^pnpm-workspace\.yaml$/,
];
const PACKAGE_JSON = /(^|\/)package\.json$/;
const SKIP = /\b(?:describe|it|test|suite|bench)(?:\.\w+)*\.(?:skip|todo|only)\b/;
const SNAPSHOT_MATCHER =
  /\b(?:toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot)\b/;
const ESCAPES = [/eslint-disable/, /@ts-expect-error/, /@ts-ignore/, /\bas\s+any\b/];
const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isTest(path: string): boolean {
  return (
    CODE.test(path) &&
    (/\.(test|spec)\./.test(basename(path)) ||
      /(^|\/)__tests__\//.test(path) ||
      /^packages\/[^/]+\/test\//.test(path))
  );
}

/** Snapshot files count on any status: a new `.snap` can replace an assertion in an old test. */
function isSnapshot(path: string): boolean {
  return /\.snap$/.test(path) || /(^|\/)__snapshots__\//.test(path);
}

/** Golden and fixture files count when modified or deleted; a new test may add its own. */
function isGolden(path: string): boolean {
  return /golden/i.test(basename(path)) || /(^|\/)test\/fixtures\//.test(path);
}

/** The removed and added lines of each hunk in a `git diff -U0` of one file. */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      hunk = { removed: [], added: [] };
      hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) hunk.added.push(line.slice(1));
    else if (hunk && line.startsWith('-')) hunk.removed.push(line.slice(1));
  }
  return hunks;
}

/** `expect(`, `expect.soft(` and `expectTypeOf(` calls outside comments. */
export function countExpects(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
  return code.match(/\bexpect(?:\.soft)?\s*\(|\bexpectTypeOf\s*\(/g)?.length ?? 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The package.json without its dependency keys, or null when it is not a JSON object. */
function withoutDependencies(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const rest = { ...value };
  for (const key of DEPENDENCY_KEYS) Reflect.deleteProperty(rest, key);
  return JSON.stringify(rest);
}

/** True unless both texts are JSON objects that differ only in their dependency keys. */
export function packageJsonChanged(baseText: string, headText: string): boolean {
  const base = withoutDependencies(baseText);
  const head = withoutDependencies(headText);
  return base === null || head === null || base !== head;
}

function addedLines(file: FileChange): string[] {
  return CODE.test(file.path) ? file.hunks.flatMap((hunk) => hunk.added) : [];
}

function rulesFor(file: FileChange): RuleId[] {
  const { path, status, baseText, headText } = file;
  const texts = baseText !== undefined && headText !== undefined ? { baseText, headText } : null;
  const added = addedLines(file);
  const packageJson = PACKAGE_JSON.test(path);
  const rules: RuleId[] = [];
  if (status === 'D' && isTest(path)) rules.push('deleted-test');
  if (
    status === 'M' &&
    isTest(path) &&
    (texts === null || countExpects(texts.headText) < countExpects(texts.baseText))
  ) {
    rules.push('fewer-expects');
  }
  if (added.some((line) => SKIP.test(line))) rules.push('added-skip');
  if (
    isSnapshot(path) ||
    (status !== 'A' && isGolden(path)) ||
    (status === 'M' && isTest(path) && added.some((line) => SNAPSHOT_MATCHER.test(line)))
  ) {
    rules.push('snapshot');
  }
  if (
    WHOLE_FILE_CONFIG.some((pattern) => pattern.test(path)) ||
    (packageJson &&
      (status !== 'M' || texts === null || packageJsonChanged(texts.baseText, texts.headText)))
  ) {
    rules.push('config');
  }
  if (path.startsWith('packages/testkit/') && !packageJson) rules.push('testkit');
  if (added.some((line) => ESCAPES.some((pattern) => pattern.test(line)))) {
    rules.push('added-escape');
  }
  return rules;
}

/** Every finding, sorted by path and then by rule order. */
export function reportFindings(files: FileChange[]): Finding[] {
  return files
    .flatMap((file) =>
      rulesFor(file).map((rule) => ({ path: file.path, rule, detail: RULE_TEXT[rule] })),
    )
    .sort((a, b) =>
      a.path === b.path
        ? RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule)
        : a.path < b.path
          ? -1
          : 1,
    );
}

/** The text of every `## Changed checks` section, with HTML comments removed. */
function changedChecksText(body: string): string {
  const text = body.replace(/\r\n?/g, '\n');
  let visible = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) {
      visible += text.slice(from);
      break;
    }
    visible += text.slice(from, start);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) break;
    from = end + 3;
  }
  const kept: string[] = [];
  let inSection = false;
  for (const line of visible.split('\n')) {
    if (/^##[ \t]+changed checks[ \t]*$/i.test(line)) inSection = true;
    else if (/^#{1,2}[ \t]/.test(line)) inSection = false;
    else if (inSection) kept.push(line);
  }
  return kept.join('\n');
}

/** True when some occurrence of `path` in `text` is not part of a longer path. */
function names(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + path.length] ?? '';
    const next = text[at + path.length + 1] ?? '';
    const startOk = !/[A-Za-z0-9_./-]/.test(before);
    const endOk = !/[A-Za-z0-9_/-]/.test(after) && !(after === '.' && /[A-Za-z0-9_]/.test(next));
    if (startOk && endOk) return true;
  }
  return false;
}

/** The paths the body's `## Changed checks` section does not name. */
export function missingFromSection(body: string | null, paths: string[]): string[] {
  const section = changedChecksText(body ?? '');
  return paths.filter((path) => !names(section, path));
}

const VERSION_MASKS = [
  /sha256:[0-9a-f]{64}/g,
  /\b[0-9a-f]{40}\b/g,
  /sha512-[A-Za-z0-9+/]+=*/g,
  /v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g,
];

function maskVersions(line: string): string {
  return VERSION_MASKS.reduce((text, pattern) => text.replace(pattern, '\0'), line);
}

/**
 * True for a `renovate[bot]` pull request whose every file but pnpm-lock.yaml is modified and
 * changes only versions and digests: each hunk pairs removed and added lines that are equal in
 * order once versions, commit SHAs and sha256/sha512 digests are masked.
 */
export function isRenovateVersionOnly(
  user: { login: string; type: string },
  files: FileChange[],
): boolean {
  if (user.login !== 'renovate[bot]' || user.type !== 'Bot') return false;
  return files
    .filter((file) => file.path !== 'pnpm-lock.yaml')
    .every(
      (file) =>
        file.status === 'M' &&
        file.hunks.length > 0 &&
        file.hunks.every(
          (hunk) =>
            hunk.removed.length === hunk.added.length &&
            hunk.removed.every(
              (line, i) => maskVersions(line) === maskVersions(hunk.added[i] ?? ''),
            ),
        ),
    );
}

/** Escapes text for one line of a GitHub Actions log, so it cannot start a workflow command. */
export function escapeCommand(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Markdown inline code for any text, line breaks shown as `\n`. */
export function mdCode(text: string): string {
  const line = text.replace(/\r\n|\r|\n/g, '\\n');
  const longest = Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${line}${pad}${fence}`;
}

class UsageError extends Error {}

const USAGE =
  'usage: node scripts/guardrails.ts [base] - reports committed changes between HEAD and its ' +
  'merge base with <base> (default origin/main); uncommitted changes are not compared. ' +
  'A pull_request run takes no argument.';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    throw new Error(`git ${args[0] ?? ''} failed: ${reason}`);
  }
  return result.stdout;
}

const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface PullRequest {
  body: string | null;
  user: { login: string; type: string };
}

function readPullRequest(path: string | undefined): PullRequest {
  if (path === undefined || path === '') throw new Error('GITHUB_EVENT_PATH is not set');
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('the event payload is missing or not valid JSON');
  }
  const pr = isObject(event) ? event['pull_request'] : undefined;
  const user = isObject(pr) ? pr['user'] : undefined;
  const login = isObject(user) ? user['login'] : undefined;
  const type = isObject(user) ? user['type'] : undefined;
  const body = isObject(pr) ? pr['body'] : undefined;
  if (typeof login !== 'string' || typeof type !== 'string') {
    throw new Error('the event payload has no pull_request.user.login and user.type');
  }
  if (typeof body !== 'string' && body !== null) {
    throw new Error('the event payload has no pull_request.body');
  }
  return { body, user: { login, type } };
}

/** Merge base and head SHAs: the merge ref's first parent in PR mode, else merge-base with arg. */
function resolveRange(cwd: string, pr: boolean, arg: string): { base: string; head: string } {
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  let base: string;
  if (pr) {
    const shas = git(cwd, ['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
    if (shas.length !== 3) {
      throw new Error('HEAD is not a merge commit with two parents (needs fetch-depth: 2)');
    }
    base = shas[1] ?? '';
  } else {
    let target: string;
    try {
      target = git(cwd, ['rev-parse', '--verify', '--quiet', `${arg}^{commit}`]).trim();
    } catch {
      throw new Error(`base ${arg} is not a commit`);
    }
    base = git(cwd, ['merge-base', target, head]).trim();
  }
  if (!OID.test(base) || !OID.test(head)) throw new Error('could not resolve the base commit');
  return { base, head };
}

function collectChanges(cwd: string, base: string, head: string): FileChange[] {
  const changed = parseNameStatus(git(cwd, [...DIFF, '--name-status', '-z', base, head, '--']));
  const addedOutput = git(cwd, [...DIFF, '--diff-filter=A', '--name-only', '-z', base, head, '--']);
  const added = new Set(addedOutput.split('\0').filter((path) => path !== ''));
  return changed.map(({ path, deleted }): FileChange => {
    const status = deleted ? 'D' : added.has(path) ? 'A' : 'M';
    const file: FileChange = { path, status, hunks: [] };
    if (status === 'M' && (isTest(path) || PACKAGE_JSON.test(path))) {
      file.baseText = git(cwd, ['cat-file', 'blob', `${base}:${path}`]);
      file.headText = git(cwd, ['cat-file', 'blob', `${head}:${path}`]);
    }
    if (status !== 'D' && path !== 'pnpm-lock.yaml') {
      // --text: a .gitattributes `-diff` must not turn added lines into "Binary files differ".
      const diff = git(cwd, [...DIFF, '--text', '-U0', base, head, '--', path]);
      // Every real change prints at least headers; empty output means the path did not match.
      if (diff === '') throw new Error(`empty diff for changed file ${path}`);
      file.hunks = parseHunks(diff);
    }
    return file;
  });
}

function summary(base: string, files: FileChange[], findings: Finding[], paths: string[]): string {
  const lines = [
    '## Guardrails report',
    '',
    `Base \`${base}\`, ${String(files.length)} changed file(s).`,
    '',
  ];
  for (const finding of findings) lines.push(`- ${mdCode(finding.path)} - ${finding.detail}`);
  if (findings.length > 0) lines.push('');
  lines.push(
    paths.length === 0
      ? 'Report empty.'
      : `${String(paths.length)} file(s) need a \`## Changed checks\` entry.`,
  );
  return `${lines.join('\n')}\n\n`;
}

function run(argv: string[], env: NodeJS.ProcessEnv): number {
  const out = (text: string) => process.stdout.write(`guardrails: ${escapeCommand(text)}\n`);
  const pr = env['GITHUB_EVENT_NAME'] === 'pull_request';
  const arg = argv[0] ?? 'origin/main';
  if (pr ? argv.length > 0 : argv.length > 1 || arg === '' || arg.startsWith('-')) {
    throw new UsageError(USAGE);
  }
  const request = pr ? readPullRequest(env['GITHUB_EVENT_PATH']) : null;
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).replace(/\n$/, '');
  const { base, head } = resolveRange(cwd, pr, arg);
  const files = collectChanges(cwd, base, head);
  const findings = reportFindings(files);
  const paths = [...new Set(findings.map((finding) => finding.path))];

  out(`base ${base}, ${String(files.length)} changed file(s)`);
  for (const finding of findings) out(`${finding.path} - ${finding.detail}`);
  out(
    paths.length === 0
      ? 'report empty'
      : `${String(paths.length)} file(s) need a ## Changed checks entry`,
  );
  const summaryFile = env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) appendFileSync(summaryFile, summary(base, files, findings, paths));
  if (request === null) return 0;

  const missing = missingFromSection(request.body, paths);
  if (paths.length === 0) out('PASS (report empty)');
  else if (missing.length === 0) out('PASS (all reported files named)');
  else if (isRenovateVersionOnly(request.user, files)) {
    out('PASS (renovate[bot] version-only update)');
  } else {
    const message =
      `guardrails: add a "## Changed checks" section to the PR description naming: ` +
      `${missing.join(', ')}. Editing the description re-runs this job; ` +
      `"Re-run jobs" reuses the old description.`;
    process.stdout.write(`::error::${escapeCommand(message)}\n`);
    out('FAIL');
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2), process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`guardrails: ${escapeCommand(message)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
