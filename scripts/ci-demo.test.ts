import { expect, it } from 'vitest';

// Temporary failing test for the PR #74 demo; the next commit reverts it.
it('fails on purpose to show that a failing test turns ci-ok red', () => {
  expect(1).toBe(2);
});
