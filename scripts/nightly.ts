const LABEL = 'ci-nightly';
const TITLE = 'Nightly published package smoke failed';

export interface NightlyInput {
  repository: string;
  token: string;
  runUrl: string;
  fetcher?: typeof fetch;
}

/** Keep one open issue for failures of the installed, published package. */
export async function reportNightlyFailure(input: NightlyInput): Promise<'created' | 'updated'> {
  const fetcher = input.fetcher ?? fetch;
  const base = `https://api.github.com/repos/${input.repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${input.token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetcher(`${base}${path}`, { ...init, headers });
    if (!response.ok && !(path === `/labels/${LABEL}` && response.status === 404)) {
      throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path}: ${String(response.status)}`);
    }
    return response;
  };

  const issuesResponse = await request(`/issues?state=open&labels=${LABEL}&per_page=100`);
  const issues = (await issuesResponse.json()) as Array<{
    number: number;
    title: string;
    pull_request?: unknown;
  }>;
  const existing = issues.find(
    (issue) => issue.title === TITLE && issue.pull_request === undefined,
  );
  const body = `The published package failed its nightly install smoke.\n\nRun: ${input.runUrl}`;
  if (existing) {
    await request(`/issues/${String(existing.number)}/comments`, {
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
    body: JSON.stringify({ title: TITLE, body, labels: [LABEL] }),
  });
  return 'created';
}

if (import.meta.main) {
  const repository = process.env['GITHUB_REPOSITORY'];
  const token = process.env['GITHUB_TOKEN'];
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const runId = process.env['GITHUB_RUN_ID'];
  if (!repository || !token || !runId) {
    console.error('nightly: missing GitHub Actions environment');
    process.exitCode = 2;
  } else {
    try {
      const outcome = await reportNightlyFailure({
        repository,
        token,
        runUrl: `${server}/${repository}/actions/runs/${runId}`,
      });
      console.log(`nightly: ${outcome} ${LABEL} issue`);
    } catch (error) {
      console.error('nightly: failed to report failure', error);
      process.exitCode = 1;
    }
  }
}
