import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The byte caps that skill-sync.test.ts enforces. This file only warns early, never fails on size.
type CappedDoc = { name: string; size: number; cap: number };

const root = fileURLToPath(new URL('../../../', import.meta.url));

function nearCap(name: string, size: number, cap: number): string | undefined {
  if (size * 5 <= cap * 4) return undefined;
  const percent = Math.floor((size * 100) / cap);
  return `${name} is ${String(size)}/${String(cap)} bytes (${String(percent)}%), above 80% of its cap`;
}

function warnNearCap(docs: CappedDoc[], warn: (message: string) => void = console.warn): void {
  for (const { name, size, cap } of docs) {
    const message = nearCap(name, size, cap);
    if (message !== undefined) warn(message);
  }
}

function filesIn(directory: string, pattern: RegExp, cap: number): CappedDoc[] {
  return readdirSync(`${root}${directory}`)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => ({
      name: `${directory}${name}`,
      size: Buffer.byteLength(readFileSync(`${root}${directory}${name}`)),
      cap,
    }));
}

// Read from the directories skill-sync.test.ts pins to its lists, so a new page is included.
// Command pages are read from disk, not rendered: the renderer throws above its cap, and
// skill-sync.test.ts pins the committed pages to fresh output. Guide copies in references/ are
// skipped; skill-sync.test.ts pins them to the docs/ pages scanned here.
function cappedDocs(): CappedDoc[] {
  return [
    ...filesIn('packages/skills/spur-board/', /^SKILL\.md$/, 5120),
    ...filesIn('packages/skills/setup/', /^SKILL\.md$/, 5120),
    ...filesIn('packages/skills/spur-board/references/', /^(?!how-board|web-ui).*\.md$/, 6553),
    ...filesIn('docs/', /^(how-board|web-ui).*\.md$/, 8192),
    ...filesIn('packages/skills/setup/references/', /\.md$/, 8192),
  ];
}

describe('capped doc sizes', () => {
  it('warns, without failing, for each capped doc above 80% of its cap', () => {
    const docs = cappedDocs();
    expect(docs.filter((doc) => doc.name.endsWith('/SKILL.md'))).toHaveLength(2);
    expect(docs.filter((doc) => doc.name.startsWith('docs/how-board-works'))).not.toHaveLength(0);
    expect(docs.map((doc) => doc.name)).toContain('packages/skills/spur-board/references/tasks.md');
    warnNearCap(docs);
  });

  it('warns only above 80% of a cap', () => {
    expect(nearCap('docs/a.md', 6554, 8192)).toBe(
      'docs/a.md is 6554/8192 bytes (80%), above 80% of its cap',
    );
    expect(nearCap('a/SKILL.md', 4097, 5120)).toMatch(/above 80% of its cap$/);
    expect(nearCap('docs/a.md', 6553, 8192)).toBeUndefined();
    expect(nearCap('a/SKILL.md', 4096, 5120)).toBeUndefined();
    const warned: string[] = [];
    const docs = [
      { name: 'over.md', size: 8000, cap: 8192 },
      { name: 'under.md', size: 100, cap: 8192 },
      { name: 'edge.md', size: 4096, cap: 5120 },
    ];
    expect(() => {
      warnNearCap(docs, (message) => warned.push(message));
    }).not.toThrow();
    expect(warned).toEqual(['over.md is 8000/8192 bytes (97%), above 80% of its cap']);
  });
});
