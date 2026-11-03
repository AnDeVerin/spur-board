import { ESLint } from 'eslint';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// Lints the on-disk fixtures with the real eslint.config.js. `eslint .` ignores them.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root, ignore: false });

async function ruleIds(fixture: string): Promise<(string | null)[]> {
  const results = await eslint.lintFiles([
    fileURLToPath(new URL(`./lint-fixtures/${fixture}`, import.meta.url)),
  ]);
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

// The paths are virtual (the files do not exist), so type-aware rules are off.
const virtual = new ESLint({
  cwd: root,
  ignore: false,
  overrideConfig: [{ files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked }],
});

async function textRuleIds(code: string, path: string): Promise<(string | null)[]> {
  const results = await virtual.lintText(code, { filePath: join(root, path) });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

describe('test-file lint rules', () => {
  it.each([
    ['only.ts', 'vitest/no-focused-tests'],
    ['skip-unlinked.ts', 'local/skip-needs-flaky-issue'],
    ['vi-mock.ts', 'no-restricted-syntax'],
    ['disable-no-description.ts', '@eslint-community/eslint-comments/require-description'],
  ])(
    '%s reports %s',
    async (fixture, ruleId) => {
      expect(await ruleIds(fixture)).toEqual([ruleId]);
    },
    30_000,
  );

  it.each(['skip-linked.ts', 'disable-with-description.ts'])(
    '%s passes',
    async (fixture) => {
      expect(await ruleIds(fixture)).toEqual([]);
    },
    30_000,
  );
});

describe('project id lint rule', () => {
  it.each([
    "export const r = task.project === 'web';",
    "export const r = 'web' !== task.project;",
    'export const r = projectId == `web`;',
    "export const r = task?.project === 'web';",
    "export function f(): number { switch (task.project) { case 'web': return 1; default: return 0; } }",
    "export const r = ['web'].includes(task.project);",
    "export const r = ['web', 'board'].indexOf(task.project);",
    "export const r = task.project.includes('web');",
    "export const r = projectId.indexOf('web');",
    "export const r = task?.project.startsWith('web');",
    'export const r = task.projectId.endsWith(`-web`);',
  ])(
    '%s reports local/no-project-literal-compare',
    async (code) => {
      expect(await textRuleIds(code, 'packages/core/src/x.ts')).toEqual([
        'local/no-project-literal-compare',
      ]);
    },
    30_000,
  );

  it.each([
    ['packages/core/src/x.ts', 'export const r = task.project === other.project;'],
    ['packages/core/src/x.ts', "export const r = task.status === 'web';"],
    ['packages/core/src/x.ts', 'export const r = task.project.includes(other.project);'],
    ['packages/core/src/x.ts', "export const r = task.title.includes('web');"],
    ['packages/contracts/src/x.ts', "export const r = task.project === 'web';"],
  ])(
    '%s: %s passes',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );

  it('keeps the vi.mock ban on core test files', async () => {
    expect(await textRuleIds("vi.mock('x');", 'packages/core/test/x.test.ts')).toEqual([
      'no-restricted-syntax',
    ]);
  }, 30_000);
});

describe('sqlite driver boundary', () => {
  const contractsSrc = 'packages/contracts/src/x.ts';
  const testkitTest = 'packages/testkit/test/x.test.ts';
  const typeofImport = "export type D = typeof import('better-sqlite3');";

  it.each([
    "import Database from 'better-sqlite3';\nexport const d = Database;",
    "import type { Database } from 'better-sqlite3';\nexport type D = Database;",
    "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;",
    "export * from 'better-sqlite3';",
    "import x from 'better-sqlite3/lib/database.js';\nexport const d = x;",
  ])(
    '%s reports no-restricted-imports outside core and daemon',
    async (code) => {
      expect(await textRuleIds(code, contractsSrc)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    [contractsSrc, "export const m = import('better-sqlite3');"],
    [testkitTest, "export const m = import('node:sqlite');"],
    [contractsSrc, typeofImport],
    [contractsSrc, "export type S = import('node:sqlite').DatabaseSync;"],
    [testkitTest, typeofImport],
  ])(
    '%s: %s reports no-restricted-syntax',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );

  it.each([
    [
      'packages/core/src/x.ts',
      "import Database from 'better-sqlite3';\nexport const d = Database;",
    ],
    ['packages/core/src/x.ts', "export const m = import('better-sqlite3');"],
    [
      'packages/core/test/x.test.ts',
      "import Database from 'better-sqlite3';\nexport const d = Database;",
    ],
    ['packages/core/test/x.test.ts', "export const m = import('node:sqlite');"],
    [
      'packages/daemon/src/x.ts',
      "import Database from 'better-sqlite3';\nexport const d = Database;",
    ],
    ['packages/daemon/src/x.ts', "export const m = import('better-sqlite3');"],
    [
      'packages/daemon/test/x.test.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;",
    ],
    ['packages/daemon/test/x.test.ts', "export const m = import('better-sqlite3');"],
    [contractsSrc, "export const m = import('better-sqlite3-extra');"],
    ['packages/daemon/src/x.ts', typeofImport],
    ['packages/core/test/x.test.ts', typeofImport],
    [contractsSrc, "export type X = import('better-sqlite3-extra').X;"],
  ])(
    '%s: %s passes',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );

  it.each(['packages/contracts/test/x.test.ts', 'packages/daemon/test/x.test.ts'])(
    'keeps the vi.mock ban on %s',
    async (path) => {
      expect(await textRuleIds("vi.mock('x');", path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );
});

describe('adapters boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it.each([
    ['packages/adapters/src/jira/x.ts', '../spur/a.ts'],
    ['packages/adapters/src/jira/x.ts', '../github/prBatch.ts'],
    ['packages/adapters/src/jira/x.ts', '../github/client/inner.ts'],
    ['packages/adapters/src/github/x.ts', '../jira/a.ts'],
    ['packages/adapters/src/github/x.ts', '../spur/a.ts'],
    ['packages/adapters/src/spur/sub/x.ts', '../../jira/a.ts'],
    ['packages/adapters/src/spur/x.ts', '../github/index.ts'],
    ['packages/adapters/src/x.ts', '@spur-board/core'],
    ['packages/adapters/src/x.ts', '@spur-board/daemon'],
    ['packages/adapters/src/x.ts', '@spur-board/contracts-extra'],
    ['packages/adapters/src/runner/x.ts', '../../../core/src/index.ts'],
    ['packages/adapters/src/x.ts', '../../daemon/src/main.ts'],
    ['packages/adapters/test/x.test.ts', '@spur-board/core'],
    ['packages/adapters/src/x.ts', 'better-sqlite3'],
    ['packages/adapters/src/jira/x.ts', 'node:sqlite'],
    ['packages/adapters/src/x.ts', 'better-sqlite3/lib/database.js'],
  ])(
    '%s: import of %s reports no-restricted-imports once',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    ['packages/adapters/src/x.ts', "export const m = import('@spur-board/core');"],
    ['packages/adapters/src/jira/x.ts', "export type A = import('../spur/a.ts').X;"],
    ['packages/adapters/src/x.ts', "export const m = import('better-sqlite3');"],
    ['packages/adapters/src/x.ts', "export type D = typeof import('node:sqlite');"],
    ['packages/adapters/test/x.test.ts', "export const m = import('../src/index.ts');"],
    ['packages/adapters/test/x.test.ts', "vi.mock('x');"],
  ])(
    '%s: %s reports no-restricted-syntax',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );

  it('reports a project-id literal comparison', async () => {
    expect(
      await textRuleIds("export const r = task.project === 'web';", 'packages/adapters/src/x.ts'),
    ).toEqual(['local/no-project-literal-compare']);
  }, 30_000);

  it.each([
    ['packages/adapters/src/jira/x.ts', '../github/client.ts'],
    ['packages/adapters/src/jira/x.ts', '../github/client'],
    ['packages/adapters/src/spur/x.ts', '../github/client.ts'],
    ['packages/adapters/src/jira/x.ts', '../runner/runner.ts'],
    ['packages/adapters/src/jira/x.ts', './issues.ts'],
    ['packages/adapters/src/github/x.ts', './client.ts'],
    ['packages/adapters/src/github/sub/x.ts', '../client.ts'],
    ['packages/adapters/src/x.ts', '@spur-board/contracts'],
    ['packages/adapters/src/jira/x.ts', '@spur-board/contracts/adapters'],
    ['packages/adapters/src/x.ts', './runner/runner.ts'],
    ['packages/adapters/test/runner/x.test.ts', '../../src/runner/runner.ts'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );

  it.each([
    ['packages/core/src/x.ts', imports('@spur-board/contracts')],
    ['packages/daemon/src/x.ts', imports('@spur-board/core')],
    ['packages/core/src/x.ts', "export const m = import('./y.ts');"],
  ])(
    'leaves %s outside the adapters boundary: %s passes',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );
});
