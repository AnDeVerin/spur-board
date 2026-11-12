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

import { main } from './approval-gate.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function exercise({
  reviews = [],
  inputs = { mode: 'evaluate', pr_number: '340' },
  actor = OWNER,
  own = false,
  changed = false,
  closed = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'approval-gate-'));
  const requests = [];
  let reads = 0;
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ inputs }));
  const env = {
    GITHUB_EVENT_PATH: event,
    GITHUB_REPOSITORY: 'AnDeVerin/spur-board',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: actor,
    GITHUB_TRIGGERING_ACTOR: actor,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GH_TOKEN: 'test-only',
  };
  const fetchFn = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body, method: options.method });
    let data;
    if (path.endsWith('/pulls/340'))
      data = {
        ...pr,
        state: closed ? 'closed' : 'open',
        base: { ref: 'main' },
        draft: false,
        user: { login: own ? OWNER : 'contributor' },
        head: { sha: changed && reads++ > 0 ? 'b'.repeat(40) : sha },
      };
    else if (path.endsWith('/reviews')) data = reviews;
    else if (path.endsWith('/runs')) data = { workflow_runs: [] };
    else if (path.includes('/statuses/') || path.endsWith('/dismissals')) data = {};
    else throw Error(`Unexpected fake route ${path}`);
    return { ok: true, status: 200, json: async () => data };
  };
  let error;
  try {
    await main(env, fetchFn);
  } catch (e) {
    error = e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    requests,
    error,
    statuses: requests.filter((r) => r.path.includes('/statuses/')).map((r) => r.body.state),
  };
}
test('evaluator publishes pending then success only for an approved current head', async () => {
  const yes = await exercise({ reviews: [review(BOT)] });
  assert.equal(yes.error, undefined);
  assert.deepEqual(yes.statuses, ['pending', 'success']);
  const no = await exercise();
  assert.deepEqual(no.statuses, ['pending', 'failure']);
});
test('owner fallback dismisses only bot change requests before success', async () => {
  const r = await exercise({
    reviews: [
      review(BOT, 'CHANGES_REQUESTED', sha, 1),
      review('someone', 'CHANGES_REQUESTED', sha, 2),
      review(OWNER, 'APPROVED', sha, 3),
    ],
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(
    r.requests.filter((r) => r.path.endsWith('/dismissals')).map((r) => r.path),
    ['/repos/AnDeVerin/spur-board/pulls/340/reviews/1/dismissals'],
  );
  assert.equal(r.statuses.at(-1), 'success');
});
test('invalid or raced override cannot produce a successful audit run', async () => {
  const inputs = {
    mode: 'override',
    pr_number: '340',
    head_sha: sha,
    reason: 'Local bot unavailable for verification',
  };
  for (const options of [{ actor: 'attacker' }, { changed: true }, { closed: true }]) {
    const r = await exercise({ own: true, inputs, ...options });
    assert.ok(r.error);
    assert.ok(!r.statuses.includes('success'));
  }
  const ok = await exercise({ own: true, inputs });
  assert.equal(ok.error, undefined);
  assert.equal(ok.statuses.at(-1), 'success');
});
