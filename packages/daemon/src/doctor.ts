import {
  checkAccessDenied,
  classifyHttpFailure,
  graphEnvelopeWire,
  graphqlFailure,
  sampleLinkRules,
  teamScopeDenied,
} from '@spur-board/adapters';
import {
  DOCTOR_FIX_MAX,
  SLACK_BOT_SCOPES,
  apiBaseUrl,
  requiredSecretKeys,
  type AdapterError,
  type Config,
  type DoctorCheck as Check,
  type DoctorReport,
} from '@spur-board/contracts';
import { curatorSessions, tokenAttention, tokenAttentionLine, type Store } from '@spur-board/core';
import { lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModuleContext } from './lifecycle.ts';
import { spurErrorText, spurSendRequest } from './spur-port.ts';

const DEADLINE_MS = 5_000;
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
const GITHUB_THROTTLED_FIX =
  'GitHub is rate limiting this token, so access was not checked; rerun board doctor after the limit resets.';
// GitHub normalizes granted scopes: write:org and admin:org include read:org.
const GITHUB_ORG_READ_SCOPES = new Set(['read:org', 'write:org', 'admin:org']);
const GITHUB_PROBE = `query DoctorGithubPermissions($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 10, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name } } } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on Team { slug } } } }
      }
    }
    defaultBranchRef { target { ... on Commit {
      statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name } } } }
    } } }
  }
}`;

// Runs `call` under logCall with a `deadlineMs` deadline that also aborts its signal; any failure
// is logged as `failure`, so no vendor text reaches the log, and returns null.
async function deadlineCall<T>(
  ctx: ModuleContext<Store>,
  deadlineMs: number,
  name: string,
  failure: string,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, deadlineMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(new Error(`${failure}: timed out`));
      },
      { once: true },
    );
  });
  try {
    return await ctx.logCall(name, async () => {
      try {
        return await Promise.race([call(controller.signal), aborted]);
      } catch {
        throw new Error(failure);
      }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

// A GitHub probe's response; `failure` classifies a failed one, whose body is read only for the
// adapter's rate-limit rule and never leaves this module.
interface GithubReply {
  response: Response;
  failure: AdapterError | null;
  body: unknown;
}

// Sends one GitHub probe and reads its body inside the doctor deadline, so a stalled body ends
// there too; an unreadable failed body counts as none.
function githubCall(
  ctx: ModuleContext<Store>,
  deadlineMs: number,
  send: (signal: AbortSignal) => Promise<Response>,
  json: boolean,
): Promise<GithubReply | null> {
  return deadlineCall(
    ctx,
    deadlineMs,
    'doctor.github',
    'GitHub doctor probe failed',
    async (signal) => {
      const response = await send(signal);
      if (response.ok)
        return {
          response,
          failure: null,
          body: json ? ((await response.json()) as unknown) : null,
        };
      const body = await response.text().catch(() => undefined);
      const failure = classifyHttpFailure(
        { status: response.status, headers: response.headers, body },
        ctx.clock.now(),
      );
      return { response, failure, body: null };
    },
  );
}

function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}

function githubGraphql(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  deadlineMs: number,
  token: string,
  repo: string,
): Promise<GithubReply | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return Promise.resolve(null);
  return githubCall(
    ctx,
    deadlineMs,
    (signal) =>
      fetcher('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GITHUB_PROBE, variables: { owner, repo: name } }),
        signal,
      }),
    true,
  );
}

// A repo's GitHub finding: null passes; a throttled token is a warning, its access unchecked.
type GithubFinding = { status: 'fail' | 'warning'; fix: string } | null;
const githubFail = (fix: string): GithubFinding => ({ status: 'fail', fix });
const githubHttpFinding = (failure: AdapterError): GithubFinding =>
  failure.kind === 'throttled'
    ? { status: 'warning', fix: GITHUB_THROTTLED_FIX }
    : githubFail(GITHUB_FIX);
const githubDataWire = z.object({
  repository: z.object({ pullRequests: z.object({ nodes: z.array(z.unknown()) }) }),
});

// Classifies one repo with the adapter's HTTP and GraphQL rules, then the doctor's scope header.
async function githubRepoFinding(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  deadlineMs: number,
  token: string,
  repo: string,
): Promise<GithubFinding> {
  const rest = await githubCall(
    ctx,
    deadlineMs,
    (signal) =>
      fetcher(`https://api.github.com/repos/${repo}`, { headers: githubHeaders(token), signal }),
    false,
  );
  if (rest === null) return githubFail(GITHUB_FIX);
  if (rest.failure !== null) return githubHttpFinding(rest.failure);
  const probe = await githubGraphql(ctx, fetcher, deadlineMs, token, repo);
  if (probe === null) return githubFail(GITHUB_FIX);
  if (probe.failure !== null) return githubHttpFinding(probe.failure);
  const envelope = graphEnvelopeWire.safeParse(probe.body);
  if (!envelope.success) return githubFail(GITHUB_FIX);
  const errors = envelope.data.errors ?? [];
  const failure = graphqlFailure(errors, GITHUB_PROBE, probe.response.headers, ctx.clock.now());
  if (failure?.kind === 'throttled') return githubHttpFinding(failure);
  if (failure !== null)
    return githubFail(
      errors.some((error) => teamScopeDenied(error, GITHUB_PROBE)) ? GITHUB_TEAMS_FIX : GITHUB_FIX,
    );
  if (checkAccessDenied(errors)) return githubFail(GITHUB_CHECKS_FIX);
  if (errors.length > 0) return githubFail(GITHUB_FIX);
  if (!githubDataWire.safeParse(envelope.data.data).success) return githubFail(GITHUB_FIX);
  const scopes = rest.response.headers.get('x-oauth-scopes');
  if (
    scopes !== null &&
    !scopes.split(',').some((scope) => GITHUB_ORG_READ_SCOPES.has(scope.trim()))
  )
    return githubFail(GITHUB_TEAMS_FIX);
  return null;
}

// Any failing repo fails the check; otherwise a throttled repo makes it a warning.
function githubCheck(findings: readonly GithubFinding[]): Check {
  const id = 'github.credentials';
  const failed = findings.find((finding) => finding?.status === 'fail');
  if (failed) return check(id, false, failed.fix);
  const throttled = findings.find((finding) => finding?.status === 'warning');
  return throttled ? warning(id, throttled.fix) : check(id, true, GITHUB_FIX);
}

type Project = Config['projects'][number];
type LinkSample = Awaited<ReturnType<typeof sampleLinkRules>>;
// One project's link-rule finding; `null` sample means the PRs could not be read.
type LinkOutcome =
  | { project: Project; repo: string; polled: false }
  | { project: Project; repo: string; polled: true; sample: LinkSample | null };
const BRANCH_MAX = 40;
const NAMED_PRS = 3;
const LINK_RULES_TAIL = "Change projects[].link to the repo's branch and PR title rules.";
const LINK_RULES_TOKEN_FIX =
  'Add GITHUB_TOKEN to secrets.env, then rerun board doctor to compare projects[].link with recent PRs.';

function sampleProject(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  deadlineMs: number,
  token: string,
  project: Project,
  repo: string,
): Promise<LinkSample | null> {
  return deadlineCall(ctx, deadlineMs, 'doctor.link_rules', 'GitHub link sample failed', (signal) =>
    sampleLinkRules(
      { repo, login: project.operatorGithubLogin, tracker: project.tracker, link: project.link },
      { token, now: () => ctx.clock.now(), fetch: fetcher, signal },
    ),
  );
}

function sampleLinks(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  deadlineMs: number,
  token: string | undefined,
): Promise<LinkOutcome[]> | null {
  // A github-issues project links PRs in tracker.repo; a Jira project in every repos entry.
  const projects = ctx.config.projects.flatMap((project) =>
    project.tracker.type === 'github-issues'
      ? [{ project, repo: project.tracker.repo }]
      : project.repos.map((repo) => ({ project, repo })),
  );
  if (token === undefined) return null;
  return Promise.all(
    projects.map(async ({ project, repo }): Promise<LinkOutcome> => {
      const polled = project.repos.some((entry) => entry.toLowerCase() === repo.toLowerCase());
      return polled
        ? {
            project,
            repo,
            polled,
            sample: await sampleProject(ctx, fetcher, deadlineMs, token, project, repo),
          }
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

// The fix fits DOCTOR_FIX_MAX: full text, then without branch names, then the leading projects that
// fit and a count of the rest, then the fallback.
function fitFix(segments: readonly LinkSegment[], tail: string, fallback: string): string {
  for (const branches of [true, false]) {
    const full = `${segments.map((segment) => segment.text(branches)).join('. ')}.${tail}`;
    if (full.length <= DOCTOR_FIX_MAX) return full;
  }
  const texts = segments.map((segment) => segment.text(false));
  for (let kept = texts.length - 1; kept > 0; kept -= 1) {
    const text = `${texts.slice(0, kept).join('. ')}; and ${String(texts.length - kept)} more projects.${tail}`;
    if (text.length <= DOCTOR_FIX_MAX) return text;
  }
  return fallback;
}

function linkRulesCheck(outcomes: readonly LinkOutcome[] | null): Check {
  const id = 'link.rules';
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

const CURATOR_TAIL = 'Start a Spur session of each curator with no live session.';

// Projects whose curator has no live session come first; never blocking.
function curatorSessionsCheck(entries: Awaited<ReturnType<typeof curatorSessions>>): Check {
  const id = 'curator.sessions';
  const segment = (text: string, problem: boolean): LinkSegment => ({
    problem,
    unmatched: false,
    text: () => text,
  });
  const segments = entries.map(({ project, curator, session }) =>
    curator === null
      ? segment(`${project}: no curator configured`, false)
      : session === null
        ? segment(`${project}: curator ${curator}, no live session`, true)
        : segment(`${project}: curator ${curator}, session ${session}`, false),
  );
  const missing = segments.filter((entry) => entry.problem).length;
  if (missing === 0)
    return {
      id,
      status: 'pass',
      blocking: false,
      fix: fitFix(
        segments,
        '',
        `Every configured curator has a live session in ${String(segments.length)} projects.`,
      ),
    };
  return warning(
    id,
    fitFix(
      [...segments.filter((entry) => entry.problem), ...segments.filter((entry) => !entry.problem)],
      ` ${CURATOR_TAIL}`,
      `${String(missing)} curators have no live session. Start a Spur session of each.`,
    ),
  );
}

function check(id: string, ok: boolean, fix: string): Check {
  return { id, status: ok ? 'pass' : 'fail', blocking: !ok, fix: ok ? null : fix };
}

function warning(id: string, fix: string): Check {
  return { id, status: 'warning', blocking: false, fix };
}

/**
 * Whether a token's folder on this host still holds `.spur-board/token` as a regular file. Null
 * for a token of another host, or when the folder cannot be read for another reason.
 */
async function tokenFilePresent(token: { folder: string; host: string }): Promise<boolean | null> {
  if (token.host !== hostname()) return null;
  try {
    return (await lstat(join(token.folder, '.spur-board', 'token'))).isFile();
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

async function operatorTokensCheck(ctx: ModuleContext<Store>, config: Config): Promise<Check> {
  const days = config.operatorAccess.unusedAfterDays;
  const attention = await tokenAttention(
    ctx.store,
    new Date(ctx.clock.now()),
    days,
    tokenFilePresent,
  );
  const line = tokenAttentionLine(attention, days);
  return line === null
    ? { id: 'operator.tokens', status: 'pass', blocking: false, fix: null }
    : warning('operator.tokens', line);
}

async function request(
  ctx: ModuleContext<Store>,
  fetcher: typeof fetch,
  deadlineMs: number,
  id: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    return await ctx.logCall(`doctor.${id}`, () =>
      fetcher(url, { ...init, signal: AbortSignal.timeout(deadlineMs) }),
    );
  } catch {
    return null;
  }
}

const slackOkWire = z.object({ ok: z.literal(true) });
const slackMemberWire = z.object({
  ok: z.literal(true),
  channel: z.object({ is_member: z.literal(true) }),
});
const slackManifestWire = z.object({
  ok: z.literal(true),
  manifest: z.object({ features: z.object({ slash_commands: z.array(z.unknown()) }) }),
});
const slashCommandWire = z.object({ command: z.string() });

// The parsed body of an ok Slack response, or null when it is unreadable or does not match.
async function slackBody<T extends z.ZodType>(
  response: Response | null,
  wire: T,
): Promise<z.output<T> | null> {
  if (response === null || !response.ok) return null;
  try {
    const parsed = wire.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Bounded daemon-side checks; no response body or exception text leaves this module. */
export async function runDaemonDoctor(
  ctx: ModuleContext<Store>,
  productVersion: string,
  fetcher: typeof fetch = fetch,
  { deadlineMs = DEADLINE_MS }: { deadlineMs?: number } = {},
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
  const linkSamples = sampleLinks(ctx, fetcher, deadlineMs, secrets['GITHUB_TOKEN']);
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
        const response = await request(ctx, fetcher, deadlineMs, 'jira', url, {
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
  const githubFindings =
    githubToken === undefined
      ? [githubFail(GITHUB_FIX)]
      : await Promise.all(
          [...githubRepos].map((repo) =>
            githubRepoFinding(ctx, fetcher, deadlineMs, githubToken, repo),
          ),
        );
  checks.push(githubCheck(githubFindings));
  checks.push(linkRulesCheck(await linkSamples));

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
      deadlineMs,
      'spur',
      new URL('sessions', apiBaseUrl(config.adapters.spur.baseUrl)),
    ),
    request(ctx, fetcher, deadlineMs, 'spur.send', probe.url, probe.init),
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
    const slackBase = apiBaseUrl(slackApi);
    const auth = botToken
      ? await request(ctx, fetcher, deadlineMs, 'slack.auth', new URL('auth.test', slackBase), {
          method: 'POST',
          headers: slackHeaders,
        })
      : null;
    const authorized = (await slackBody(auth, slackOkWire)) !== null;
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
              deadlineMs,
              id,
              new URL(`conversations.info?channel=${encodeURIComponent(channel)}`, slackBase),
              { headers: slackHeaders },
            )
          : null;
      checks.push(
        check(
          id,
          (await slackBody(response, slackMemberWire)) !== null,
          'Invite the bot to the configured channel ID.',
        ),
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
        deadlineMs,
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
      // An unreadable manifest is an unknown state, not proof of a mismatch.
      const manifest = await slackBody(response, slackManifestWire);
      const commands =
        manifest?.manifest.features.slash_commands.flatMap((entry) => {
          const parsed = slashCommandWire.safeParse(entry);
          return parsed.success ? [parsed.data.command] : [];
        }) ?? null;
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
  checks.push(await operatorTokensCheck(ctx, config));
  checks.push(curatorSessionsCheck(await curatorSessions(ctx.store.db, config)));
  return { version: productVersion, checks };
}
