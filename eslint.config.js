import comments from '@eslint-community/eslint-plugin-eslint-comments';
import vitest from '@vitest/eslint-plugin';
import { dirname, resolve, sep } from 'node:path';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import noProjectLiteralCompare from './eslint/no-project-literal-compare.ts';
import skipNeedsFlakyIssue from './eslint/skip-needs-flaky-issue.ts';

const cliRoot = resolve(import.meta.dirname, 'packages/cli');
const contractsRoot = resolve(import.meta.dirname, 'packages/contracts');
const within = (root, target) => target === root || target.startsWith(`${root}${sep}`);
const cliImportBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      outside: 'The CLI may import only its own files and packages/contracts by relative path.',
    },
  },
  create(context) {
    const check = (node) => {
      const source = node.source;
      const specifier = source?.value;
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
      const target = resolve(dirname(context.filename), specifier);
      if (within(cliRoot, target) || within(contractsRoot, target)) return;
      context.report({ node: source, messageId: 'outside' });
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

// One plugin object: ESLint rejects two different objects under the same plugin name.
const local = {
  rules: {
    'cli-import-boundary': cliImportBoundary,
    'no-project-literal-compare': noProjectLiteralCompare,
    'skip-needs-flaky-issue': skipNeedsFlakyIssue,
  },
};

const viMockBan = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
  message:
    'Do not mock modules with vi.mock. Pass the dependency in as a parameter and give the test a fake or a local server.',
};

// Only core owns the database, and daemon wires it; everyone else goes through core.
// `[/]` instead of `\/`: esquery's regex parser breaks on an escaped slash.
const sqliteMessage =
  'Only packages/core and packages/daemon may import the SQLite driver. Go through @spur-board/core.';
const sqliteImportBan = {
  selector: 'ImportExpression[source.value=/^(better-sqlite3|node:sqlite)([/]|$)/]',
  message: sqliteMessage,
};
const sqliteTypeImportBan = {
  selector: 'TSImportType[source.value=/^(better-sqlite3|node:sqlite)([/]|$)/]',
  message: sqliteMessage,
};
const sqliteBoundaryIgnores = ['packages/core/**', 'packages/daemon/**'];
const sqliteImportOptions = {
  paths: [
    { name: 'better-sqlite3', message: sqliteMessage },
    { name: 'node:sqlite', message: sqliteMessage },
  ],
  patterns: [{ group: ['better-sqlite3/*'], message: sqliteMessage }],
};

// One journal writer: `emit` fills `request_id` from the command scope, so no other module
// inserts into the `event` table. A template literal keeps its text in `quasis`, not `value`.
const journalInsertBan = {
  selector:
    "CallExpression[callee.property.name='insertInto']:matches([arguments.0.value='event'], [arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked='event'])",
  message: 'Write journal events only through emit in packages/core/src/app/board-utils.ts.',
};

// The stand drives the board from outside; production code never learns about it. The global,
// adapters and CLI import options restate these patterns, and core and daemon get their own block.
const standBoundaryPatterns = [
  {
    regex: '^@spur-board/stand(/|$)',
    caseSensitive: true,
    message: 'Production packages do not import the stand.',
  },
  {
    regex: '^([.][.]/)+(packages/)?stand(/|$)',
    caseSensitive: true,
    message: 'Production packages do not import the stand.',
  },
];
const globalImportOptions = {
  paths: sqliteImportOptions.paths,
  patterns: [...sqliteImportOptions.patterns, ...standBoundaryPatterns],
};

// Adapters reach core through the runner's port, and each adapter folder stays on its own;
// only `github/client` is shared. Same-rule options replace earlier ones, so every adapters
// block restates the SQLite ban.
const adapterBoundaryPatterns = [
  {
    regex: '^@spur-board/(?!contracts(/|$))',
    caseSensitive: true,
    message: 'Adapters import only @spur-board/contracts. Reach core through the runner port.',
  },
  {
    regex: '^([.][.]/)+(packages/)?(core|daemon)(/|$)',
    caseSensitive: true,
    message: 'Adapters do not import core or daemon files. Reach core through the runner port.',
  },
];
function adapterImports(extraPatterns = []) {
  return [
    'error',
    {
      paths: sqliteImportOptions.paths,
      patterns: [
        ...sqliteImportOptions.patterns,
        ...standBoundaryPatterns,
        ...adapterBoundaryPatterns,
        ...extraPatterns,
      ],
    },
  ];
}
const cliBoundaryPatterns = [
  {
    regex: '^@spur-board/(?!contracts(/|$))',
    caseSensitive: true,
    message: 'The CLI imports only @spur-board/contracts among workspace packages.',
  },
];
const cliImports = [
  'error',
  {
    paths: sqliteImportOptions.paths,
    patterns: [...sqliteImportOptions.patterns, ...standBoundaryPatterns, ...cliBoundaryPatterns],
  },
];
const adapterFolders = ['github', 'jira', 'spur'];
function siblingPattern(folder) {
  const others = adapterFolders
    .filter((other) => other !== folder)
    .map((other) =>
      other === 'github' ? '(^|/)github(/(?!client([.]ts)?$)|$)' : `(^|/)${other}(/|$)`,
    );
  return {
    regex: others.join('|'),
    caseSensitive: true,
    message: 'Adapter folders do not import each other; only github/client is shared.',
  };
}
// Both bans cover the SQLite driver too, so they replace sqliteImportBan and sqliteTypeImportBan.
const dynamicImportBan = {
  selector: 'ImportExpression',
  message: 'Use a static import so the boundary lint can check it.',
};
const importTypeBan = {
  selector: 'TSImportType',
  message: 'Use a static import so the boundary lint can check it.',
};
// Adapter folders parse responses with zod wire schemas, never with hand-written walkers.
const wireWalkerMessage = 'Parse responses with a zod wire schema (writing-adapters).';
const wireWalkerNames = '/^(record|list|string|array|object|number|connectionNodes)$/';
const wireWalkerBans = [
  "CallExpression[callee.object.name='Array'][callee.property.name='isArray']",
  "BinaryExpression[left.operator='typeof'][right.value='object']",
  "BinaryExpression[right.operator='typeof'][left.value='object']",
  "TSAsExpression[typeAnnotation.typeName.name='Record']",
  `FunctionDeclaration[id.name=${wireWalkerNames}]`,
  `VariableDeclarator[id.name=${wireWalkerNames}][init.type=/^(ArrowFunctionExpression|FunctionExpression)$/]`,
].map((selector) => ({ selector, message: wireWalkerMessage }));
// Adapters and the Slack gateway read the time only from the `now` the daemon passes in.
const wallTimeMessage =
  'Read the time from the injected `now`; only the daemon binds the wall clock.';
const wallTimeBans = [
  "MemberExpression[object.name='Date'][property.name='now']",
  "NewExpression[callee.name='Date'][arguments.length=0]",
  "CallExpression[callee.name='Date']",
].map((selector) => ({ selector, message: wallTimeMessage }));

export default defineConfig(
  {
    // ESLint does not read .gitignore.
    ignores: [
      '**/node_modules/**',
      'packages/*/test/lint-fixtures/**',
      '.scratch/**',
      '.gstack/**',
      '**/dist/**',
      '**/coverage/**',
      '.vitest/**',
      '.stryker-tmp/**',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'release.config.cjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  {
    plugins: { '@eslint-community/eslint-comments': comments },
    rules: { '@eslint-community/eslint-comments/require-description': 'error' },
  },
  {
    files: ['packages/*/test/**/*.ts', '**/*.test.ts'],
    plugins: { vitest, local },
    rules: {
      'vitest/no-focused-tests': 'error',
      'local/skip-needs-flaky-issue': 'error',
      'no-restricted-syntax': ['error', viMockBan],
    },
  },
  {
    // Project-specific behaviour comes from the config, never from a hard-coded project id.
    files: ['packages/core/**/*.ts', 'packages/adapters/**/*.ts'],
    plugins: { local },
    rules: { 'local/no-project-literal-compare': 'error' },
  },
  {
    files: ['**/*.ts', '**/*.js'],
    ignores: sqliteBoundaryIgnores,
    rules: {
      'no-restricted-imports': ['error', globalImportOptions],
      'no-restricted-syntax': ['error', sqliteImportBan, sqliteTypeImportBan],
    },
  },
  {
    // Core and daemon may import SQLite, so the global import options skip them.
    files: ['packages/core/**/*.ts', 'packages/daemon/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: standBoundaryPatterns }] },
  },
  {
    // Same-rule options replace earlier ones, so the gateway restates both sqlite bans.
    files: ['packages/gateway-slack/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', sqliteImportBan, sqliteTypeImportBan, ...wallTimeBans],
    },
  },
  {
    // No earlier no-restricted-syntax options apply to these sources, so nothing to restate.
    files: ['packages/core/src/**/*.ts', 'packages/daemon/src/**/*.ts'],
    ignores: ['packages/core/src/app/board-utils.ts'],
    rules: { 'no-restricted-syntax': ['error', journalInsertBan] },
  },
  {
    // Same-rule options replace earlier ones, so test files restate the vi.mock ban.
    files: ['packages/*/test/**/*.ts', '**/*.test.ts'],
    ignores: sqliteBoundaryIgnores,
    rules: {
      'no-restricted-syntax': ['error', viMockBan, sqliteImportBan, sqliteTypeImportBan],
    },
  },
  {
    files: ['packages/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': adapterImports(),
      'no-restricted-syntax': ['error', dynamicImportBan, importTypeBan, ...wallTimeBans],
    },
  },
  ...adapterFolders.map((folder) => ({
    files: [`packages/adapters/src/${folder}/**/*.ts`],
    rules: {
      'no-restricted-imports': adapterImports([siblingPattern(folder)]),
      'no-restricted-syntax': [
        'error',
        dynamicImportBan,
        importTypeBan,
        ...wireWalkerBans,
        ...wallTimeBans,
      ],
    },
  })),
  {
    files: ['packages/adapters/test/**/*.ts', 'packages/adapters/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', viMockBan, dynamicImportBan, importTypeBan] },
  },
  {
    files: ['packages/cli/**/*.{ts,mjs}'],
    plugins: { local },
    rules: { 'local/cli-import-boundary': 'error' },
  },
  {
    files: ['packages/cli/src/**/*.{ts,mjs}'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['packages/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': cliImports,
      'no-restricted-syntax': [
        'error',
        sqliteImportBan,
        sqliteTypeImportBan,
        dynamicImportBan,
        importTypeBan,
      ],
    },
  },
  {
    files: ['packages/cli/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        viMockBan,
        sqliteImportBan,
        sqliteTypeImportBan,
        dynamicImportBan,
        importTypeBan,
      ],
    },
  },
  {
    // The tiny JavaScript entrypoint may lazily load only its two command modules.
    files: ['packages/cli/**/*.mjs'],
    rules: {
      'no-restricted-imports': cliImports,
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value!='./cli.ts'][source.value!='./mcp.ts']",
          message: 'The CLI entrypoint may dynamically import only its own command modules.',
        },
      ],
    },
  },
);
