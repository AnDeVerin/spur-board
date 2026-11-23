import type { PrFacts, ReviewRule } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { awaitedReviewers } from '../../src/domain/review-rule.ts';

const A = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const RULE: ReviewRule = {
  sources: ['ruleset'],
  approvals: 1,
  codeOwners: false,
  conversationResolution: false,
  requiredChecks: [],
};

const REQUESTS: PrFacts['reviewRequests'] = [
  { kind: 'user', id: 'dana', asCodeOwner: false },
  { kind: 'team', id: 'web-owners', asCodeOwner: true },
  { kind: 'bot', id: 'review-bot', asCodeOwner: true },
  { kind: 'user', id: 'owner-a', asCodeOwner: true },
  { reviewer: 'carol', asCodeOwner: true },
];
const NON_OWNER: PrFacts['reviewRequests'] = [{ kind: 'user', id: 'dana', asCodeOwner: false }];

const review = (
  reviewer: string,
  state: PrFacts['reviews'][number]['state'],
  commitSha = A,
): PrFacts['reviews'][number] => ({
  reviewer,
  state,
  commitSha,
  submittedAt: '2026-01-01T00:00:00.000Z',
});
const APPROVED = [review('erin', 'approved')];

const ALL = ['dana', 'web-owners', 'owner-a'];
const OWNERS = ['web-owners', 'owner-a'];

// A request counts only when the reviewer can meet a review requirement GitHub still waits for:
// any user or team while approvals are missing, only a code owner request once they are met.
describe('awaitedReviewers', () => {
  it.each<{
    name: string;
    rule: ReviewRule | null;
    mergeState?: PrFacts['mergeState'];
    reviews?: PrFacts['reviews'];
    requests?: PrFacts['reviewRequests'];
    expected: string[];
  }>([
    { name: 'one approval required and none given', rule: RULE, expected: ALL },
    {
      name: 'two approvals required and one given',
      rule: { ...RULE, approvals: 2 },
      reviews: APPROVED,
      expected: ALL,
    },
    {
      name: 'one approval required and dismissed, commented or changes requested',
      rule: RULE,
      reviews: [
        review('erin', 'dismissed'),
        review('frank', 'commented'),
        review('gail', 'changes_requested'),
      ],
      expected: ALL,
    },
    {
      name: 'one approval required and met, no code owner review',
      rule: RULE,
      reviews: APPROVED,
      expected: [],
    },
    {
      // GitHub keeps an approval on an older commit unless the branch dismisses stale ones.
      name: 'one approval required and met on an older commit',
      rule: RULE,
      reviews: [review('erin', 'approved', OLD)],
      expected: [],
    },
    {
      name: 'one approval met and a code owner review required',
      rule: { ...RULE, codeOwners: true },
      reviews: APPROVED,
      expected: OWNERS,
    },
    {
      // The code owner team the token cannot see is dropped; the courtesy request cannot help.
      name: 'one approval met, a code owner review required and only a non-owner requested',
      rule: { ...RULE, codeOwners: true },
      reviews: APPROVED,
      requests: NON_OWNER,
      expected: [],
    },
    {
      name: 'one approval unmet, a code owner review required and only a non-owner requested',
      rule: { ...RULE, codeOwners: true },
      requests: NON_OWNER,
      expected: ['dana'],
    },
    {
      name: 'a code owner review required without approvals',
      rule: { ...RULE, approvals: null, codeOwners: true },
      expected: OWNERS,
    },
    {
      name: 'a code owner review required without approvals, only a non-owner requested',
      rule: { ...RULE, approvals: null, codeOwners: true },
      requests: NON_OWNER,
      expected: [],
    },
    { name: 'approvals 0 and no code owner review', rule: { ...RULE, approvals: 0 }, expected: [] },
    {
      name: 'no approvals and no code owner review',
      rule: { ...RULE, approvals: null },
      expected: [],
    },
    {
      name: 'only a bot and a request an earlier version stored without a kind',
      rule: { ...RULE, codeOwners: true },
      requests: [
        { kind: 'bot', id: 'review-bot', asCodeOwner: true },
        { reviewer: 'carol', asCodeOwner: true },
      ],
      expected: [],
    },
    { name: 'no rule read', rule: null, expected: [] },
    { name: 'a clean merge', rule: RULE, mergeState: 'clean', expected: [] },
    { name: 'an unknown merge state', rule: RULE, mergeState: 'unknown', expected: [] },
    { name: 'a branch behind its base', rule: RULE, mergeState: 'behind', expected: [] },
  ])('$name waits for $expected', ({ rule, mergeState, reviews, requests, expected }) => {
    expect(
      awaitedReviewers(
        {
          mergeState: mergeState ?? 'blocked',
          reviews: reviews ?? [],
          reviewRequests: requests ?? REQUESTS,
        },
        rule,
      ),
    ).toEqual(expected);
  });
});
