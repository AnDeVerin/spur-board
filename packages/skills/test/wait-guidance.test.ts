import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Kept apart from skill-sync.test.ts, which is at the max-lines limit.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const waitSection = (text: string) => text.split('\n### `board wait`\n')[1]?.split('\n### ')[0];

describe('board wait guidance', () => {
  // One wording of what a wait is for, in every place an agent reads about it (#826).
  it.each([
    ['SKILL.md Turns', read('../spur-board/SKILL.md').split('\n## Turns\n')[1]?.split('\n## ')[0]],
    ['blocks.md', waitSection(read('../spur-board/references/blocks.md'))],
    ['how-board-works-waits.md', read('../spur-board/references/how-board-works-waits.md')],
    ['docs/how-board-works-waits.md', read('../../../docs/how-board-works-waits.md')],
    ['docs/cli.md', waitSection(read('../../../docs/cli.md'))],
  ])('states the wait purpose and its own-work counter-example in %s', (_name, text) => {
    const normalised = text?.replace(/\s+/g, ' ');
    expect(normalised).toContain(
      'Wait only on a condition you cannot change and must re-check: a busy test stand, no free slot, high machine load, a deploy, an outside service.',
    );
    expect(normalised).toContain(
      'Not on your own work (review fixes, tests, checks, rebasing): work holding the turn, so a stall reaches the operator; a wait hides it.',
    );
    expect(normalised).not.toContain('such as a busy test stand');
  });
});
