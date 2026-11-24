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
      // Another approval from the reviewer whose approval counts still counts as one.
      name: 'two approvals required and one given, only its reviewer re-requested',
      rule: { ...RULE, approvals: 2 },
      reviews: APPROVED,
      requests: [{ kind: 'user', id: 'erin', asCodeOwner: false }],
      expected: [],
    },
    {
      name: 'two approvals required and one given, its reviewer in another case re-requested',
      rule: { ...RULE, approvals: 2 },
      reviews: APPROVED,
      requests: [{ kind: 'user', id: 'Erin', asCodeOwner: false }],
      expected: [],
    },
    {
      name: 'two approvals required and one given, its reviewer and another user requested',
      rule: { ...RULE, approvals: 2 },
      reviews: APPROVED,
      requests: [
        { kind: 'user', id: 'erin', asCodeOwner: false },
        { kind: 'user', id: 'yuri', asCodeOwner: false },
      ],
      expected: ['yuri'],
    },
    {
      // A team request names no login an approval could already come from.
      name: 'two approvals required and one given, its reviewer and a team requested',
      rule: { ...RULE, approvals: 2 },
      reviews: APPROVED,
      requests: [
        { kind: 'user', id: 'erin', asCodeOwner: false },
        { kind: 'team', id: 'web-owners', asCodeOwner: false },
      ],
      expected: ['web-owners'],
    },
    {
      // The owner's approval already serves the code owner review.
      name: 'one approval met by a code owner re-requested as code owner',
      rule: { ...RULE, codeOwners: true },
      reviews: [review('owner-a', 'approved')],
      requests: [{ kind: 'user', id: 'owner-a', asCodeOwner: true }],
      expected: [],
    },
    {
      // GitHub reads a stale approval it dismissed as dismissed, so that reviewer still counts.
      name: 'one approval required, a dismissed reviewer re-requested',
      rule: RULE,
      reviews: [review('erin', 'dismissed')],
      requests: [{ kind: 'user', id: 'erin', asCodeOwner: false }],
      expected: ['erin'],
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
