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
      patterns: [...sqliteImportOptions.patterns, ...adapterBoundaryPatterns, ...extraPatterns],
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
    patterns: [...sqliteImportOptions.patterns, ...cliBoundaryPatterns],
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
      'no-restricted-imports': ['error', sqliteImportOptions],
      'no-restricted-syntax': ['error', sqliteImportBan, sqliteTypeImportBan],
    },
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
      'no-restricted-syntax': ['error', dynamicImportBan, importTypeBan],
    },
  },
  ...adapterFolders.map((folder) => ({
    files: [`packages/adapters/src/${folder}/**/*.ts`],
    rules: { 'no-restricted-imports': adapterImports([siblingPattern(folder)]) },
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
    // The tiny JavaScript entrypoint may lazily load only the TypeScript CLI.
    files: ['packages/cli/**/*.mjs'],
    rules: {
      'no-restricted-imports': cliImports,
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value!='./cli.ts']",
          message: 'The CLI entrypoint may dynamically import only its own command module.',
        },
      ],
    },
  },
);
