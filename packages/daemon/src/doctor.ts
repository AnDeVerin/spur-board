import type { ApiOptions, Store } from '@spur-board/core';
import type { ModuleContext } from './lifecycle.ts';

type DoctorReport = Awaited<ReturnType<NonNullable<ApiOptions['doctor']>>>;
type Check = DoctorReport['checks'][number];
const TIMEOUT_MS = 5_000;

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
  const jira = config.projects.filter((project) => project.tracker.type === 'jira');
  const required = [
    'GITHUB_TOKEN',
    ...(jira.length > 0 ? ['JIRA_EMAIL', 'JIRA_API_TOKEN'] : []),
    ...(config.slack.channels.feed || config.slack.channels.orchestrators
      ? ['SLACK_BOT_TOKEN']
      : []),
  ];
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
  const jiraOk =
    jira.length === 0 ||
    (Boolean(jiraEmail && jiraToken) &&
      (
        await Promise.all(
          jira.map(async (project) => {
            if (project.tracker.type !== 'jira') return true;
            const credentials = Buffer.from(`${jiraEmail ?? ''}:${jiraToken ?? ''}`).toString(
              'base64',
            );
            const url = new URL('/rest/api/3/myself', project.tracker.baseUrl);
            const response = await request(ctx, fetcher, 'jira', url, {
              headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
            });
            return response?.ok === true;
          }),
        )
      ).every(Boolean));
  checks.push(
    check('jira.credentials', jiraOk, 'Check the Jira account, API token, and project access.'),
  );

  const githubToken = secrets['GITHUB_TOKEN'];
  const githubRepos = new Set(config.projects.flatMap((project) => project.repos));
  const githubOk =
    githubToken !== undefined &&
    (
      await Promise.all(
        [...githubRepos].map(async (repo) => {
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
          return response?.ok === true;
        }),
      )
    ).every(Boolean);
  checks.push(
    check('github.credentials', githubOk, 'Check the GitHub token and repository access.'),
  );

  const spur = await request(
    ctx,
    fetcher,
    'spur',
    new URL('sessions', `${config.adapters.spur.baseUrl.replace(/\/$/, '')}/`),
  );
  checks.push(check('spur.api', spur?.ok === true, 'Start or correct the configured Spur API.'));

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
  checks.push(check('slack.auth', await slackOk(auth), 'Check the Slack bot token.'));
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
      new URL(`apps.manifest.export?app_id=${encodeURIComponent(config.slack.appId)}`, slackBase),
      { headers: { Authorization: `Bearer ${configToken}` } },
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
