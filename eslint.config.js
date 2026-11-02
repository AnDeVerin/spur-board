import comments from '@eslint-community/eslint-plugin-eslint-comments';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import skipNeedsFlakyIssue from './eslint/skip-needs-flaky-issue.ts';

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
    plugins: {
      vitest,
      local: { rules: { 'skip-needs-flaky-issue': skipNeedsFlakyIssue } },
    },
    rules: {
      'vitest/no-focused-tests': 'error',
      'local/skip-needs-flaky-issue': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
          message:
            'Do not mock modules with vi.mock. Pass the dependency in as a parameter and give the test a fake or a local server.',
        },
      ],
    },
  },
);
