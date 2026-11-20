import { describe, expect, it } from 'vitest';
import { batchSchema } from '../src/index.ts';

const sha = 'b'.repeat(40);

function batch(items: unknown[]): Record<string, unknown> {
  return {
    source: 'github',
    observedAt: '2026-11-01T12:00:00Z',
    complete: true,
    items,
    entities: [],
  };
}

const prFacts = {
  repo: 'acme/web',
  number: 42,
  url: 'https://github.com/acme/web/pull/42',
  title: 'PROJ-123 Add the login page',
  author: 'octocat',
  headSha: sha,
  headBranch: 'PROJ-123-login-page',
  state: 'open',
  draft: false,
  mergeable: 'unknown',
  mergeState: 'unknown',
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: ['PROJ-123'],
  updatedAt: '2026-11-01T11:00:00Z',
};

const ticketFacts = {
  trackerId: 'web',
  id: '10042',
  key: 'PROJ-123',
  title: 'Add the login page',
  status: 'To Do',
  assignee: null,
  sprint: null,
  labels: [],
  inFilter: true,
  url: 'https://example.atlassian.net/browse/PROJ-123',
  updatedAt: '2026-11-01T09:00:00Z',
};

describe('batch approvalPairs', () => {
  it('keeps optional approvalPairs on a PR item and rejects a malformed pair', () => {
    const counted = {
      approvedSha: 'a'.repeat(40),
      headSha: sha,
      commitsAfter: 2,
      changed: ['back/', 'package.json'],
    };
    const notCounted = { approvedSha: 'c'.repeat(40), headSha: sha, notCounted: 'rate_limit' };
    const withPairs = (value: unknown): Record<string, unknown> =>
      batch([{ kind: 'pr', facts: prFacts, approvalPairs: value }]);
    expect(batchSchema.parse(withPairs([counted, notCounted])).items[0]).toMatchObject({
      approvalPairs: [counted, notCounted],
    });
    for (const reason of ['history_rewritten', 'rate_limit', 'pr_too_large'])
      expect(
        batchSchema.safeParse(withPairs([{ ...notCounted, notCounted: reason }])).success,
      ).toBe(true);
    expect(batchSchema.parse(batch([{ kind: 'pr', facts: prFacts }])).items[0]).not.toHaveProperty(
      'approvalPairs',
    );
    for (const bad of [
      { ...counted, notCounted: 'rate_limit' },
      { ...counted, changed: ['back/front/'] },
      { ...counted, changed: [''] },
      { ...counted, commitsAfter: -1 },
      { ...counted, approvedSha: 'short' },
      { ...notCounted, notCounted: 'throttled' },
      { approvedSha: counted.approvedSha, headSha: sha },
    ])
      expect(batchSchema.safeParse(withPairs([bad])).success, JSON.stringify(bad)).toBe(false);
    expect(
      batchSchema.safeParse(
        batch([{ kind: 'ticket', facts: ticketFacts, approvalPairs: [counted] }]),
      ).success,
    ).toBe(false);
  });
});
