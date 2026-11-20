import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Kept apart from how-board-works.test.ts, which is at the max-lines limit.
describe('how the Board works guide: status fields', () => {
  it('describes approvals in the prSummary paragraph', () => {
    const index = readFileSync(
      new URL('../../../docs/how-board-works.md', import.meta.url),
      'utf8',
    );
    const start = index.indexOf('`prSummary` is an array');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = index.indexOf('\n\n', start);
    const paragraph = index.slice(start, end < 0 ? undefined : end);
    for (const clause of [
      'for gate explanations.',
      'approvals',
      'changedAfter',
      'watchedAfter',
      'approvalWatch',
      'notCounted',
    ])
      expect(paragraph).toContain(clause);
  });
});
