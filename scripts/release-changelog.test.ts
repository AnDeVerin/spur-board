import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepare } from './release-changelog.ts';
import { tempDir } from './test-temp-dir.ts';

const title = '# Changelog\n\nIntro.\n\n';
const untagged =
  '## [0.3.0](https://github.com/x/compare/v0.2.0...v0.3.0) (2026-11-23)\n\n' +
  '### ⚠ BREAKING CHANGES\n\n* untagged\n\n';
const tagged = '## 0.2.0 (2026-11-01)\n\n### Features\n\n* tagged\n\n';
const older = '## 0.1.5 (2026-10-01)\n\n* older\n\n';
const upgrade = '## Upgrade notes from earlier releases\n\n### 0.58.0\n\nNote.\n';

function prune(cwd: string, tags: string[]): unknown[][] {
  const logs: unknown[][] = [];
  prepare(
    { file: 'CHANGELOG.md' },
    {
      cwd,
      branch: { tags: tags.map((version) => ({ version })) },
      logger: { log: (...args: unknown[]) => logs.push(args) },
    },
  );
  return logs;
}

function changelog(text: string): string {
  const cwd = tempDir('release-changelog-');
  writeFileSync(join(cwd, 'CHANGELOG.md'), text);
  return cwd;
}

describe('release-changelog prepare', () => {
  it('drops only leading untagged entries', () => {
    const cwd = changelog(`${title}${untagged}${tagged}${older}${upgrade}`);
    expect(JSON.stringify(prune(cwd, ['0.2.0']))).toContain('0.3.0');
    expect(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(
      `${title}${tagged}${older}${upgrade}`,
    );

    // Nothing left to drop: the file stays byte for byte and nothing is logged.
    expect(prune(cwd, ['0.2.0'])).toEqual([]);
    expect(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(
      `${title}${tagged}${older}${upgrade}`,
    );
  });

  it('stops at the first heading that is not a version', () => {
    const cwd = changelog(`${title}${untagged}${tagged}${older}${upgrade}`);
    prune(cwd, []);
    expect(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(`${title}${upgrade}`);
  });

  it('does nothing without the file', () => {
    const cwd = tempDir('release-changelog-');
    expect(prune(cwd, [])).toEqual([]);
    expect(existsSync(join(cwd, 'CHANGELOG.md'))).toBe(false);
  });
});
