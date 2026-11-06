const LABEL = 'ci-nightly';
const TITLE = 'Nightly published package smoke failed';
const SUMMARY = 'The published package failed its nightly install smoke.';

export interface NightlyInput {
  repository: string;
  token: string;
  runUrl: string;
  /** The issue title, one per workflow; defaults to the published package smoke title. */
  title?: string | undefined;
  /** The first paragraph of a failure comment or issue body. */
  summary?: string | undefined;
  fetcher?: typeof fetch;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;

function githubClient(input: NightlyInput): Request {
  const fetcher = input.fetcher ?? fetch;
  const base = `https://api.github.com/repos/${input.repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${input.token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return async (path, init) => {
    const response = await fetcher(`${base}${path}`, { ...init, headers });
    if (!response.ok && !(path === `/labels/${LABEL}` && response.status === 404)) {
      throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path}: ${String(response.status)}`);
    }
    return response;
  };
}

/** The open, non-PR `ci-nightly` issue whose title matches exactly. */
async function findOpenIssue(request: Request, title: string): Promise<number | undefined> {
  const issuesResponse = await request(`/issues?state=open&labels=${LABEL}&per_page=100`);
  const issues = (await issuesResponse.json()) as Array<{
    number: number;
    title: string;
    pull_request?: unknown;
  }>;
  return issues.find((issue) => issue.title === title && issue.pull_request === undefined)?.number;
}

/** Keep one open issue per workflow title for failures of a scheduled run. */
export async function reportNightlyFailure(input: NightlyInput): Promise<'created' | 'updated'> {
  const request = githubClient(input);
  const title = input.title ?? TITLE;
  const existing = await findOpenIssue(request, title);
  const body = `${input.summary ?? SUMMARY}\n\nRun: ${input.runUrl}`;
  if (existing !== undefined) {
    await request(`/issues/${String(existing)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return 'updated';
  }

  const labelResponse = await request(`/labels/${LABEL}`);
  if (labelResponse.status === 404) {
    await request('/labels', {
      method: 'POST',
      body: JSON.stringify({
        name: LABEL,
        color: 'b60205',
        description: 'Published package smoke failures',
      }),
    });
  }
  await request('/issues', {
    method: 'POST',
    body: JSON.stringify({ title, body, labels: [LABEL] }),
  });
  return 'created';
}

/** Comment on and close the open issue for this workflow title after a green run. */
export async function closeNightlyIssue(input: NightlyInput): Promise<'closed' | 'none'> {
  const request = githubClient(input);
  const existing = await findOpenIssue(request, input.title ?? TITLE);
  if (existing === undefined) return 'none';
  await request(`/issues/${String(existing)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `A green run closed this issue.\n\nRun: ${input.runUrl}` }),
  });
  await request(`/issues/${String(existing)}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });
  return 'closed';
}

/**
 * The verdict over a workflow's `needs` context: any failed or cancelled (timed-out) job fails,
 * all jobs green passes, anything else (skipped or empty) leaves the issue alone.
 */
export function decideNightly(needs: Record<string, { result: string }>): 'fail' | 'ok' | 'none' {
  const results = Object.values(needs).map((job) => job.result);
  if (results.some((result) => result === 'failure' || result === 'cancelled')) return 'fail';
  if (results.length > 0 && results.every((result) => result === 'success')) return 'ok';
  return 'none';
}

function parseNeeds(text: string | undefined): Record<string, { result: string }> {
  const needs = JSON.parse(text ?? '') as unknown;
  if (typeof needs !== 'object' || needs === null || Array.isArray(needs)) {
    throw new Error('NEEDS is not an object');
  }
  for (const [id, job] of Object.entries(needs)) {
    if (typeof (job as { result?: unknown } | null)?.result !== 'string') {
      throw new Error(`NEEDS.${id} has no result`);
    }
  }
  return needs as Record<string, { result: string }>;
}

async function main(args: string[]): Promise<number> {
  const mode = args[0] ?? 'fail';
  if (mode !== 'fail' && mode !== 'ok' && mode !== 'needs') {
    console.error(`nightly: unknown mode "${mode}"`);
    return 2;
  }
  let verdict: 'fail' | 'ok' | 'none' = mode === 'ok' ? 'ok' : 'fail';
  if (mode === 'needs') {
    try {
      verdict = decideNightly(parseNeeds(process.env['NEEDS']));
    } catch (error) {
      console.error('nightly: invalid NEEDS', error);
      return 1;
    }
    if (verdict === 'none') {
      console.log('nightly: no change, no job failed or all were skipped');
      return 0;
    }
  }

  const repository = process.env['GITHUB_REPOSITORY'];
  const token = process.env['GITHUB_TOKEN'];
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const runId = process.env['GITHUB_RUN_ID'];
  if (!repository || !token || !runId) {
    console.error('nightly: missing GitHub Actions environment');
    return 2;
  }
  const input: NightlyInput = {
    repository,
    token,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    title: process.env['NIGHTLY_TITLE'] || undefined,
    summary: process.env['NIGHTLY_SUMMARY'] || undefined,
  };
  try {
    const outcome =
      verdict === 'ok' ? await closeNightlyIssue(input) : await reportNightlyFailure(input);
    console.log(`nightly: ${outcome} ${LABEL} issue`);
    return 0;
  } catch (error) {
    console.error(`nightly: failed to report ${verdict === 'ok' ? 'success' : 'failure'}`, error);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
