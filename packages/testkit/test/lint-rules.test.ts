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
  // The paths are virtual (packages/core does not exist yet), so type-aware rules are off.
  const virtual = new ESLint({
    cwd: root,
    ignore: false,
    overrideConfig: [{ files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked }],
  });

  async function textRuleIds(code: string, path: string): Promise<(string | null)[]> {
    const results = await virtual.lintText(code, { filePath: join(root, path) });
    return results.flatMap((result) => result.messages.map((message) => message.ruleId));
  }

  it.each([
    "export const r = task.project === 'web';",
    "export const r = 'web' !== task.project;",
    'export const r = projectId == `web`;',
    "export const r = task?.project === 'web';",
    "export function f(): number { switch (task.project) { case 'web': return 1; default: return 0; } }",
    "export const r = ['web'].includes(task.project);",
    "export const r = ['web', 'board'].indexOf(task.project);",
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
