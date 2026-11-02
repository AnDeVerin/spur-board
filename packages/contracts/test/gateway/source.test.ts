import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scanned = ['packages/contracts/src/gateway', 'packages/core'];
const skipped = new Set(['node_modules', 'dist', 'coverage']);
const platformTerms = /thread_ts|channel|mrkdwn|@slack\//i;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('no Slack fields', () => {
  it('flags platform terms and leaves neutral words alone', () => {
    for (const term of ['thread_ts', 'Channel', 'MRKDWN', "from '@slack/bolt'"]) {
      expect(term).toMatch(platformTerms);
    }
    for (const word of ['block', 'Block Kit', 'conversation', 'space']) {
      expect(word).not.toMatch(platformTerms);
    }
  });

  it('keeps platform terms out of the contract and core', () => {
    const files = scanned.flatMap((dir) => filesUnder(join(root, dir)));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const hits = files
      .filter((file) => platformTerms.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(hits).toEqual([]);
  });
});

describe('obligation ids', () => {
  it('lists G1-G15 in order, each once, in the Gateway TSDoc', () => {
    const source = readFileSync(join(root, 'packages/contracts/src/gateway/gateway.ts'), 'utf8');
    const ids = [...source.matchAll(/^\s*\*\s+- (G\d+):/gm)].map((match) => match[1]);
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => `G${String(i + 1)}`));
  });
});
