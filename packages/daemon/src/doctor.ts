import { sampleLinkRules } from '@spur-board/adapters';
import { SLACK_BOT_SCOPES, requiredSecretKeys, type Config } from '@spur-board/contracts';
import type { ApiOptions, Store } from '@spur-board/core';
import type { ModuleContext } from './lifecycle.ts';
import { spurErrorText, spurSendRequest } from './spur-port.ts';

type DoctorReport = Awaited<ReturnType<NonNullable<ApiOptions['doctor']>>>;
type Check = DoctorReport['checks'][number];
const TIMEOUT_MS = 5_000;
const SPUR_PROBE_SESSION = 'spur-board-doctor-probe';
const SPUR_SEND_UNREACHABLE_FIX =
  'Start Spur or correct adapters.spur.baseUrl in config.yaml, then restart the service; the daemon sends doorbells to that Spur API.';
const SPUR_SEND_FIX =
  'The Spur API at adapters.spur.baseUrl did not accept a doorbell send; update Spur or point adapters.spur.baseUrl at the Spur daemon.';
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

type Project = Config['projects'][number];
type LinkSample = Awaited<ReturnType<typeof sampleLinkRules>>;
// One project's link-rule finding; `null` sample means the PRs could not be read.
type LinkOutcome =
  | { project: Project; repo: string; polled: false }
  | { project: Project; repo: string; polled: true; sample: LinkSample | null };
// Limit of a check fix in the /v1/doctor report (doctorReportSchema in core's API server).
const FIX_MAX = 300;
const BRANCH_MAX = 40;
const NAMED_PRS = 3;
const LINK_RULES_TAIL = "Change projects[].link to the repo's branch and PR title rules.";
const LINK_RULES_TOKEN_FIX =
  'Add GITHUB_TOKEN to secrets.env, then rerun board doctor to compare projects[].link with recent PRs.';

async function sampleProject(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  token: string,
  project: Project,
  repo: string,
): Promise<LinkSample | null> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(new Error('GitHub link sample timed out'));
      },
      { once: true },
    );
  });
  try {
    return await ctx.logCall('doctor.link_rules', async () => {
      try {
        return await Promise.race([
          sampleLinkRules(
            { repo, login: project.operatorGithubLogin, link: project.link },
            { token, fetch: fetcher, signal: controller.signal },
          ),
          aborted,
        ]);
      } catch {
        throw new Error('GitHub link sample failed');
      }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

function sampleLinks(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  token: string | undefined,
): Promise<LinkOutcome[]> | null {
  const projects = ctx.config.projects.flatMap((project) =>
    project.tracker.type === 'github-issues' ? [{ project, repo: project.tracker.repo }] : [],
  );
  if (projects.length === 0 || token === undefined) return null;
  return Promise.all(
    projects.map(async ({ project, repo }): Promise<LinkOutcome> => {
      const polled = project.repos.some((entry) => entry.toLowerCase() === repo.toLowerCase());
      return polled
        ? { project, repo, polled, sample: await sampleProject(ctx, fetcher, token, project, repo) }
        : { project, repo, polled };
    }),
  );
}

// Branch names are the operator's own; strip what could break the backticks or the terminal.
function branchText(branch: string): string {
  const clean = branch.replace(/[\u0000-\u001f\u007f-\u009f`]/g, '');
  return clean.length > BRANCH_MAX ? `${clean.slice(0, BRANCH_MAX)}...` : clean;
}

interface LinkSegment {
  problem: boolean;
  unmatched: boolean;
  text: (branches: boolean) => string;
}

function linkSegment(outcome: LinkOutcome): LinkSegment {
  const { project, repo } = outcome;
  const fixed = (text: string): LinkSegment => ({
    problem: true,
    unmatched: false,
    text: () => `${project.id}: ${text}`,
  });
  if (!outcome.polled)
    return fixed(`${repo} is not in projects[].repos, so its PRs are not polled`);
  const { sample } = outcome;
  if (sample === null) return fixed(`could not read PRs in ${repo}`);
  if (sample.sampled === 0)
    return fixed(`skipped: no PRs by ${project.operatorGithubLogin} in ${repo}`);
  const count = `${project.id}: link rules match ${String(sample.sampled - sample.unmatched.length)} of the last ${String(sample.sampled)} PRs in ${repo}`;
  if (sample.unmatched.length === 0) return { problem: false, unmatched: false, text: () => count };
  const more = sample.unmatched.length - NAMED_PRS;
  return {
    problem: true,
    unmatched: true,
    text: (branches) =>
      `${count}; not matched: ${sample.unmatched
        .slice(0, NAMED_PRS)
        .map((pr) => `#${String(pr.number)}${branches ? ` \`${branchText(pr.branch)}\`` : ''}`)
        .join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`,
  };
}

// The fix fits FIX_MAX: full text, then without branch names, then the leading projects that
// fit and a count of the rest, then the fallback.
function fitFix(segments: readonly LinkSegment[], tail: string, fallback: string): string {
  for (const branches of [true, false]) {
    const full = `${segments.map((segment) => segment.text(branches)).join('. ')}.${tail}`;
    if (full.length <= FIX_MAX) return full;
  }
  const texts = segments.map((segment) => segment.text(false));
  for (let kept = texts.length - 1; kept > 0; kept -= 1) {
    const text = `${texts.slice(0, kept).join('. ')}; and ${String(texts.length - kept)} more projects.${tail}`;
    if (text.length <= FIX_MAX) return text;
  }
  return fallback;
}

function linkRulesCheck(outcomes: readonly LinkOutcome[] | null, configured: boolean): Check {
  const id = 'link.rules';
  if (!configured) return { id, status: 'pass', blocking: false, fix: null };
  if (outcomes === null) return warning(id, LINK_RULES_TOKEN_FIX);
  const segments = outcomes.map(linkSegment);
  const problems = segments.filter((segment) => segment.problem);
  if (problems.length === 0)
    return {
      id,
      status: 'pass',
      blocking: false,
      fix: fitFix(
        segments,
        '',
        `link rules match every sampled PR in ${String(segments.length)} projects.`,
      ),
    };
  return warning(
    id,
    fitFix(
      problems,
      problems.some((segment) => segment.unmatched) ? ` ${LINK_RULES_TAIL}` : '',
      `link rules miss recent PRs in ${String(problems.length)} projects; change projects[].link to the repo's branch and PR title rules.`,
    ),
  );
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
  // Started first so the link samples run alongside the credential probes.
  const linkSamples = sampleLinks(ctx, fetcher, secrets['GITHUB_TOKEN']);
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
  checks.push(
    linkRulesCheck(
      await linkSamples,
      config.projects.some((project) => project.tracker.type === 'github-issues'),
    ),
  );

  // Same request the doorbell port makes, to a session that never exists, so no agent gets it.
  const probe = spurSendRequest(
    config.adapters.spur.baseUrl,
    SPUR_PROBE_SESSION,
    'spur-board doctor probe',
  );
  const [spur, spurSend] = await Promise.all([
    request(
      ctx,
      fetcher,
      'spur',
      new URL('sessions', `${config.adapters.spur.baseUrl.replace(/\/$/, '')}/`),
    ),
    request(ctx, fetcher, 'spur.send', probe.url, probe.init),
  ]);
  checks.push(check('spur.api', spur?.ok === true, 'Start or correct the configured Spur API.'));
  const spurSendOk =
    spurSend?.status === 404 &&
    ((await spurErrorText(spurSend))?.startsWith('Session not found') ?? false);
  if (spurSend !== null && spurSend.status !== 404)
    await spurSend.body?.cancel().catch(() => undefined);
  checks.push(
    check('spur.send', spurSendOk, spurSend === null ? SPUR_SEND_UNREACHABLE_FIX : SPUR_SEND_FIX),
  );

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
