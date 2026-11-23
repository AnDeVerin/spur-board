import type { PrFacts, ReviewRule } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { awaitedReviewers } from '../../src/domain/review-rule.ts';

type Requests = PrFacts['reviewRequests'];

const RULE: ReviewRule = {
  sources: ['ruleset'],
  approvals: 1,
  codeOwners: false,
  conversationResolution: false,
  requiredChecks: [],
};

const REQUESTS: Requests = [
  { kind: 'user', id: 'dana', asCodeOwner: false },
  { kind: 'team', id: 'web-owners', asCodeOwner: true },
  { kind: 'bot', id: 'review-bot', asCodeOwner: true },
  { kind: 'user', id: 'owner-a', asCodeOwner: true },
  { reviewer: 'carol', asCodeOwner: true },
];

const read = (mergeState: PrFacts['mergeState'], reviewRequests: Requests = REQUESTS) => ({
  mergeState,
  reviewRequests,
});

describe('awaitedReviewers', () => {
  it.each([
    ['approvals 1', RULE, ['dana', 'web-owners', 'owner-a']],
    [
      'code owners without approvals',
      { ...RULE, approvals: null, codeOwners: true },
      ['dana', 'web-owners', 'owner-a'],
    ],
    ['approvals 0', { ...RULE, approvals: 0 }, []],
    ['no approvals and no code owners', { ...RULE, approvals: null }, []],
  ])(
    'a blocked PR under %s waits for the users and teams it counts, in request order',
    (_, rule, expected) => {
      expect(awaitedReviewers(read('blocked'), rule)).toEqual(expected);
    },
  );

  it('never counts a bot or a request an earlier version stored without a kind', () => {
    const rule = { ...RULE, codeOwners: true };
    expect(
      awaitedReviewers(
        read('blocked', [
          { kind: 'bot', id: 'review-bot', asCodeOwner: true },
          { reviewer: 'carol', asCodeOwner: true },
        ]),
        rule,
      ),
    ).toEqual([]);
  });

  it('waits for nobody without a rule', () => {
    expect(awaitedReviewers(read('blocked'), null)).toEqual([]);
  });

  it.each(['clean', 'unknown', 'behind'] as const)(
    'waits for nobody while the merge state reads %s',
    (mergeState) => {
      expect(awaitedReviewers(read(mergeState), RULE)).toEqual([]);
    },
  );
});
