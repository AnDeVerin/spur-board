import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
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
