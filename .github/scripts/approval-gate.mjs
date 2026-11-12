import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const OWNER = 'AnDeVerin';
export const BOT = 'adv-board-reviewer[bot]';
export const CONTEXT = 'Review approval';
export const WORKFLOW = 'review-approval.yml';
export function approval(pr, reviews) {
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
      latest.set(r.user.login, r);
  }
  for (const login of [OWNER, BOT]) {
    const r = latest.get(login);
    if (r?.state === 'APPROVED' && r.commit_id === pr.head.sha && login !== pr.user.login)
      return login;
  }
  return null;
}
export function validateOverride(pr, inputs, actor, triggeringActor, ref) {
  if (actor !== OWNER || triggeringActor !== OWNER || ref !== 'refs/heads/main')
    throw Error('Only the owner may override from main');
  if (pr.user.login !== OWNER)
    throw Error('Override is only for PRs authored by the owner; approve other PRs normally');
  if (inputs.head_sha !== pr.head.sha || !/^[a-f0-9]{40}$/.test(inputs.head_sha))
    throw Error('Override SHA must match current PR head');
  if (!inputs.reason?.trim() || inputs.reason.trim().length < 10)
    throw Error('Provide an override reason of at least 10 characters');
}
export function overrideRunMatches(run, pr) {
  return (
    run.event === 'workflow_dispatch' &&
    run.conclusion === 'success' &&
    run.head_branch === 'main' &&
    run.actor?.login === OWNER &&
    run.triggering_actor?.login === OWNER &&
    run.path === `.github/workflows/${WORKFLOW}` &&
    run.display_title === `Owner override PR #${pr.number} SHA ${pr.head.sha}`
  );
}
export async function main(env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = env.GITHUB_REPOSITORY;
  if (repo !== 'AnDeVerin/spur-board') throw Error('Unexpected repository');
  const root = `/repos/${repo}`;
  async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error(`${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function pages(path, key) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = key ? data[key] : data;
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw Error('Pagination limit exceeded');
  }
  const inputs = event.inputs || {};
  let numbers = [];
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') numbers = [Number(inputs.pr_number)];
  else if (env.GITHUB_EVENT_NAME === 'pull_request_target') numbers = [event.pull_request.number];
  else if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event.workflow_run;
    if (run.event !== 'pull_request_review') return;
    numbers = run.pull_requests.map((p) => p.number);
    // Fork review runs can omit pull_requests; API lookup is event-driven, not polling.
    if (!numbers.length)
      numbers = (await pages(`${root}/commits/${run.head_sha}/pulls`)).map((p) => p.number);
  } else throw Error('Unsupported event');
  for (const number of new Set(numbers)) {
    if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid PR number');
    let pr = await api(`${root}/pulls/${number}`);
    if (pr.state !== 'open' || pr.base.ref !== 'main') {
      if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && inputs.mode === 'override') {
        throw Error('Override requires an open PR targeting main');
      }
      continue;
    }
    const sha = pr.head.sha;
    const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
    const status = (state, description) =>
      api(`${root}/statuses/${sha}`, 'POST', {
        state,
        context: CONTEXT,
        description,
        target_url: runUrl,
      });
    await status('pending', 'Checking current-SHA review approvals');
    try {
      const reviews = await pages(`${root}/pulls/${number}/reviews`);
      let approvedBy = pr.draft ? null : approval(pr, reviews);
      let override = null;
      if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && inputs.mode === 'override') {
        if (pr.draft) throw Error('Draft PR cannot be overridden');
        validateOverride(pr, inputs, env.GITHUB_ACTOR, env.GITHUB_TRIGGERING_ACTOR, env.GITHUB_REF);
        override = runUrl;
        appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `Owner override for PR #${number}\n\nSHA: ${sha}\n\nReason:\n\n${inputs.reason.trim()}\n`,
        );
      } else if (!pr.draft && pr.user.login === OWNER) {
        const runs = await pages(
          `${root}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&actor=${OWNER}`,
          'workflow_runs',
        );
        override = runs.find((r) => overrideRunMatches(r, pr))?.html_url;
      }
      if (approvedBy === OWNER || override) {
        for (const r of reviews.filter(
          (r) => r.user.login === BOT && r.state === 'CHANGES_REQUESTED',
        )) {
          await api(`${root}/pulls/${number}/reviews/${r.id}/dismissals`, 'PUT', {
            message: `Superseded by explicit owner approval/override for ${sha}. ${override || runUrl}`,
          });
        }
      }
      pr = await api(`${root}/pulls/${number}`);
      if (pr.head.sha !== sha || pr.state !== 'open' || pr.draft) {
        await status('failure', 'PR changed during evaluation; re-evaluation required');
        if (override === runUrl) throw Error('PR changed before override completed');
        continue;
      }
      const allowed = Boolean(approvedBy || override);
      await status(
        allowed ? 'success' : 'failure',
        override
          ? 'Explicit owner override for this SHA'
          : approvedBy
            ? `Current-SHA approval by ${approvedBy}`
            : 'Waiting for bot or owner approval on current SHA',
      );
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `\nPR #${number}: ${allowed ? 'allowed' : 'blocked'} at ${sha}. ${override || approvedBy || 'No valid approval.'}\n`,
      );
    } catch (e) {
      await status('error', 'Approval evaluation failed; merge remains blocked');
      throw e;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
