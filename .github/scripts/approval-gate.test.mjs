import test from 'node:test';
import assert from 'node:assert/strict';
import { approval, validateOverride, overrideRunMatches, OWNER, BOT } from './approval-gate.mjs';
const sha = 'a'.repeat(40),
  pr = { number: 340, head: { sha }, user: { login: 'contributor' } };
const review = (login, state = 'APPROVED', commit = sha, id = 1) => ({
  id,
  user: { login },
  state,
  commit_id: commit,
});
test('only current-SHA bot or owner approval allows merge', () => {
  assert.equal(approval(pr, [review(BOT)]), BOT);
  assert.equal(approval(pr, [review(OWNER)]), OWNER);
  assert.equal(approval(pr, [review('stranger')]), null);
  assert.equal(approval(pr, [review(BOT, 'APPROVED', 'b'.repeat(40))]), null);
  assert.equal(approval(pr, [review(BOT), review(BOT, 'DISMISSED', sha, 2)]), null);
  assert.equal(approval(pr, [review(BOT), review(BOT, 'CHANGES_REQUESTED', sha, 2)]), null);
  assert.equal(approval(pr, [review(BOT, 'CHANGES_REQUESTED'), review(OWNER)]), OWNER);
  assert.equal(approval({ ...pr, user: { login: OWNER } }, [review(OWNER)]), null);
});
test('owner override requires own PR, exact SHA, reason and trusted execution', () => {
  const own = { ...pr, user: { login: OWNER } },
    input = { head_sha: sha, reason: 'Reviewer machine unavailable' };
  assert.doesNotThrow(() => validateOverride(own, input, OWNER, OWNER, 'refs/heads/main'));
  for (const args of [
    [pr, input, OWNER, OWNER, 'refs/heads/main'],
    [own, { ...input, head_sha: 'b'.repeat(40) }, OWNER, OWNER, 'refs/heads/main'],
    [own, { ...input, reason: '' }, OWNER, OWNER, 'refs/heads/main'],
    [own, input, 'attacker', OWNER, 'refs/heads/main'],
    [own, input, OWNER, 'attacker', 'refs/heads/main'],
    [own, input, OWNER, OWNER, 'refs/heads/untrusted'],
  ])
    assert.throws(() => validateOverride(...args));
});
test('persisted overrides must come from successful owner dispatch for exact PR and SHA', () => {
  const run = {
    event: 'workflow_dispatch',
    conclusion: 'success',
    head_branch: 'main',
    actor: { login: OWNER },
    triggering_actor: { login: OWNER },
    path: '.github/workflows/review-approval.yml',
    display_title: `Owner override PR #340 SHA ${sha}`,
  };
  assert.ok(overrideRunMatches(run, pr));
  for (const patch of [
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_branch: 'attacker' },
    { actor: { login: 'attacker' } },
    { display_title: `Owner override PR #341 SHA ${sha}` },
  ])
    assert.ok(!overrideRunMatches({ ...run, ...patch }, pr));
});
