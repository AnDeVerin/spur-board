import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RULE_IDS,
  countExpects,
  escapeCommand,
  isRenovateVersionOnly,
  mdCode,
  missingFromSection,
  packageJsonChanged,
  parseHunks,
  reportFindings,
  type FileChange,
} from './guardrails.ts';

type RuleId = (typeof RULE_IDS)[number];

const mod = (path: string, added: string[] = ['x'], removed: string[] = []): FileChange => ({
  path,
  status: 'M',
  hunks: [{ removed, added }],
});
const add = (path: string, added: string[] = ['x']): FileChange => ({
  path,
  status: 'A',
  hunks: [{ removed: [], added }],
});
const del = (path: string): FileChange => ({ path, status: 'D', hunks: [] });
const texts = (path: string, baseText: string, headText: string): FileChange => ({
  path,
  status: 'M',
  hunks: [{ removed: ['x'], added: ['y'] }],
  baseText,
  headText,
});
const json = (value: unknown, indent = 2) => `${JSON.stringify(value, null, indent)}\n`;

// The shapes of the real root, contracts and testkit package.json files.
const ROOT = {
  name: 'spur-board-workspace',
  private: true,
  type: 'module',
  packageManager: 'pnpm@12.16.1',
  engines: { node: '>=24.12' },
  scripts: { check: 'node scripts/check.ts', test: 'vitest run' },
  devDependencies: { eslint: 'catalog:', typescript: 'catalog:', vitest: 'catalog:' },
};
const CONTRACTS = {
  name: '@spur-board/contracts',
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': { import: './src/index.ts', default: './src/index.ts' } },
  scripts: { typecheck: 'tsc --noEmit -p .' },
  dependencies: { zod: '^4.6.7', yaml: '^2.9.1' },
  devDependencies: { '@spur-board/testkit': 'workspace:*' },
};
const TESTKIT = {
  name: '@spur-board/testkit',
  version: '0.0.0',
  private: true,
  type: 'module',
  scripts: { typecheck: 'tsc --noEmit -p .' },
};

const rootPkg = (head: unknown, base: unknown = ROOT) =>
  texts('package.json', json(base), json(head));
const contractsPkg = (head: unknown, indent = 2) =>
  texts('packages/contracts/package.json', json(CONTRACTS), json(head, indent));
const testkitPkg = (head: unknown) =>
  texts('packages/testkit/package.json', json(TESTKIT), json(head));

interface Case {
  rule: RuleId;
  name: string;
  flagged: FileChange;
  clean: FileChange;
}

const WHOLE_FILE_CONFIG: FileChange[] = [
  mod('.github/workflows/ci.yml'),
  mod('tsconfig.base.json'),
  mod('packages/x/tsconfig.json'),
  mod('eslint/rule.ts'),
  mod('vitest.config.ts'),
  mod('scripts/check.ts'),
  mod('renovate.json'),
  mod('.prettierrc.json'),
  mod('.prettierignore'),
  mod('knip.json'),
  add('.github/workflows/new.yml'),
];

const CASES: Case[] = [
  {
    rule: 'deleted-test',
    name: 'deleted test file',
    flagged: del('packages/a/test/x.test.ts'),
    clean: del('packages/a/src/x.ts'),
  },
  {
    rule: 'fewer-expects',
    name: 'fewer expect calls',
    flagged: texts('a.test.ts', 'expect(1);\nexpect(2);\nexpect(3);\n', 'expect(1);\nexpect(2);\n'),
    clean: texts('a.test.ts', 'expect(1);\nexpect(2);\n', 'expect(1);\nexpect(2);\nexpect(3);\n'),
  },
  {
    rule: 'added-skip',
    name: 'skip',
    flagged: mod('a.test.ts', ["it.skip('a', () => {})"]),
    clean: mod('a.test.ts', [], ["it.skip('a', () => {})"]),
  },
  {
    rule: 'added-skip',
    name: 'todo',
    flagged: mod('a.test.ts', ["test.todo('a')"]),
    clean: mod('a.test.ts', ['const todo = list.todo;']),
  },
  {
    rule: 'added-skip',
    name: 'only',
    flagged: mod('a.test.ts', ["describe.only('a', () => {})"]),
    clean: mod('a.ts', ['if (values.only) run();']),
  },
  {
    rule: 'snapshot',
    name: 'snapshot',
    flagged: mod('src/__snapshots__/a.test.ts.snap'),
    clean: add('src/a.test.ts', ['expect(x).toMatchSnapshot();']),
  },
  {
    rule: 'snapshot',
    name: 'added .snap',
    flagged: add('src/__snapshots__/a.test.ts.snap'),
    clean: add('src/a.test.ts', ['expect(x).toMatchInlineSnapshot();']),
  },
  {
    rule: 'snapshot',
    name: 'added .snap outside __snapshots__',
    flagged: add('src/a.test.ts.snap'),
    clean: add('src/golden-new.json'),
  },
  ...[
    'toMatchSnapshot',
    'toMatchInlineSnapshot',
    'toMatchFileSnapshot',
    'toThrowErrorMatchingSnapshot',
    'toThrowErrorMatchingInlineSnapshot',
  ].map((matcher): Case => ({
    rule: 'snapshot',
    name: `added ${matcher} in an M test file`,
    flagged: mod('src/a.test.ts', [`expect(x).${matcher}();`]),
    clean: mod('src/a.test.ts', [], [`expect(x).${matcher}();`]),
  })),
  {
    rule: 'snapshot',
    name: 'fixture',
    flagged: mod('packages/contracts/test/fixtures/jira-project.yaml'),
    clean: add('packages/contracts/test/fixtures/new.yaml'),
  },
  ...WHOLE_FILE_CONFIG.map((flagged, i): Case => ({
    rule: 'config',
    name: `whole file ${flagged.status} ${flagged.path}`,
    flagged,
    clean: i % 2 === 0 ? mod('packages/contracts/src/config.ts') : mod('README.md'),
  })),
  {
    rule: 'config',
    name: 'added pnpmfile',
    flagged: add('.pnpmfile.cjs'),
    clean: mod('packages/x/.pnpmfile.cjs'),
  },
  {
    rule: 'config',
    name: 'modified pnpmfile',
    flagged: mod('.pnpmfile.mjs'),
    clean: mod('packages/x/.pnpmfile.cjs'),
  },
  { rule: 'config', name: 'npmrc', flagged: mod('.npmrc'), clean: mod('packages/x/.npmrc') },
  {
    rule: 'config',
    name: 'nested eslint config',
    flagged: add('packages/x/eslint.config.js'),
    clean: mod('packages/x/src/a.ts'),
  },
  {
    rule: 'config',
    name: 'nested prettier config',
    flagged: add('packages/x/.prettierrc.json'),
    clean: mod('packages/x/prettierrc.md'),
  },
  {
    rule: 'config',
    name: 'workspace catalog-only bump',
    flagged: mod('pnpm-workspace.yaml', ['  vitest: ^5.1.0'], ['  vitest: ^5.0.5']),
    clean: mod('packages/x/pnpm-workspace.yaml', ['  vitest: ^5.1.0'], ['  vitest: ^5.0.5']),
  },
  {
    rule: 'testkit',
    name: 'modified testkit',
    flagged: mod('packages/testkit/src/env.ts'),
    clean: mod('packages/contracts/src/index.ts'),
  },
  {
    rule: 'testkit',
    name: 'added testkit file',
    flagged: add('packages/testkit/src/new.ts'),
    clean: testkitPkg({ ...TESTKIT, devDependencies: { vitest: 'catalog:' } }),
  },
  {
    rule: 'added-escape',
    name: 'eslint-disable',
    flagged: mod('a.ts', ['// eslint-disable-next-line no-x -- why']),
    clean: mod('README.md', ['// eslint-disable-next-line no-x -- why']),
  },
  {
    rule: 'added-escape',
    name: 'ts-expect-error',
    flagged: mod('a.ts', ['// @ts-expect-error why']),
    clean: mod('a.ts', ['const s = 1']),
  },
  {
    rule: 'added-escape',
    name: 'ts-ignore',
    flagged: mod('a.ts', ['// @ts-ignore']),
    clean: mod('a.md', ['// @ts-ignore']),
  },
  {
    rule: 'added-escape',
    name: 'as any',
    flagged: mod('a.ts', ['const y = x as any;']),
    clean: mod('a.ts', ['const y = x as unknown;', 'const z = x as anyValue;']),
  },
  // package.json: only changes outside the dependency keys count.
  {
    rule: 'config',
    name: 'root scripts',
    flagged: rootPkg({
      ...ROOT,
      scripts: { ...ROOT.scripts, test: 'vitest run --passWithNoTests' },
    }),
    clean: rootPkg({ ...ROOT, devDependencies: { ...ROOT.devDependencies, vitest: '^5.1.0' } }),
  },
  {
    rule: 'config',
    name: 'nested package',
    flagged: contractsPkg({ ...CONTRACTS, scripts: { typecheck: 'tsc -p .' } }),
    clean: contractsPkg({ ...CONTRACTS, dependencies: { zod: '^4.7.0', yaml: '^2.9.1' } }, 4),
  },
  {
    rule: 'config',
    name: 'testkit package',
    flagged: testkitPkg({ ...TESTKIT, scripts: { typecheck: 'tsc -p .' } }),
    clean: testkitPkg({ ...TESTKIT, devDependencies: { vitest: 'catalog:' } }),
  },
  {
    rule: 'config',
    name: 'pnpm.overrides',
    flagged: rootPkg({ ...ROOT, pnpm: { overrides: { minimatch: '11.0.1' } } }),
    clean: rootPkg({ ...ROOT, peerDependencies: { eslint: '^10.0.0' } }),
  },
  {
    rule: 'config',
    name: 'overrides',
    flagged: rootPkg({ ...ROOT, overrides: { minimatch: '11.0.1' } }),
    clean: rootPkg({ ...ROOT, optionalDependencies: { fsevents: '^2.3.3' } }),
  },
  {
    rule: 'config',
    name: 'packageManager',
    flagged: rootPkg({ ...ROOT, packageManager: 'pnpm@12.17.0' }),
    clean: rootPkg({
      ...ROOT,
      devDependencies: { vitest: 'catalog:', typescript: 'catalog:', eslint: 'catalog:' },
    }),
  },
  {
    rule: 'config',
    name: 'engines',
    flagged: rootPkg({ ...ROOT, engines: { node: '>=22' } }),
    clean: texts('package.json', json(ROOT), JSON.stringify(ROOT)),
  },
  {
    rule: 'config',
    name: 'exports order',
    flagged: contractsPkg({
      ...CONTRACTS,
      exports: { '.': { default: './src/index.ts', import: './src/index.ts' } },
    }),
    clean: contractsPkg({ ...CONTRACTS, dependencies: { yaml: '^2.9.1', zod: '^4.6.7' } }),
  },
  {
    rule: 'config',
    name: 'unparseable JSON',
    flagged: texts('package.json', json(ROOT), '{ "name": '),
    clean: texts('package.json', json(ROOT), JSON.stringify(ROOT, null, '\t')),
  },
  {
    rule: 'config',
    name: 'added package.json',
    flagged: add('packages/new/package.json', [
      json({ name: 'new', dependencies: { zod: 'catalog:' } }),
    ]),
    clean: add('packages/new/src/index.ts'),
  },
  {
    rule: 'config',
    name: 'deleted package.json',
    flagged: del('packages/old/package.json'),
    clean: del('packages/old/README.md'),
  },
];

const has = (file: FileChange, rule: RuleId) =>
  reportFindings([file]).some((finding) => finding.path === file.path && finding.rule === rule);

describe('reportFindings', () => {
  it.each(CASES)('$rule: $name', ({ rule, flagged, clean }) => {
    expect(has(flagged, rule)).toBe(true);
    expect(has(clean, rule)).toBe(false);
  });

  it('every rule id has a flagged and a clean case', () => {
    expect(new Set(CASES.map((row) => row.rule))).toEqual(new Set(RULE_IDS));
  });

  it('flags an M test file without its texts', () => {
    expect(has(mod('a.test.ts'), 'fewer-expects')).toBe(true);
  });

  it('flags an M package.json without its texts', () => {
    expect(has(mod('package.json'), 'config')).toBe(true);
  });

  it('sorts by path, then by rule order', () => {
    const findings = reportFindings([
      mod('b.ts', ['const y = x as any;']),
      mod('a.test.ts', ['// @ts-ignore', "it.skip('a', () => {})"]),
    ]);
    expect(findings.map((finding) => `${finding.path} ${finding.rule}`)).toEqual([
      'a.test.ts fewer-expects',
      'a.test.ts added-skip',
      'a.test.ts added-escape',
      'b.ts added-escape',
    ]);
  });
});

describe('countExpects', () => {
  it.each([
    'expect(a)',
    'expect (a)',
    'expect.soft(a)',
    'expectTypeOf(a)',
    "'http://x'; expect(a)",
  ])('counts %s once', (source) => {
    expect(countExpects(source)).toBe(1);
  });

  it.each([
    'expect.any(String)',
    'expect.assertions(1)',
    '// expect(a)',
    '/* expect(a) */',
    "'expect(x)'",
    '"expect(x)"',
    '`expect(x)`',
    '/expect()/',
    'x = /expect(/g',
    "'it\\'s expect(x)'",
    '`a ${b} expect(x)`',
    'const s = "a\nexpect(x)',
    '/* expect(x)',
    '`${a} expect(x)',
  ])('does not count %s', (source) => {
    expect(countExpects(source)).toBe(0);
  });

  it.each([
    ['real code inside a template expression', '`${expect(a)}`'],
    ['a template expression with nested braces', '`${ {a: 1}.a } ${expect(a)}`'],
    ['a URL string before an expect', "'http://x'; expect(a)"],
    ['a division', 'a / expect(b)'],
    ['a division after a call', 'f(a) / expect(b)'],
    ['a regex with a slash in a class', 'const r = /[/]/; expect(a)'],
    ['a regex with an escaped slash', 'return /\\//.test(s) && expect(a)'],
    ['code after a nested template', '`a ${`b ${c}`} d`; expect(a)'],
  ])('counts %s once', (_name, source) => {
    expect(countExpects(source)).toBe(1);
  });

  it('flags a real expect replaced by a string', () => {
    const file = texts(
      'a.test.ts',
      "it('a', () => {\n  expect(x).toBe(1);\n});\n",
      "it('a', () => {\n  const note = 'expect(x)';\n});\n",
    );
    expect(has(file, 'fewer-expects')).toBe(true);
  });
});

describe('parseHunks', () => {
  it('reads removed and added lines per hunk', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+++x',
      '\\ No newline at end of file',
      '@@ -5,0 +6 @@',
      '+new',
      '',
    ].join('\n');
    expect(parseHunks(diff)).toEqual([
      { removed: ['old'], added: ['++x'] },
      { removed: [], added: ['new'] },
    ]);
  });

  it('gives no hunks for a binary file', () => {
    expect(
      parseHunks('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n'),
    ).toEqual([]);
  });
});

describe('packageJsonChanged', () => {
  const base = json(ROOT);
  it.each([
    ['a root array', '[]'],
    ['a null root', 'null'],
    ['a truncated head', '{ "name": '],
    ['pnpm.overrides added', json({ ...ROOT, pnpm: { overrides: { minimatch: '11.0.1' } } })],
  ])('is true for %s', (_name, head) => {
    expect(packageJsonChanged(base, head)).toBe(true);
  });

  it('is true for an unparseable base', () => {
    expect(packageJsonChanged('{', base)).toBe(true);
  });

  it.each([
    ['identical texts', base],
    ['a reindent', json(ROOT, 4)],
    [
      'dependency changes only',
      json({ ...ROOT, devDependencies: { vitest: '^5.1.0' }, peerDependencies: { a: '1' } }),
    ],
  ])('is false for %s', (_name, head) => {
    expect(packageJsonChanged(base, head)).toBe(false);
  });
});

describe('missingFromSection', () => {
  const paths = ['scripts/ci.ts', '.github/workflows/ci.yml'];
  const section = (text: string) => `## Description\n\n- x\n\n## Changed checks\n\n${text}\n`;

  it('names every listed path', () => {
    expect(
      missingFromSection(section('- `scripts/ci.ts` - a\n- .github/workflows/ci.yml - b'), paths),
    ).toEqual([]);
  });

  it.each([null, ''])('misses every path for body %j', (body) => {
    expect(missingFromSection(body, paths)).toEqual(paths);
  });

  it('matches a CRLF body', () => {
    const body = '## Changed checks\r\n\r\n- scripts/ci.ts - a\r\n\r\nCloses #1';
    expect(missingFromSection(body, ['scripts/ci.ts'])).toEqual([]);
  });

  it.each([
    ['inside a comment', section('<!-- scripts/ci.ts -->')],
    ['after an unterminated comment', section('<!-- x\nscripts/ci.ts')],
    ['by basename only', section('- ci.ts - a')],
    ['by a longer path', section('- scripts/ci.test.ts - a')],
    ['only under another heading', '## Description\n\nscripts/ci.ts\n\n## Changed checks\n\n- x'],
    ['with a .bak suffix', section('scripts/ci.ts.bak')],
    ['as part of .tsx', section('scripts/ci.tsx')],
    ['as a directory', section('scripts/ci.ts/x')],
    ['with a -old suffix', section('scripts/ci.ts-old')],
    ['with a prefix', section('xscripts/ci.ts')],
  ])('misses a path named %s', (_name, body) => {
    expect(missingFromSection(body, ['scripts/ci.ts'])).toEqual(['scripts/ci.ts']);
  });

  it.each([
    ['in a lowercase heading', '## changed checks\n\nscripts/ci.ts'],
    ['before a period', section('Changed scripts/ci.ts.')],
    ['before a comma', section('scripts/ci.ts, then more')],
    ['in parentheses', section('(scripts/ci.ts)')],
    ['in backticks', section('`scripts/ci.ts`')],
    ['under a ### sub heading', section('### Scripts\n\nscripts/ci.ts')],
    ['after a longer match', section('scripts/ci.tsx and scripts/ci.ts')],
    ['after a .bak match', section('scripts/ci.ts.bak, then scripts/ci.ts.')],
  ])('names a path %s', (_name, body) => {
    expect(missingFromSection(body, ['scripts/ci.ts'])).toEqual([]);
  });

  it('names a path with a space', () => {
    expect(missingFromSection(section('- `docs/a b.md` - x'), ['docs/a b.md'])).toEqual([]);
  });

  it('the PR template names nothing', () => {
    const template = readFileSync(
      new URL('../.github/pull_request_template.md', import.meta.url),
      'utf8',
    ).replace('Closes #<N>', 'Closes #5');
    expect(missingFromSection(template, paths)).toEqual(paths);
  });
});

describe('isRenovateVersionOnly', () => {
  const bot = { login: 'renovate[bot]', type: 'Bot' };
  const sha1 = '3d3c42e5aac5ba805825da76410c181273ba90b1';
  const sha2 = 'a'.repeat(40);
  const checkout = (sha: string, version: string) =>
    `      - uses: actions/checkout@${sha} # ${version}`;
  const digest = mod(
    '.github/workflows/ci.yml',
    [checkout(sha2, 'v7.0.2')],
    [checkout(sha1, 'v7.0.1')],
  );
  const lock = mod('pnpm-lock.yaml', ['  a: 2'], ['  a: 1']);
  const catalog = (from: string, to: string) =>
    mod('pnpm-workspace.yaml', [`  typescript-eslint: ${to}`], [`  typescript-eslint: ${from}`]);
  const gitleaks = (version: string, hex: string) =>
    `      - uses: docker://ghcr.io/gitleaks/gitleaks:${version}@sha256:${hex.repeat(64)}`;

  it.each([
    ['an actions digest bump', [digest, lock]],
    [
      'a docker digest bump',
      [mod('.github/workflows/ci.yml', [gitleaks('v8.30.2', 'b')], [gitleaks('v8.30.1', 'c')])],
    ],
    ['a catalog bump', [catalog('^8.72.0', '^9.0.0'), lock]],
    [
      'a packageManager bump',
      [
        mod(
          'package.json',
          [`  "packageManager": "pnpm@12.17.0+sha512.${'ab'.repeat(64)}",`],
          ['  "packageManager": "pnpm@12.16.1",'],
        ),
      ],
    ],
  ])('exempts %s', (_name, files) => {
    expect(isRenovateVersionOnly(bot, files)).toBe(true);
  });

  const withHunk = (file: FileChange, removed: string[], added: string[]): FileChange => ({
    ...file,
    hunks: [...file.hunks, { removed, added }],
  });

  it.each([
    ['an added continue-on-error', [withHunk(digest, [], ['    continue-on-error: true']), lock]],
    [
      'a changed timeout',
      [mod('.github/workflows/ci.yml', ['    timeout-minutes: 10'], ['    timeout-minutes: 5'])],
    ],
    ['two lines swapped', [mod('a.yml', ['b: 1.0.0', 'a: 1.0.0'], ['a: 1.0.0', 'b: 1.0.0'])]],
    ['an added file', [add('.github/workflows/new.yml'), lock]],
    ['a file without hunks', [{ path: 'a.png', status: 'M', hunks: [] } satisfies FileChange]],
    ['a caret turned tilde', [catalog('^8.72.0', '~8.72.0')]],
    [
      'a bare major bump',
      [mod('pnpm-workspace.yaml', ["  '@types/node': ^26"], ["  '@types/node': ^24"])],
    ],
    [
      'a catalog bump with a release-age change',
      [
        withHunk(
          catalog('^8.72.0', '^9.0.0'),
          ['minimumReleaseAge: 10080'],
          ['minimumReleaseAge: 0'],
        ),
      ],
    ],
  ])('does not exempt %s', (_name, files) => {
    expect(isRenovateVersionOnly(bot, files)).toBe(false);
  });

  it('does not exempt renovate[bot] as a User', () => {
    expect(isRenovateVersionOnly({ login: 'renovate[bot]', type: 'User' }, [digest])).toBe(false);
  });

  it('does not exempt a human author', () => {
    expect(isRenovateVersionOnly({ login: 'someone', type: 'User' }, [digest, lock])).toBe(false);
  });
});

describe('escaping', () => {
  it('escapeCommand escapes percent, CR and LF', () => {
    expect(escapeCommand('a%b\r\nc')).toBe('a%25b%0D%0Ac');
  });

  it('mdCode fences a backtick with a longer run', () => {
    expect(mdCode('a`b')).toBe('``a`b``');
  });

  it('mdCode pads a leading backtick', () => {
    expect(mdCode('`a')).toBe('`` `a ``');
  });

  it('mdCode shows a newline as \\n', () => {
    expect(mdCode('x\ny')).toBe('`x\\ny`');
  });
});

const HOSTILE = 'x\n::warning::y.test.ts';

// The shape of the real pnpm-workspace.yaml.
const WORKSPACE = [
  'packages:',
  '  - packages/*',
  '',
  'minimumReleaseAge: 10080',
  'strictDepBuilds: true',
  'allowBuilds: {}',
  '',
  'catalog:',
  "  '@types/node': ^24",
  '  vitest: ^5.0.5',
  '  zod: ^4.6.7',
  '',
].join('\n');

const workflow = (sha: string, version: string, extra = '') =>
  [
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    `      - uses: actions/checkout@${sha} # ${version}`,
    `      - run: pnpm test${extra}`,
    '',
  ].join('\n');

describe('guardrails.ts CLI', () => {
  const script = fileURLToPath(new URL('guardrails.ts', import.meta.url));

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'guardrails-cli-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    for (const name of ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_STEP_SUMMARY']) {
      Reflect.deleteProperty(env, name);
    }
    const repo = join(dir, 'repo');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    const commit = (files: Record<string, string | null>) => {
      for (const [path, text] of Object.entries(files)) {
        const file = join(repo, path);
        if (text === null) rmSync(file);
        else {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text);
        }
      }
      git('add', '-A');
      git('commit', '-qm', 'change');
    };
    const run = (extra: NodeJS.ProcessEnv, args: string[], cwd = repo) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd,
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const event = join(dir, 'event.json');
    return {
      dir,
      repo,
      git,
      commit,
      base: (files: Record<string, string | null>) => {
        commit(files);
      },
      topic: (files: Record<string, string | null>) => {
        git('checkout', '-q', '-b', 'topic');
        commit(files);
      },
      merge: () => {
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', 'topic', '-m', 'merge');
      },
      runLocal: (...args: string[]) => run({}, args),
      runPr: (payload: unknown, args: string[] = [], extra: NodeJS.ProcessEnv = {}, cwd = repo) => {
        writeFileSync(event, typeof payload === 'string' ? payload : JSON.stringify(payload));
        return run(
          { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, ...extra },
          args,
          cwd,
        );
      },
    };
  }

  const pr = (body: string | null, login = 'someone', type = 'User') => ({
    pull_request: { body, user: { login, type } },
  });
  const lines = (text: string) => text.split('\n').filter((line) => line !== '');
  const reportLines = (text: string) =>
    lines(text).filter(
      (line) => line.startsWith('guardrails: ') && !/^guardrails: (PASS|FAIL)/.test(line),
    );
  const expectNoPass = (result: { stdout: string }) => {
    expect(result.stdout).not.toContain('guardrails: PASS');
    expect(result.stdout).not.toContain('report empty');
  };

  it('reports every rule on a local run', () => {
    const box = sandbox();
    box.base({
      'a.test.ts': 'expect(1);\n',
      'b.test.ts': 'expect(1);\nexpect(2);\n',
      'c.test.ts': "it('c', () => {});\n",
      's/__snapshots__/x.snap': 'one\n',
      'tsconfig.json': '{}\n',
      'packages/testkit/src/k.ts': 'export const k = 1;\n',
      'src/d.ts': 'export const d = 1;\n',
    });
    box.topic({
      'a.test.ts': null,
      'b.test.ts': 'expect(1);\n',
      'c.test.ts': "it('c', () => {});\nit.skip('d', () => {});\n",
      's/__snapshots__/x.snap': 'two\n',
      'tsconfig.json': '{ "compilerOptions": {} }\n',
      'packages/testkit/src/k.ts': 'export const k = 2;\n',
      'src/d.ts': 'export const d = 1 as any;\n',
    });
    const result = box.runLocal('main');
    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual([
      `guardrails: base ${box.git('rev-parse', 'main')}, 7 changed file(s)`,
      'guardrails: a.test.ts - deleted or renamed test file',
      'guardrails: b.test.ts - fewer expect assertions',
      'guardrails: c.test.ts - added .skip, .todo or .only',
      'guardrails: packages/testkit/src/k.ts - changed shared test kit',
      'guardrails: s/__snapshots__/x.snap - changed snapshot or golden file',
      'guardrails: src/d.ts - added eslint-disable, @ts-expect-error, @ts-ignore or as any',
      'guardrails: tsconfig.json - changed test, lint, TypeScript or CI config',
      'guardrails: 7 file(s) need a ## Changed checks entry',
    ]);
  });

  it('PR deleting a test fails, then passes once the section names it', () => {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n', 'b.test.ts': 'expect(2);\n' });
    box.topic({ 'a.test.ts': null });
    box.merge();
    const failed = box.runPr(pr(''));
    expect(failed.status).toBe(1);
    const errors = lines(failed.stdout).filter((line) => line.startsWith('::error::'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('a.test.ts');
    expect(errors[0]).toContain('## Changed checks');
    expect(lines(failed.stdout).at(-1)).toBe('guardrails: FAIL');

    const body =
      '## Changed checks\r\n\r\n- `a.test.ts` - removed, covered by b.test.ts\r\n\r\nCloses #1';
    const passed = box.runPr(pr(body));
    expect(passed.status).toBe(0);
    expect(lines(passed.stdout).at(-1)).toBe('guardrails: PASS (all reported files named)');
  });

  it('PR adding only new tests and code passes without the section', () => {
    const box = sandbox();
    box.base({ 'README.md': 'x\n' });
    box.topic({ 'src/x.ts': 'export const x = 1;\n', 'src/x.test.ts': 'expect(1).toBe(1);\n' });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guardrails: report empty');
    expect(result.stdout).toContain('guardrails: PASS (report empty)');
    expect(result.stdout).not.toContain('::error::');
  });

  it('PR swapping toEqual for toMatchSnapshot with a new .snap fails', () => {
    const box = sandbox();
    box.base({ 'src/a.test.ts': "it('a', () => {\n  expect(x).toEqual(1);\n});\n" });
    box.topic({
      'src/a.test.ts': "it('a', () => {\n  expect(x).toMatchSnapshot();\n});\n",
      'src/__snapshots__/a.test.ts.snap': 'exports[`a 1`] = `1`;\n',
    });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(1);
    expect(reportLines(result.stdout).slice(1)).toEqual([
      'guardrails: src/__snapshots__/a.test.ts.snap - changed snapshot or golden file',
      'guardrails: src/a.test.ts - changed snapshot or golden file',
      'guardrails: 2 file(s) need a ## Changed checks entry',
    ]);
    expectNoPass(result);
  });

  it('PR swapping toEqual for toMatchInlineSnapshot fails', () => {
    const box = sandbox();
    box.base({ 'src/a.test.ts': "it('a', () => {\n  expect(x).toEqual(1);\n});\n" });
    box.topic({
      'src/a.test.ts': "it('a', () => {\n  expect(x).toMatchInlineSnapshot(`1`);\n});\n",
    });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(1);
    expect(reportLines(result.stdout).slice(1)).toEqual([
      'guardrails: src/a.test.ts - changed snapshot or golden file',
      'guardrails: 1 file(s) need a ## Changed checks entry',
    ]);
    expectNoPass(result);
  });

  it('PR adding a new test with new fixtures passes without the section', () => {
    const box = sandbox();
    box.base({ 'README.md': 'x\n' });
    box.topic({
      'packages/x/test/a.test.ts': 'expect(1).toBe(1);\n',
      'packages/x/test/fixtures/a.yaml': 'a: 1\n',
      'packages/x/test/golden.json': '{}\n',
    });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guardrails: PASS (report empty)');
  });

  it('PR mode appends the report to GITHUB_STEP_SUMMARY', () => {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n', 'eslint.config.js': 'export default [];\n' });
    box.topic({ 'a.test.ts': null, 'eslint.config.js': 'export default [{}];\n' });
    box.merge();
    const summaryFile = join(box.dir, 'summary.md');
    writeFileSync(summaryFile, '');
    const result = box.runPr(pr(''), [], { GITHUB_STEP_SUMMARY: summaryFile });
    expect(result.status).toBe(1);
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('## Guardrails report');
    expect(summary).toContain('- `a.test.ts` - deleted or renamed test file');
    expect(summary).toContain('- `eslint.config.js` - changed test, lint, TypeScript or CI config');
  });

  it('local and PR-mode reports are identical', () => {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n', 'knip.json': '{}\n', 'src/d.ts': 'export {};\n' });
    box.topic({
      'a.test.ts': null,
      'knip.json': '{ "ignore": [] }\n',
      'src/d.ts': 'export const d = 1 as any;\n',
    });
    const local = box.runLocal('main');
    box.merge();
    const body = '## Changed checks\n\n- a.test.ts - x\n- knip.json - x\n- src/d.ts - x\n';
    const gate = box.runPr(pr(body));
    expect(local.status).toBe(0);
    expect(gate.status).toBe(0);
    expect(reportLines(local.stdout)).toHaveLength(5);
    expect(reportLines(gate.stdout)).toEqual(reportLines(local.stdout));

    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const job = /^ {2}guardrails:\n(?: {4}.*\n|\n)*/m.exec(ci)?.[0] ?? '';
    expect(job).toContain("    if: github.event_name == 'pull_request'\n");
    expect(job).toContain('      - run: pnpm guardrails\n');
  });

  const renovateBase = {
    '.github/workflows/ci.yml': workflow('3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'),
    'pnpm-workspace.yaml': WORKSPACE,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  };
  const actionsBump = (extra = '') => ({
    '.github/workflows/ci.yml': workflow('a'.repeat(40), 'v7.0.2', extra),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# bumped\n',
  });
  const catalogBump = (from = 'minimumReleaseAge: 10080', to = from) => ({
    'pnpm-workspace.yaml': WORKSPACE.replace('vitest: ^5.0.5', 'vitest: ^5.1.0').replace(from, to),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# bumped\n',
  });

  it.each([
    ['an actions digest bump', actionsBump(), '.github/workflows/ci.yml'],
    ['a catalog bump', catalogBump(), 'pnpm-workspace.yaml'],
  ])('renovate version-only PR passes without the section: %s', (_name, change, path) => {
    const box = sandbox();
    box.base(renovateBase);
    box.topic(change);
    box.merge();
    const result = box.runPr(pr('', 'renovate[bot]', 'Bot'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`guardrails: ${path} - `);
    expect(lines(result.stdout).at(-1)).toBe(
      'guardrails: PASS (renovate[bot] version-only update)',
    );
  });

  it.each([
    ['an actions bump with continue-on-error', actionsBump('\n    continue-on-error: true')],
    ['a catalog bump with a release-age change', catalogBump('10080', '0')],
  ])('renovate PR with other changes fails: %s', (_name, change) => {
    const box = sandbox();
    box.base(renovateBase);
    box.topic(change);
    box.merge();
    const result = box.runPr(pr('', 'renovate[bot]', 'Bot'));
    expect(result.status).toBe(1);
    expect(lines(result.stdout).at(-1)).toBe('guardrails: FAIL');
  });

  const contracts = (zod: string) => json({ name: '@spur-board/contracts', dependencies: { zod } });
  const depsBase = {
    'packages/contracts/package.json': contracts('^4.6.7'),
    'pnpm-workspace.yaml': WORKSPACE,
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  };

  it('dependency bumps: package.json passes', () => {
    const box = sandbox();
    box.base(depsBase);
    box.topic({
      'packages/contracts/package.json': contracts('^4.7.0'),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# bumped\n',
    });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guardrails: report empty');
  });

  it('dependency bumps: the catalog is reported', () => {
    const box = sandbox();
    box.base(depsBase);
    box.topic({
      'pnpm-workspace.yaml': WORKSPACE.replace('zod: ^4.6.7', 'zod: ^4.7.0'),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# bumped\n',
    });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(1);
    const errors = lines(result.stdout).filter((line) => line.startsWith('::error::'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pnpm-workspace.yaml');
  });

  it('empty diff gives an empty report', () => {
    const box = sandbox();
    box.base({ 'a.ts': 'export {};\n' });
    const local = box.runLocal('main');
    expect(local.status).toBe(0);
    expect(lines(local.stdout)).toEqual([
      `guardrails: base ${box.git('rev-parse', 'main')}, 0 changed file(s)`,
      'guardrails: report empty',
    ]);

    box.topic({ 'a.ts': 'export const a = 1 as any;\n' });
    box.commit({ 'a.ts': 'export {};\n' });
    box.merge();
    const gate = box.runPr(pr(null));
    expect(gate.status).toBe(0);
    expect(lines(gate.stdout).at(-1)).toBe('guardrails: PASS (report empty)');
  });

  function merged() {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n' });
    box.topic({ 'a.test.ts': null });
    box.merge();
    return box;
  }

  it('local: unknown base exits 1', () => {
    const box = merged();
    const result = box.runLocal('nosuchref');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('guardrails: base nosuchref is not a commit\n');
    expectNoPass(result);
  });

  it('local: no origin/main and no arg exits 1', () => {
    const result = merged().runLocal();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('origin/main');
    expectNoPass(result);
  });

  it.each([
    ['an empty argument', ['']],
    ['an argument starting with -', ['--help']],
    ['two arguments', ['main', 'main']],
  ])('local: %s exits 2', (_name, args) => {
    const result = merged().runLocal(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
    expectNoPass(result);
  });

  it('PR mode: an argument exits 2', () => {
    const result = merged().runPr(pr(''), ['main']);
    expect(result.status).toBe(2);
    expectNoPass(result);
  });

  it('PR mode: single-parent HEAD exits 1', () => {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n' });
    box.commit({ 'a.test.ts': null });
    const result = box.runPr(pr(''));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a merge commit');
    expectNoPass(result);
  });

  it('PR mode: depth-1 clone exits 1', () => {
    const box = merged();
    const clone = join(box.dir, 'shallow');
    spawnSync('git', ['clone', '-q', '--depth', '1', `file://${box.repo}`, clone]);
    const result = box.runPr(pr(''), [], {}, clone);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a merge commit');
    expectNoPass(result);
  });

  it.each([
    ['unset', () => ''],
    ['a missing file', (dir: string) => join(dir, 'none.json')],
  ])('PR mode: GITHUB_EVENT_PATH %s exits 1', (_name, path) => {
    const box = merged();
    const result = box.runPr(pr(''), [], { GITHUB_EVENT_PATH: path(box.dir) });
    expect(result.status).toBe(1);
    expectNoPass(result);
  });

  it('PR mode: invalid payload JSON exits 1', () => {
    const result = merged().runPr('{not json');
    expect(result.status).toBe(1);
    expectNoPass(result);
  });

  it('PR mode: user.login missing exits 1', () => {
    const result = merged().runPr({ pull_request: { body: '', user: { type: 'User' } } });
    expect(result.status).toBe(1);
    expectNoPass(result);
  });

  it('PR mode: a missing body exits 1', () => {
    const result = merged().runPr({ pull_request: { user: { login: 'a', type: 'User' } } });
    expect(result.status).toBe(1);
    expectNoPass(result);
  });

  it('a hostile file name cannot inject a workflow command', () => {
    const box = sandbox();
    box.base({ [HOSTILE]: 'expect(1);\n', 'b.ts': 'export {};\n' });
    box.topic({ [HOSTILE]: null });
    box.merge();
    const result = box.runPr(pr(''));
    expect(result.status).toBe(1);
    const all = [...lines(result.stdout), ...lines(result.stderr)];
    expect(all.filter((line) => /^::(?!error::)/.test(line))).toEqual([]);
    const errors = lines(result.stdout).filter((line) => line.startsWith('::error::'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('%0A::warning::y.test.ts');
  });

  it('a git error naming a hostile path is escaped on stderr', () => {
    const box = sandbox();
    box.base({ [HOSTILE]: 'expect(1);\n' });
    const oid = box.git('rev-parse', `main:${HOSTILE}`);
    box.topic({ [HOSTILE]: 'expect(1);\nexpect(2);\n' });
    rmSync(join(box.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    const result = box.runLocal('main');
    expect(result.status).toBe(1);
    expect(lines(result.stderr).filter((line) => line.startsWith('::'))).toEqual([]);
    const errors = lines(result.stderr).filter((line) => line.startsWith('guardrails: '));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('%0A::warning::y.test.ts');
    expect(result.stdout).not.toContain('report empty');
  });

  it.each([
    ['diff.external', ['diff.external', 'true'], {}],
    [
      'a textconv driver',
      ['diff.up.textconv', 'tr a-z A-Z <'],
      { '.gitattributes': '*.ts diff=up\n' },
    ],
    ['a -diff attribute', [], { '.gitattributes': '*.ts -diff\n' }],
  ])('local diff config cannot hide added lines: %s', (_name, config, attributes) => {
    const box = sandbox();
    box.base({ 'src/d.ts': 'export const x = 1;\n', ...attributes });
    if (config.length > 0) box.git('config', ...config);
    box.topic({ 'src/d.ts': 'export const x = 1;\nconst y = x as any;\n' });
    const result = box.runLocal('main');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'guardrails: src/d.ts - added eslint-disable, @ts-expect-error, @ts-ignore or as any',
    );
  });

  it('a non-UTF-8 file name fails closed', () => {
    const box = sandbox();
    box.base({ 'a.ts': 'export {};\n' });
    box.git('checkout', '-q', '-b', 'topic');
    const name = Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x73]); // b\xff.ts
    writeFileSync(Buffer.concat([Buffer.from(`${box.repo}/`), name]), 'const y = x as any;\n');
    box.git('add', '-A');
    box.git('commit', '-qm', 'change');
    const result = box.runLocal('main');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^guardrails: .*empty diff/);
    expectNoPass(result);
  });

  it('a mode-only change is not an empty diff', () => {
    const box = sandbox();
    box.base({ 'a.sh': 'echo\n' });
    box.git('checkout', '-q', '-b', 'topic');
    box.git('update-index', '--chmod=+x', 'a.sh');
    box.git('commit', '-qm', 'change');
    const result = box.runLocal('main');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guardrails: base ');
    expect(result.stdout).toContain('1 changed file(s)');
    expect(result.stdout).toContain('guardrails: report empty');
  });

  it('a glob-like file name diffs only itself', () => {
    const box = sandbox();
    box.base({ 'a.test.ts': 'expect(1);\n', '[ab].test.ts': 'expect(1);\n' });
    box.topic({
      'a.test.ts': 'expect(1);\nconst y = x as any;\n',
      '[ab].test.ts': 'expect(1);\nconst z = 1;\n',
    });
    const result = box.runLocal('main');
    expect(result.status).toBe(0);
    expect(reportLines(result.stdout).slice(1, -1)).toEqual([
      'guardrails: a.test.ts - added eslint-disable, @ts-expect-error, @ts-ignore or as any',
    ]);
  });
});
