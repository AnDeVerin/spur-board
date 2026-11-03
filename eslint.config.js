import comments from '@eslint-community/eslint-plugin-eslint-comments';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import noProjectLiteralCompare from './eslint/no-project-literal-compare.ts';
import skipNeedsFlakyIssue from './eslint/skip-needs-flaky-issue.ts';

// One plugin object: ESLint rejects two different objects under the same plugin name.
const local = {
  rules: {
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
        projectService: { allowDefaultProject: ['eslint.config.js'] },
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
);
