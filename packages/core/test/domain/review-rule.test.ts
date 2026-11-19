import type { PrFacts, ReviewRule } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import {
  changesRequested,
  onClock,
  requiredCheckState,
  reviewRuleVerdict,
  ruleDecision,
  storedDecision,
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
    // Another app's e2e run, which GitHub does not mark required, fills no slot.
    name: 'a listed check completed only by a run GitHub does not mark required',
    pr: pr({
      mergeState: 'blocked',
      checks: [
        { name: 'ci', state: 'success', completedAt: AT },
        { name: 'e2e', state: 'success', completedAt: AT },
      ],
    }),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
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
    name: 'no required checks and no checks at all on the head',
    pr: pr({ requiredChecks: [], checks: [] }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'no required checks and an optional check completed',
    pr: pr({
      requiredChecks: [],
      checks: [
        { name: 'lint', state: 'success', completedAt: AT },
        { name: 'docs', state: 'skipped', completedAt: AT },
      ],
    }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'no required checks and an optional check pending',
    pr: pr({
      requiredChecks: [],
      checks: [
        { name: 'lint', state: 'success', completedAt: AT },
        { name: 'e2e', state: 'pending', completedAt: null },
      ],
    }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'no required checks and an optional check failed',
    pr: pr({
      requiredChecks: [],
      checks: [
        { name: 'lint', state: 'success', completedAt: AT },
        { name: 'e2e', state: 'failure', completedAt: AT },
      ],
    }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'no required checks and only skipped checks on the head',
    pr: pr({
      requiredChecks: [],
      checks: [{ name: 'docs', state: 'skipped', completedAt: AT }],
    }),
    rule: { ...PROTECTION, requiredChecks: [] },
    verdict: 'checks_pending',
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
    name: 'blocked while another required check is still running',
    pr: pr({
      mergeState: 'blocked',
      requiredChecks: [
        { name: 'ci', state: 'success', completedAt: AT },
        { name: 'e2e', state: 'pending', completedAt: null },
      ],
    }),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'blocked while a listed required check is absent from the head',
    pr: pr({ mergeState: 'blocked' }),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'behind while a listed required check is absent from the head',
    pr: pr({ mergeState: 'behind' }),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
    verdict: 'checks_pending',
    clock: false,
  },
  {
    name: 'clean while a listed required check is absent from the head: GitHub wins',
    pr: pr(),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
    verdict: 'satisfied',
    clock: false,
  },
  {
    name: 'an unknown merge state while a listed required check is absent: keep, no clock',
    pr: pr({ mergeState: 'unknown' }),
    rule: { ...PROTECTION, requiredChecks: ['ci', 'e2e'] },
    verdict: 'keep',
    clock: false,
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
      const changes = entry.changesRequested ?? false;
      expect(verdict).toBe(entry.verdict);
      expect(
        onClock(
          verdict,
          requiredCheckState(entry.pr, rule),
          storedDecision(verdict, null),
          changes,
        ),
      ).toBe(entry.clock);
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

  it('decides nothing on a rule the token could not read', () => {
    const verdict = (patch: Partial<PrFacts>, changes = false) =>
      reviewRuleVerdict(pr(patch), null, changes, 0);
    for (const mergeState of ['clean', 'blocked', 'behind'] as const)
      expect(verdict({ mergeState })).toBe('unreadable');
    expect(verdict({ requiredChecks: [], checks: [] })).toBe('unreadable');
    expect(verdict({ mergeState: 'unknown' })).toBe('keep');
    expect(verdict({ draft: true, mergeState: 'draft' })).toBe('dev');
    expect(verdict({ requiredChecks: [{ name: 'ci', state: 'pending', completedAt: null }] })).toBe(
      'checks_pending',
    );
    expect(verdict({ mergeState: 'blocked' }, true)).toBe('changes_requested');
    expect(onClock('unreadable', 'done', null, false)).toBe(true);
    expect(ruleDecision('unreadable', 'done', null)).toBe('unreadable');
    expect(storedDecision('unreadable', 'satisfied')).toBeNull();
  });

  it('a stored decision stops the clock; the gate reads a block over a stored satisfied one', () => {
    for (const stored of ['satisfied', 'blocked'] as const) {
      expect(onClock('keep', 'done', stored, false)).toBe(false);
      expect(ruleDecision('keep', 'done', stored)).toBe('undecided');
      expect(ruleDecision('keep', 'pending', stored)).toBe('checks_pending');
      expect(ruleDecision('blocked', 'done', stored)).toBe('blocked');
      expect(ruleDecision('satisfied', 'done', stored)).toBe(stored);
    }
    expect(ruleDecision('blocked', 'done', null)).toBe('undecided');
    expect(ruleDecision('dev', 'done', 'satisfied')).toBe('undecided');
  });
});

describe('requiredCheckState', () => {
  const none: ReviewRule = { ...PROTECTION, requiredChecks: [] };
  const two: ReviewRule = { ...PROTECTION, requiredChecks: ['ci', 'e2e'] };
  const run = (name: string, state: 'success' | 'failure' | 'pending' | 'expected') => ({
    name,
    state,
    completedAt: state === 'pending' || state === 'expected' ? null : AT,
  });
  it.each([
    { name: 'a required check completed', pr: pr(), rule: PROTECTION, state: 'done' },
    {
      name: 'a required check failed',
      pr: pr({ requiredChecks: [run('ci', 'failure')] }),
      rule: PROTECTION,
      state: 'done',
    },
    {
      name: 'the only required check expected',
      pr: pr({ requiredChecks: [run('ci', 'expected')] }),
      rule: none,
      state: 'none',
    },
    {
      name: 'a listed check not marked required',
      pr: pr({ requiredChecks: [] }),
      rule: PROTECTION,
      state: 'none',
    },
    {
      name: 'one completed, another marked required pending',
      pr: pr({ requiredChecks: [run('ci', 'success'), run('e2e', 'pending')] }),
      rule: PROTECTION,
      state: 'pending',
    },
    { name: 'one completed, a listed one absent', pr: pr(), rule: two, state: 'pending' },
    // GitHub marks a run required only from the app the branch requires, which the rule read
    // does not carry: a run of a listed name GitHub does not mark required counts as absent.
    ...[two, { ...two, sources: RULESET.sources }].flatMap((listed) => [
      {
        name: `${listed.sources.join(', ')}: a listed check completed by a run GitHub marks required`,
        pr: pr({
          requiredChecks: [run('ci', 'success'), run('e2e', 'success')],
          checks: [run('ci', 'success'), run('e2e', 'success')],
        }),
        rule: listed,
        state: 'done',
      },
      {
        name: `${listed.sources.join(', ')}: a listed check completed only by a run GitHub does not mark required`,
        pr: pr({ checks: [run('ci', 'success'), run('e2e', 'success')] }),
        rule: listed,
        state: 'pending',
      },
      {
        name: `${listed.sources.join(', ')}: a listed check absent`,
        pr: pr(),
        rule: listed,
        state: 'pending',
      },
      {
        name: `${listed.sources.join(', ')}: the only listed check completed by a run GitHub does not mark required`,
        pr: pr({ requiredChecks: [], checks: [run('e2e', 'success')] }),
        rule: { ...listed, requiredChecks: ['e2e'] },
        state: 'none',
      },
    ]),
    {
      name: 'one completed, a listed one absent, rule unreadable',
      pr: pr(),
      rule: null,
      state: 'done',
    },
    {
      name: 'one completed, a listed one pending in the rollup only',
      pr: pr({ checks: [run('ci', 'success'), run('e2e', 'pending')] }),
      rule: two,
      state: 'pending',
    },
    {
      name: 'none required, an optional check green',
      pr: pr({ requiredChecks: [] }),
      rule: none,
      state: 'done',
    },
    {
      name: 'none required, no checks at all',
      pr: pr({ requiredChecks: [], checks: [] }),
      rule: none,
      state: 'done',
    },
    {
      name: 'none required, an optional check pending',
      pr: pr({ requiredChecks: [], checks: [run('ci', 'pending')] }),
      rule: none,
      state: 'none',
    },
  ] satisfies { name: string; pr: PrFacts; rule: ReviewRule | null; state: string }[])(
    '$name -> $state',
    ({ pr: head, rule, state }) => {
      expect(requiredCheckState(head, rule)).toBe(state);
    },
  );
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

  it("does not count GitHub's verdict while the merge state is unknown; a reviewer's review counts", () => {
    for (const patch of [{ mergeState: 'unknown' }, { mergeable: 'unknown' }] as const) {
      expect(changesRequested(pr(patch), 'changes_requested', 'agent-bot')).toBe(false);
      const reviewed = pr({ ...patch, reviews: [review('reviewer', 'changes_requested')] });
      expect(changesRequested(reviewed, 'review_required', 'agent-bot')).toBe(true);
    }
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
