import { SLACK_BOT_SCOPES, requiredSecretKeys } from '@spur-board/contracts';
import type { ApiOptions, Store } from '@spur-board/core';
import type { ModuleContext } from './lifecycle.ts';

type DoctorReport = Awaited<ReturnType<NonNullable<ApiOptions['doctor']>>>;
type Check = DoctorReport['checks'][number];
const TIMEOUT_MS = 5_000;
const GITHUB_FIX = 'Check the GitHub token and repository access.';
const GITHUB_CHECKS_FIX =
  'Use a classic GitHub personal access token with the repo scope, authorized for organization SSO where required, to read check runs.';
const GITHUB_TEAMS_FIX =
  'Use a classic GitHub personal access token with the repo and read:org scopes to read requested review teams.';
// GitHub normalizes granted scopes: write:org and admin:org include read:org.
const GITHUB_ORG_READ_SCOPES = new Set(['read:org', 'write:org', 'admin:org']);
const GITHUB_PROBE = `query DoctorGithubPermissions($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 10, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name } } } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on Team { name } } } }
      }
    }
    defaultBranchRef { target { ... on Commit {
      statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name } } } }
    } } }
  }
}`;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scopedGithubError(value: unknown): string | null {
  const error = object(value);
  const path = error?.['path'];
  if (!Array.isArray(path)) return null;
  const fields = path.filter((part): part is string => typeof part === 'string');
  if (
    error?.['type'] === 'FORBIDDEN' &&
    fields.includes('statusCheckRollup') &&
    fields.includes('contexts')
  )
    return GITHUB_CHECKS_FIX;
  if (
    error?.['type'] === 'INSUFFICIENT_SCOPES' &&
    fields.includes('reviewRequests') &&
    fields.includes('requestedReviewer') &&
    fields.includes('name')
  )
    return GITHUB_TEAMS_FIX;
  return null;
}

async function githubGraphql(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  token: string,
  repo: string,
): Promise<{ response: Response; body: unknown } | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(new Error('GitHub doctor probe timed out'));
      },
      { once: true },
    );
  });
  try {
    return await ctx.logCall('doctor.github', async () => {
      try {
        return await Promise.race([
          (async () => {
            const response = await fetcher('https://api.github.com/graphql', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ query: GITHUB_PROBE, variables: { owner, repo: name } }),
              signal: controller.signal,
            });
            return { response, body: response.ok ? ((await response.json()) as unknown) : null };
          })(),
          aborted,
        ]);
      } catch {
        throw new Error('GitHub doctor probe failed');
      }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

function check(id: string, ok: boolean, fix: string): Check {
  return { id, status: ok ? 'pass' : 'fail', blocking: !ok, fix: ok ? null : fix };
}

function warning(id: string, fix: string): Check {
  return { id, status: 'warning', blocking: false, fix };
}

async function request(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  id: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    return await ctx.logCall(`doctor.${id}`, () =>
      fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    );
  } catch {
    return null;
  }
}

async function slackOk(response: Response | null): Promise<boolean> {
  if (response === null || !response.ok) return false;
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && 'ok' in value && value.ok === true;
  } catch {
    return false;
  }
}

async function slackMember(response: Response | null): Promise<boolean> {
  if (response === null || !response.ok) return false;
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== 'object' || !('ok' in value) || value.ok !== true)
      return false;
    const channel = 'channel' in value ? value.channel : undefined;
    return (
      channel !== null &&
      typeof channel === 'object' &&
      'is_member' in channel &&
      channel.is_member === true
    );
  } catch {
    return false;
  }
}

/** Bounded daemon-side checks; no response body or exception text leaves this module. */
export async function runDaemonDoctor(
  ctx: ModuleContext<Store>,
  productVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<DoctorReport> {
  const { config, secrets } = ctx;
  const checks: Check[] = [];
  const jiraTrackers = config.projects.flatMap((project) =>
    project.tracker.type === 'jira' ? [project.tracker] : [],
  );
  const slackConfigured = Boolean(
    config.slack.channels.feed || config.slack.channels.orchestrators,
  );
  const required = requiredSecretKeys(config);
  const missing = required.filter((name) => !secrets[name]);
  checks.push(
    check(
      'secrets',
      missing.length === 0,
      `Add ${missing.join(', ')} to the private secrets.env file.`,
    ),
  );

  const jiraEmail = secrets['JIRA_EMAIL'];
  const jiraToken = secrets['JIRA_API_TOKEN'];
  let jiraOk = jiraTrackers.length === 0;
  if (jiraTrackers.length > 0 && jiraEmail && jiraToken) {
    const credentials = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
    const results = await Promise.all(
      jiraTrackers.map(async (tracker) => {
        const url = new URL('/rest/api/3/myself', tracker.baseUrl);
        const response = await request(ctx, fetcher, 'jira', url, {
          headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
        });
        return response?.ok === true;
      }),
    );
    jiraOk = results.every(Boolean);
  }
  checks.push(
    check('jira.credentials', jiraOk, 'Check the Jira account, API token, and project access.'),
  );

  const githubToken = secrets['GITHUB_TOKEN'];
  const githubRepos = new Set(config.projects.flatMap((project) => project.repos));
  const githubFailures =
    githubToken === undefined
      ? [GITHUB_FIX]
      : await Promise.all(
          [...githubRepos].map(async (repo): Promise<string | null> => {
            const response = await request(
              ctx,
              fetcher,
              'github',
              `https://api.github.com/repos/${repo}`,
              {
                headers: {
                  Authorization: `Bearer ${githubToken}`,
                  Accept: 'application/vnd.github+json',
                },
              },
            );
            if (response?.ok !== true) return GITHUB_FIX;
            const probe = await githubGraphql(ctx, fetcher, githubToken, repo);
            if (probe?.response.ok !== true) return GITHUB_FIX;
            const payload = object(probe.body);
            const errors = payload?.['errors'];
            if (errors !== undefined) {
              if (!Array.isArray(errors)) return GITHUB_FIX;
              const scoped = errors.map(scopedGithubError).find((fix) => fix !== null);
              if (scoped) return scoped;
              if (errors.length > 0) return GITHUB_FIX;
            }
            const data = object(payload?.['data']);
            const repository = object(data?.['repository']);
            const pullRequests = object(repository?.['pullRequests']);
            if (!Array.isArray(pullRequests?.['nodes'])) return GITHUB_FIX;
            const scopes = response.headers.get('x-oauth-scopes');
            if (
              scopes !== null &&
              !scopes.split(',').some((scope) => GITHUB_ORG_READ_SCOPES.has(scope.trim()))
            ) {
              return GITHUB_TEAMS_FIX;
            }
            return null;
          }),
        );
  const githubFailure = githubFailures.find((failure) => failure !== null) ?? null;
  checks.push(check('github.credentials', githubFailure === null, githubFailure ?? GITHUB_FIX));

  const spur = await request(
    ctx,
    fetcher,
    'spur',
    new URL('sessions', `${config.adapters.spur.baseUrl.replace(/\/$/, '')}/`),
  );
  checks.push(check('spur.api', spur?.ok === true, 'Start or correct the configured Spur API.'));

  if (!slackConfigured) {
    checks.push(
      warning(
        'slack.configured',
        'Slack is not configured: questions addressed to you are only visible through board inbox. Run the spur-board-setup skill to configure slack.channels.',
      ),
    );
  } else {
    const botToken = secrets['SLACK_BOT_TOKEN'];
    const slackHeaders = botToken ? { Authorization: `Bearer ${botToken}` } : {};
    const slackApi = secrets['SLACK_API_URL'] || 'https://slack.com/api/';
    const slackBase = `${slackApi.replace(/\/$/, '')}/`;
    const auth = botToken
      ? await request(ctx, fetcher, 'slack.auth', new URL('auth.test', slackBase), {
          method: 'POST',
          headers: slackHeaders,
        })
      : null;
    const authorized = await slackOk(auth);
    const granted = new Set(
      auth?.headers
        .get('x-oauth-scopes')
        ?.split(',')
        .map((scope) => scope.trim())
        .filter(Boolean) ?? [],
    );
    const missingScopes = SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope));
    checks.push(
      check(
        'slack.auth',
        authorized && missingScopes.length === 0,
        authorized
          ? `Add ${missingScopes.join(', ')} to the Slack app and reinstall it.`
          : 'Check the Slack bot token.',
      ),
    );
    for (const [id, channel] of [
      ['slack.orchestrators_member', config.slack.channels.orchestrators],
      ['slack.feed_member', config.slack.channels.feed],
    ] as const) {
      const response =
        botToken && channel
          ? await request(
              ctx,
              fetcher,
              id,
              new URL(`conversations.info?channel=${encodeURIComponent(channel)}`, slackBase),
              { headers: slackHeaders },
            )
          : null;
      checks.push(
        check(id, await slackMember(response), 'Invite the bot to the configured channel ID.'),
      );
    }

    const configToken = secrets['SLACK_APP_CONFIG_TOKEN'];
    if (!configToken || !config.slack.appId) {
      checks.push(
        warning(
          'slack.command',
          'Verify the installed Slack slash command against slack.command manually, or provide SLACK_APP_CONFIG_TOKEN and slack.appId.',
        ),
      );
    } else {
      const response = await request(
        ctx,
        fetcher,
        'slack.command',
        new URL('apps.manifest.export', slackBase),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${configToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ app_id: config.slack.appId }),
        },
      );
      let commands: string[] | null = null;
      if (response?.ok) {
        try {
          const body: unknown = await response.json();
          if (body && typeof body === 'object' && 'ok' in body && body.ok === true) {
            const manifest = 'manifest' in body ? body.manifest : undefined;
            const features =
              manifest && typeof manifest === 'object' && 'features' in manifest
                ? manifest.features
                : undefined;
            const slash =
              features && typeof features === 'object' && 'slash_commands' in features
                ? features.slash_commands
                : undefined;
            if (Array.isArray(slash))
              commands = slash.flatMap((entry: unknown) =>
                entry &&
                typeof entry === 'object' &&
                'command' in entry &&
                typeof entry.command === 'string'
                  ? [entry.command]
                  : [],
              );
          }
        } catch {
          // An unreadable manifest is an unknown state, not proof of a mismatch.
        }
      }
      checks.push(
        commands === null
          ? warning(
              'slack.command',
              'Refresh the Slack app configuration token and verify the installed slash command manually.',
            )
          : check(
              'slack.command',
              commands.includes(config.slack.command),
              'Change the installed Slack slash command to match slack.command in config.yaml.',
            ),
      );
    }
  }
  const operatorProject = config.projects.some((project) =>
    project.spurProjects.some((spurProject) => spurProject.role === 'operator'),
  );
  const token = operatorProject
    ? undefined
    : await ctx.store.db
        .selectFrom('operator_token')
        .select('id')
        .where('status', '=', 'approved')
        .executeTakeFirst();
  checks.push(
    check(
      'operator.path',
      operatorProject || token !== undefined,
      'Configure a Spur project with the operator role or approve a named operator token.',
    ),
  );
  return { version: productVersion, checks };
}
