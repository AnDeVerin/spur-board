import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const forbiddenChannel = /#(?:orchestrators|board-feed)(?![\w-])/;
const forbiddenCommand = /(?<![\w./-])(?:\\\/|\/)board(?![\w/-])/;

function hasHardCodedName(source: string): boolean {
  return forbiddenChannel.test(source) || forbiddenCommand.test(source);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('gateway and core Slack names', () => {
  it('recognizes standalone names without treating source paths as commands', () => {
    for (const source of [
      "'/board'",
      "'/board status'",
      'x.replace(/^\\/board\\b/, name)',
      "'#orchestrators'",
      "'#board-feed'",
    ]) {
      expect(hasHardCodedName(source), source).toBe(true);
    }
    for (const source of [
      "'./board-utils.ts'",
      "'packages/core/src/app/board-utils.ts'",
      "'/board-helper.ts'",
      "'#orchestrators-help'",
    ]) {
      expect(hasHardCodedName(source), source).toBe(false);
    }
  });

  it('finds no fixed Slack names in gateway or core sources', () => {
    const directories = [
      fileURLToPath(new URL('../src/', import.meta.url)),
      fileURLToPath(new URL('../../core/src/', import.meta.url)),
    ];
    const matches = directories
      .flatMap(sourceFiles)
      .filter((path) => hasHardCodedName(readFileSync(path, 'utf8')));
    expect(matches).toEqual([]);
  });
});
