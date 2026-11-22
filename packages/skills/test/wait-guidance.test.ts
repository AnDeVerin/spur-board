import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Kept apart from skill-sync.test.ts, which is at the max-lines limit.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const waitSection = (text: string) => text.split('\n### `board wait`\n')[1]?.split('\n### ')[0];
const normalise = (text: string | undefined) => text?.replace(/\s+/g, ' ');

describe('board wait guidance', () => {
  // One wording of what a wait is for, in every place an agent reads about it (#826, #841).
  it.each([
    ['SKILL.md Turns', read('../spur-board/SKILL.md').split('\n## Turns\n')[1]?.split('\n## ')[0]],
    ['blocks.md', waitSection(read('../spur-board/references/blocks.md'))],
    ['how-board-works-waits.md', read('../spur-board/references/how-board-works-waits.md')],
    ['docs/how-board-works-waits.md', read('../../../docs/how-board-works-waits.md')],
    ['docs/cli.md', waitSection(read('../../../docs/cli.md'))],
  ])('states the wait purpose and its two counter-examples in %s', (_name, text) => {
    const normalised = normalise(text);
    expect(normalised).toContain(
      "Wait only on what the Board cannot see: a busy test stand, no free slot, high machine load, someone else's deploy, an outside service you call.",
    );
    expect(normalised).toContain(
      'Not on your own work (review fixes, tests, checks, rebasing): work holding the turn, so a stall reaches the operator; a wait hides it.',
    );
    expect(normalised).toContain(
      'Not on what the Board watches (CI runs in any state, reviews, approvals, conflicts, merges): submit the head and stop; red checks or other needs bring a new Dev turn.',
    );
    expect(normalised).not.toContain('such as a busy test stand');
    expect(normalised).not.toContain('a condition you cannot change and must re-check');
    expect(normalised).not.toContain('outside condition');
  });

  // A Dev worker submits the pushed head at once; the Board watches CI (#841).
  it.each([
    [
      'SKILL.md Dev worker',
      read('../spur-board/SKILL.md').split('\n- Dev worker:')[1]?.split('\n- ')[0],
    ],
    [
      'worker-flow.md return step',
      read('../spur-board/references/worker-flow.md')
        .split('\n- A return to Dev:')[1]
        ?.split('\n- ')[0],
    ],
  ])('submits right after the push in %s', (_name, text) => {
    expect(normalise(text)).toContain('right after the push, not waiting for CI');
  });

  // What the Board does with pending, red, cancelled and superseded runs after a submit (#841).
  it.each([
    ['how-board-works-waits.md', read('../spur-board/references/how-board-works-waits.md')],
    ['docs/how-board-works-waits.md', read('../../../docs/how-board-works-waits.md')],
  ])('says how checks move the task after a submit in %s', (_name, text) => {
    expect(normalise(text)).toContain(
      "A submit needs no green checks. Running checks hold the task at the `checksGate` column's exit (Dev by default); red checks, a cancelled run included, return it to Dev with a new turn. With `checksGate` right of Dev, a cancelled run counts as running for about two GitHub poll intervals first. Only the latest run of each check counts, so a rerun on the same head replaces a cancelled run. When the PR has required checks, only those count, and the Board does not watch the others.",
    );
  });
});
