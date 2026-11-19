import type { PrFacts, ReviewRule } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import {
  changesRequested,
  onClock,
  requiredCheckCompleted,
  reviewRuleVerdict,
  type ReviewRuleVerdict,
} from '../../src/domain/review-rule.ts';

const A = 'a'.repeat(40);
const AT = '2026-11-04T08:00:00.000Z';

function pr(patch: Partial<PrFacts> = {}): PrFacts {
  return {
    repo: 'o/r',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'o/r#9 work',
    author: 'agent-bot',
    headSha: A,
    headBranch: 'o/r#9-work',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'clean',
    requiredChecks: [{ name: 'ci', state: 'success', completedAt: AT }],
    checks: [{ name: 'ci', state: 'success', completedAt: AT }],
    reviews: [],
    reviewThreads: [],
    reviewRequests: [],
    ticketKeys: ['o/r#9'],
    updatedAt: AT,
    feedback: [],
    feedbackComplete: true,
    ...patch,
  };
}

const PROTECTION: ReviewRule = {
  sources: ['branch-protection'],
  approvals: 1,
  codeOwners: false,
  conversationResolution: false,
  requiredChecks: ['ci'],
};
const RULESET: ReviewRule = { ...PROTECTION, sources: ['ruleset'] };

interface Case {
  name: string;
  pr: PrFacts;
  rule?: ReviewRule;
  changesRequested?: boolean;
  threads?: number;
  verdict: ReviewRuleVerdict;
  clock: boolean;
}

// One case per rule line of the verdict, in its order.
const CASES: Case[] = [
  {
    name: 'GitHub has not computed the merge state: keep',
    pr: pr({ mergeState: 'unknown' }),
    verdict: 'keep',
    clock: true,
  },
  {
    name: 'GitHub has not computed mergeability: keep',
    pr: pr({ mergeable: 'unknown', mergeState: 'blocked' }),
    verdict: 'keep',
    clock: true,
  },
  {
    name: 'a draft goes to Dev',
    pr: pr({ draft: true, mergeState: 'draft' }),
    verdict: 'dev',
    clock: false,
  },
  {
    name: 'a conflict goes to Dev',
    pr: pr({ mergeable: 'conflicting', mergeState: 'dirty' }),
    verdict: 'dev',
    clock: false,
  },
  {
    name: 'a required check absent from the head',
    pr: pr({ requiredChecks: [], mergeState: 'blocked' }),
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'a required check still pending',
    pr: pr({ requiredChecks: [{ name: 'ci', state: 'pending', completedAt: null }] }),
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'a completed check GitHub does not mark required',
    pr: pr({ requiredChecks: [], checks: [{ name: 'ci', state: 'success', completedAt: AT }] }),
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'changes requested',
    pr: pr({ mergeState: 'blocked' }),
    changesRequested: true,
    verdict: 'changes_requested',
    clock: false,
  },
  { name: 'a clean merge state', pr: pr(), verdict: 'satisfied', clock: false },
  {
    name: 'an unstable merge state',
    pr: pr({ mergeState: 'unstable' }),
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'a merge state with hooks',
    pr: pr({ mergeState: 'has_hooks' }),
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'no required checks on the head or in the rule',
    pr: pr({ requiredChecks: [], checks: [] }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'blocked with an unresolved thread',
    pr: pr({ mergeState: 'blocked' }),
    threads: 1,
    verdict: 'unresolved_threads',
    clock: true,
  },
  {
    name: 'blocked by the code-owner rule',
    pr: pr({ mergeState: 'blocked' }),
    rule: { ...PROTECTION, codeOwners: true },
    verdict: 'blocked',
    clock: false,
  },
  {
    name: 'behind the base branch',
    pr: pr({ mergeState: 'behind' }),
    verdict: 'undecided',
    clock: true,
  },
];

describe('reviewRuleVerdict', () => {
  it.each(CASES)('$name -> $verdict', (entry) => {
    for (const rule of [
      entry.rule ?? PROTECTION,
      { ...(entry.rule ?? PROTECTION), sources: RULESET.sources },
    ]) {
      const verdict = reviewRuleVerdict(
        entry.pr,
        rule,
        entry.changesRequested ?? false,
        entry.threads ?? 0,
      );
      expect(verdict).toBe(entry.verdict);
      expect(onClock(verdict)).toBe(entry.clock);
    }
  });

  it('ruleset-only and merged rules give the branch protection verdicts', () => {
    const both: ReviewRule = { ...PROTECTION, sources: ['branch-protection', 'ruleset'] };
    for (const entry of CASES) {
      const args = [entry.changesRequested ?? false, entry.threads ?? 0] as const;
      const rule = entry.rule ?? PROTECTION;
      const expected = reviewRuleVerdict(entry.pr, rule, ...args);
      expect(reviewRuleVerdict(entry.pr, { ...rule, sources: ['ruleset'] }, ...args)).toBe(
        expected,
      );
      expect(reviewRuleVerdict(entry.pr, { ...rule, sources: both.sources }, ...args)).toBe(
        expected,
      );
    }
  });

  it('keep runs the clock, a verdict with its own owner does not', () => {
    expect(onClock('keep')).toBe(true);
    for (const verdict of [
      'dev',
      'checks_pending',
      'changes_requested',
      'satisfied',
      'blocked',
    ] as const)
      expect(onClock(verdict)).toBe(false);
  });
});

describe('requiredCheckCompleted', () => {
  it('counts only checks GitHub marks required, and is met without any only when no source lists one', () => {
    const none: ReviewRule = { ...PROTECTION, requiredChecks: [] };
    expect(requiredCheckCompleted(pr(), PROTECTION)).toBe(true);
    expect(
      requiredCheckCompleted(
        pr({ requiredChecks: [{ name: 'ci', state: 'failure', completedAt: AT }] }),
        PROTECTION,
      ),
    ).toBe(true);
    expect(
      requiredCheckCompleted(
        pr({ requiredChecks: [{ name: 'ci', state: 'expected', completedAt: null }] }),
        none,
      ),
    ).toBe(false);
    expect(requiredCheckCompleted(pr({ requiredChecks: [] }), PROTECTION)).toBe(false);
    expect(requiredCheckCompleted(pr({ requiredChecks: [] }), none)).toBe(true);
  });
});

describe('changesRequested', () => {
  const review = (reviewer: string, state: 'approved' | 'changes_requested') => ({
    reviewer,
    state,
    commitSha: A,
    submittedAt: AT,
  });

  it("reads GitHub's verdict or an external reviewer's latest review", () => {
    expect(changesRequested(pr(), 'changes_requested', 'agent-bot')).toBe(true);
    expect(changesRequested(pr(), 'review_required', 'agent-bot')).toBe(false);
    expect(changesRequested(pr(), null, 'agent-bot')).toBe(false);
  });

  it('keeps a changes request after the reviewer is asked again', () => {
    const rerequested = pr({
      reviews: [review('reviewer', 'changes_requested')],
      reviewRequests: [{ kind: 'user', id: 'reviewer', asCodeOwner: false }],
    });
    expect(changesRequested(rerequested, 'review_required', 'agent-bot')).toBe(true);
  });

  it("ignores the agents' own login and bot reviews, which only GitHub's verdict counts", () => {
    const bot = pr({
      reviews: [
        review('agent-bot', 'changes_requested'),
        review('review-app', 'changes_requested'),
      ],
      feedback: [
        {
          kind: 'review',
          id: 'r-app',
          author: { login: 'review-app', type: 'bot' },
          postedAt: AT,
        },
      ],
    });
    expect(changesRequested(bot, 'approved', 'agent-bot')).toBe(false);
    expect(changesRequested(bot, 'changes_requested', 'agent-bot')).toBe(true);
  });
});
