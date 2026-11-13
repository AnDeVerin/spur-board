import { ESLint } from 'eslint';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import maxLinesBaseline from '../../../eslint/max-lines-baseline.ts';

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
  overrideConfig: [{ files: ['**/*.{ts,mjs}'], ...tseslint.configs.disableTypeChecked }],
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
    ['switch-not-exhaustive.ts', '@typescript-eslint/switch-exhaustiveness-check'],
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

describe('journal insert lint rule', () => {
  const insert = "export const q = trx.insertInto('event');";

  it.each(['packages/core/src/app/x.ts', 'packages/daemon/src/x.ts'])(
    'an event insert in %s reports no-restricted-syntax',
    async (path) => {
      expect(await textRuleIds(insert, path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );

  // A no-substitution template literal keeps its text in `quasis`, not `value`.
  it.each(['packages/core/src/app/x.ts', 'packages/daemon/src/x.ts'])(
    'a template-literal event insert in %s reports no-restricted-syntax',
    async (path) => {
      const code = 'export const q = trx.insertInto(`event`);';
      expect(await textRuleIds(code, path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );

  it.each([
    ['packages/core/src/app/board-utils.ts', insert],
    ['packages/core/src/app/board-utils.ts', 'export const q = trx.insertInto(`event`);'],
    ['packages/core/src/app/x.ts', 'export const q = trx.insertInto(`task`);'],
    ['packages/core/src/app/x.ts', "export const q = trx.insertInto('task');"],
  ])(
    '%s passes %s',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );

  // The stand ban is a no-restricted-imports block on the same files; both still apply.
  it.each(['packages/core/src/app/x.ts', 'packages/daemon/src/x.ts'])(
    '%s reports both the stand import ban and the event insert ban',
    async (path) => {
      const code = `import { trx } from '@spur-board/stand';\n${insert}`;
      expect(await textRuleIds(code, path)).toEqual([
        'no-restricted-imports',
        'no-restricted-syntax',
      ]);
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
    ['packages/gateway-slack/src/x.ts', "export const m = import('better-sqlite3');"],
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
    ['packages/adapters/src/github/x.ts', 'export const a = (v: unknown) => Array.isArray(v);'],
    ['packages/adapters/src/jira/x.ts', "export const o = (v: unknown) => typeof v === 'object';"],
    [
      'packages/adapters/src/spur/x.ts',
      'export const r = (v: unknown) => v as Record<string, unknown>;',
    ],
    [
      'packages/adapters/src/jira/x.ts',
      'export function string(v: unknown): string { return String(v); }',
    ],
    [
      'packages/adapters/src/github/x.ts',
      'export const number = (v: unknown): number => Number(v);',
    ],
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
    ['packages/adapters/src/runner/x.ts', 'export const a = (v: unknown) => Array.isArray(v);'],
    ['packages/adapters/src/github/x.ts', 'export const number = 1;'],
  ])(
    'leaves %s outside the adapters boundary: %s passes',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );
});

describe('wall time ban', () => {
  it.each([
    ['packages/adapters/src/x.ts', 'export const t = Date.now();'],
    ['packages/adapters/src/runner/x.ts', 'export const f = Date.now;'],
    ['packages/adapters/src/github/x.ts', 'export const d = new Date();'],
    ['packages/adapters/src/spur/x.ts', 'export const s = Date();'],
    ['packages/gateway-slack/src/x.ts', 'export const t = Date.now();'],
    ['packages/gateway-slack/src/x.ts', 'export const d = new Date();'],
  ])(
    '%s: %s reports no-restricted-syntax',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual(['no-restricted-syntax']);
    },
    30_000,
  );

  it.each([
    ['packages/adapters/src/x.ts', 'export const d = new Date(0);'],
    ['packages/adapters/src/x.ts', "export const p = Date.parse('2026-01-01');"],
    ['packages/adapters/test/x.test.ts', 'export const t = Date.now();'],
    ['packages/gateway-slack/test/x.ts', 'export const t = Date.now();'],
    ['packages/daemon/src/x.ts', 'export const t = Date.now();'],
    ['packages/gateway-slack/src/testing.ts', 'export const t = Date.now();'],
  ])(
    '%s: %s passes',
    async (path, code) => {
      expect(await textRuleIds(code, path)).toEqual([]);
    },
    30_000,
  );
});

describe('Slack fake boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it.each([
    ['packages/daemon/src/x.ts', '@spur-board/gateway-slack/testing'],
    ['packages/contracts/src/x.ts', '@spur-board/gateway-slack/testing'],
    ['packages/daemon/src/x.ts', '../../gateway-slack/src/testing.ts'],
    ['packages/gateway-slack/src/x.ts', './testing.ts'],
    ['packages/gateway-slack/src/sub/x.ts', '../testing.ts'],
    ['packages/gateway-slack/src/sub/deeper/x.ts', '../../testing'],
    ['packages/gateway-slack/src/x.ts', '@spur-board/gateway-slack/testing'],
  ])(
    '%s: import of %s reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  // Core's gateway ban matches too; one report per matching ban shows both bans hold.
  it('core/src reports both the Slack fake and the gateway ban', async () => {
    expect(
      await textRuleIds(imports('@spur-board/gateway-slack/testing'), 'packages/core/src/x.ts'),
    ).toEqual(['no-restricted-imports', 'no-restricted-imports']);
  }, 30_000);

  // The blocks replace earlier import options, so the older bans must still hold there.
  it.each([
    ['packages/daemon/src/x.ts', '@spur-board/stand'],
    ['packages/gateway-slack/src/x.ts', 'better-sqlite3'],
    ['packages/contracts/src/x.ts', 'node:sqlite'],
  ])(
    '%s: import of %s still reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    ['packages/daemon/test/x.test.ts', '@spur-board/gateway-slack/testing'],
    ['packages/stand/src/x.ts', '@spur-board/gateway-slack/testing'],
    ['packages/gateway-slack/test/x.test.ts', '@spur-board/gateway-slack/testing'],
    ['packages/gateway-slack/src/testing.ts', './ref.ts'],
    ['packages/gateway-slack/src/sub/x.ts', '../ref.ts'],
    ['packages/gateway-slack/src/x.ts', './testing-helpers.ts'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );
});

describe('core gateway boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it.each([
    ['packages/core/src/x.ts', '@spur-board/gateway-slack'],
    ['packages/core/src/x.ts', '@spur-board/gateway-testkit'],
    ['packages/core/src/x.ts', '../../gateway-slack/src/index.ts'],
    ['packages/core/src/app/x.ts', '@spur-board/gateway-slack'],
    ['packages/core/src/x.ts', '@spur-board/stand'],
  ])(
    '%s: import of %s reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    ['packages/daemon/src/x.ts', '@spur-board/gateway-slack'],
    ['packages/core/test/x.test.ts', '@spur-board/gateway-testkit'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );
});

describe('domain boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it.each([
    ['packages/core/src/domain/x.ts', '../store/schema.ts'],
    ['packages/core/src/domain/x.ts', '../app/outbox.ts'],
    ['packages/core/src/domain/x.ts', '../api/server.ts'],
    ['packages/core/src/domain/blocks/x.ts', '../../store/x.ts'],
    ['packages/core/src/domain/x.ts', 'kysely'],
    ['packages/core/src/domain/x.ts', 'node:fs'],
    ['packages/core/src/domain/x.ts', 'better-sqlite3'],
    ['packages/core/src/domain/x.ts', '../index.ts'],
    ['packages/core/src/domain/x.ts', '@spur-board/core'],
    ['packages/core/src/domain/x.ts', '@spur-board/stand'],
  ])(
    '%s: import of %s reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    "export const m = import('../store/schema.ts');",
    "export type T = import('kysely').Kysely<never>;",
    "export const q = trx.insertInto('event');",
  ])(
    '%s reports no-restricted-syntax',
    async (code) => {
      expect(await textRuleIds(code, 'packages/core/src/domain/x.ts')).toEqual([
        'no-restricted-syntax',
      ]);
    },
    30_000,
  );

  it.each([
    ['packages/core/src/domain/x.ts', './gates.ts'],
    ['packages/core/src/domain/blocks/x.ts', '../gates.ts'],
    ['packages/core/src/domain/x.ts', '@spur-board/contracts'],
    ['packages/core/src/domain/x.ts', 'node:crypto'],
    ['packages/core/src/app/x.ts', '../store/schema.ts'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );
});

describe('max-lines', () => {
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, i) => `export const a${String(i)} = ${String(i)};`).join(
      '\n',
    );

  it('reports a file over 500 counted lines', async () => {
    expect(await textRuleIds(lines(501), 'packages/core/src/x.ts')).toEqual(['max-lines']);
  }, 30_000);

  it('passes a file of 500 lines and a baseline file of 501', async () => {
    expect(await textRuleIds(lines(500), 'packages/core/src/x.ts')).toEqual([]);
    expect(await textRuleIds(lines(501), 'packages/core/src/app/observe.ts')).toEqual([]);
  }, 30_000);

  it('lists only files that exist', () => {
    expect(maxLinesBaseline.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});

describe('CLI boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it('rejects a normalized relative path that reaches core through contracts', async () => {
    expect(
      await textRuleIds(imports('../../contracts/../core/src/index.ts'), 'packages/cli/src/x.ts'),
    ).toEqual(['local/cli-import-boundary']);
  }, 30_000);

  it.each([
    ['packages/cli/src/x.ts', '@spur-board/core'],
    ['packages/cli/src/x.ts', '@spur-board/daemon'],
    ['packages/cli/src/x.ts', '@spur-board/adapters'],
    ['packages/cli/src/x.ts', '@spur-board/gateway-slack'],
    ['packages/cli/src/x.ts', '@spur-board/testkit'],
    ['packages/cli/src/x.ts', '@spur-board/contracts-extra'],
    ['packages/cli/src/x.mjs', '@spur-board/core'],
  ])(
    '%s: import of %s reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  it.each([
    ['packages/cli/src/x.ts', '../../core/src/index.ts'],
    ['packages/cli/src/deep/x.ts', '../../../daemon/src/main.ts'],
    ['packages/cli/test/x.test.ts', '../../core/src/index.ts'],
    ['packages/cli/test/x.test.ts', '../../../packages/daemon/src/main.ts'],
    ['packages/cli/src/x.mjs', '../../contracts/../core/src/index.ts'],
    ['packages/cli/src/x.ts', '../../../scripts/check.ts'],
  ])(
    '%s: normalized import of %s reports local/cli-import-boundary',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['local/cli-import-boundary']);
    },
    30_000,
  );

  it.each([
    "export * from '../../contracts/../core/src/index.ts';",
    "import type { X } from '../../contracts/../core/src/index.ts';\nexport type Y = X;",
  ])(
    'rejects a normalized relative re-export or type import',
    async (code) => {
      expect(await textRuleIds(code, 'packages/cli/src/x.ts')).toEqual([
        'local/cli-import-boundary',
      ]);
    },
    30_000,
  );

  it.each([
    [
      'packages/cli/src/x.ts',
      "import type { X } from '@spur-board/core';\nexport type Y = X;",
      'no-restricted-imports',
    ],
    [
      'packages/cli/src/x.ts',
      "export const x = import('@spur-board/core');",
      'no-restricted-syntax',
    ],
    [
      'packages/cli/test/x.test.ts',
      "export const x = import('../../daemon/src/main.ts');",
      'no-restricted-syntax',
    ],
    [
      'packages/cli/src/x.ts',
      "export type X = import('@spur-board/core').X;",
      'no-restricted-syntax',
    ],
    ['packages/cli/test/x.test.ts', "vi.mock('x');", 'no-restricted-syntax'],
    [
      'packages/cli/src/x.mjs',
      "export const x = import('@spur-board/core');",
      'no-restricted-syntax',
    ],
    [
      'packages/cli/src/x.mjs',
      "export const x = import('../../core/src/index.ts');",
      'no-restricted-syntax',
    ],
  ])(
    '%s: forbidden import form reports its boundary rule',
    async (path, code, rule) => {
      expect(await textRuleIds(code, path)).toEqual([rule]);
    },
    30_000,
  );

  it.each([
    ['packages/cli/src/x.ts', '@spur-board/contracts'],
    ['packages/cli/test/x.test.ts', '@spur-board/contracts'],
    ['packages/cli/src/x.ts', '../../contracts/src/index.ts'],
    ['packages/cli/src/x.ts', '../../core/../contracts/src/index.ts'],
    ['packages/cli/src/x.ts', './client.ts'],
    ['packages/cli/src/x.mjs', '@spur-board/contracts'],
    ['packages/core/src/x.ts', '@spur-board/core'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );

  it('allows the minimal entrypoint to load its own command module', async () => {
    expect(
      await textRuleIds("export const command = import('./cli.ts');", 'packages/cli/src/x.mjs'),
    ).toEqual([]);
    expect(
      await textRuleIds("export const mcp = import('./mcp.ts');", 'packages/cli/src/x.mjs'),
    ).toEqual([]);
    expect(
      await textRuleIds("export const other = import('./other.ts');", 'packages/cli/src/x.mjs'),
    ).toEqual(['no-restricted-syntax']);
  }, 30_000);

  it('rejects console output in CLI source', async () => {
    expect(await textRuleIds("console.log('oops');", 'packages/cli/src/x.ts')).toEqual([
      'no-console',
    ]);
  }, 30_000);
});

describe('stand boundary', () => {
  const imports = (from: string): string => `import { x } from '${from}';\nexport const y = x;`;

  it.each([
    ['packages/core/src/x.ts', '@spur-board/stand'],
    ['packages/daemon/src/x.ts', '@spur-board/stand'],
    ['packages/contracts/src/x.ts', '@spur-board/stand'],
    ['packages/gateway-slack/src/x.ts', '@spur-board/stand'],
    ['packages/adapters/src/x.ts', '../../stand/src/stand.ts'],
    ['packages/daemon/src/x.ts', '../../stand/src/stand.ts'],
    ['packages/core/test/x.test.ts', '../../../packages/stand/src/stand.ts'],
  ])(
    '%s: import of %s reports no-restricted-imports',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual(['no-restricted-imports']);
    },
    30_000,
  );

  // Their own boundary already rejects every workspace package but contracts; the stand pattern
  // reports a second time, which shows it is in their import options too.
  it.each(['packages/adapters/src/x.ts', 'packages/cli/src/x.ts'])(
    '%s: import of @spur-board/stand reports both bans',
    async (path) => {
      expect(await textRuleIds(imports('@spur-board/stand'), path)).toEqual([
        'no-restricted-imports',
        'no-restricted-imports',
      ]);
    },
    30_000,
  );

  it.each([
    ['packages/stand/src/x.ts', '@spur-board/daemon/in-process'],
    ['packages/stand/test/x.test.ts', '../src/stand.ts'],
  ])(
    '%s: import of %s passes',
    async (path, from) => {
      expect(await textRuleIds(imports(from), path)).toEqual([]);
    },
    30_000,
  );
});
