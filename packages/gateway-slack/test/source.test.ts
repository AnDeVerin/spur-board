import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const forbiddenChannel = /#(?:orchestrators|board-feed)(?![\w-])/;
const forbiddenCommand = /(?<![\w./-])(?:\\\/|\/)board(?![\w/-])/;

function hasHardCodedName(source: string): boolean {
  return forbiddenChannel.test(source) || forbiddenCommand.test(source);
}

const mrkdwnBuilder = /type:\s*['"`]mrkdwn['"`]|\bas\s+Mrkdwn\b/;

/** Only render.ts may build a mrkdwn field or cast to `Mrkdwn`; everything else gets it typed. */
function buildsMrkdwn(source: string): boolean {
  return mrkdwnBuilder.test(source);
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

describe('mrkdwn outside render.ts', () => {
  it('recognizes a mrkdwn field or a Mrkdwn cast, not the type or the mrkdwn flag', () => {
    for (const source of [
      "{ type: 'mrkdwn', text }",
      '{ type: "mrkdwn", text }',
      'text as Mrkdwn',
      'parts as Mrkdwn[]',
    ]) {
      expect(buildsMrkdwn(source), source).toBe(true);
    }
    for (const source of [
      'text: Mrkdwn,',
      'import { type Mrkdwn } from',
      'mrkdwn: false,',
      "{ type: 'plain_text', text }",
    ]) {
      expect(buildsMrkdwn(source), source).toBe(false);
    }
  });

  it('builds mrkdwn fields and Mrkdwn values only in render.ts', () => {
    const directory = fileURLToPath(new URL('../src/', import.meta.url));
    const render = join(directory, 'render.ts');
    const files = sourceFiles(directory);
    expect(files).toContain(render);
    expect(buildsMrkdwn(readFileSync(render, 'utf8'))).toBe(true);
    const matches = files
      .filter((path) => path !== render)
      .filter((path) => buildsMrkdwn(readFileSync(path, 'utf8')));
    expect(matches).toEqual([]);
  });
});
