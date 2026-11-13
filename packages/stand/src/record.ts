// Records one bootstrap poll of every live source, scrubbed into the stand's names, for the contract
// test of the stand's fakes (`test/recordings.test.ts`). Run only as `pnpm record:fakes` on the
// maintainer's machine: it reads the live board's config.yaml and secrets.env, never its store,
// and sends only the read requests the guard below allows. The stand runtime never imports it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAdapters } from '@spur-board/adapters';
import { createFakeCore } from '@spur-board/adapters/testing';
import { configSchema, DEFAULT_LINK, type Config } from '@spur-board/contracts';
import { loadConfig, resolvePaths, type Paths } from '@spur-board/daemon/in-process';
import { Kind, parse, type OperationDefinitionNode, type SelectionSetNode } from 'graphql';
import { z } from 'zod';
import { SPRINT_FIELD, STATUSES } from './fakes/jira.ts';
import { standConfig } from './stand.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Project = Config['projects'][number];
type JiraTracker = Extract<Project['tracker'], { type: 'jira' }>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const GITHUB_API = 'https://api.github.com';
const GRAPHQL_URL = `${GITHUB_API}/graphql`;
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
/** The session the Spur probe asks for; no Spur holds it, so it answers 404. */
const PROBE_SESSION = 'stand-missing-session';
/** Synthetic Jira ids are `99nnnnn`: numeric as Jira's, and told apart by the scan's rule 4. */
const JIRA_ID_BASE = 9_900_000;
const SYNTHETIC = {
  node: /^recorded-node-\d+$/,
  sha: /^0{30}\d{10}$/,
  jiraId: /^99\d{5}$/,
};
/** Any full commit SHA, wherever it stands; only the synthetic form may be written. */
const ANY_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const KEPT_HEADERS = ['content-type', 'link', 'x-spur-lifecycle-instance-id'];
const SECRET_NAMES = ['GITHUB_TOKEN', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const;

const stand = configSchema.parse(standConfig(0));
const standIssues = stand.projects.find(({ tracker }) => tracker.type === 'github-issues');
const standJira = stand.projects.find(({ tracker }) => tracker.type === 'jira');
if (standIssues?.tracker.type !== 'github-issues' || standJira?.tracker.type !== 'jira')
  throw new Error('standConfig lost a tracker project.');
const STAND = {
  issuesId: standIssues.id,
  board: standIssues.tracker.repo,
  jiraId: standJira.id,
  service: standJira.repos[0] ?? '',
  jiraBase: standJira.tracker.baseUrl,
  jql: standJira.tracker.jql,
  key: standJira.tracker.projectKeys[0] ?? '',
  login: standIssues.operatorGithubLogin,
  spurBase: stand.adapters.spur.baseUrl,
  done: standJira.tracker.doneStatuses[0] ?? '',
  ready: standJira.tracker.readyStatuses[0] ?? '',
};
/** The fake's statuses a live status with no done or ready role takes, in first-seen order. */
const OTHER_STATUSES = STATUSES.filter((name) => name !== STAND.done && name !== STAND.ready);
/** A status name a recording may hold: the fake's, or the generic one past them. */
const isStandStatus = (name: string): boolean =>
  (STATUSES as readonly string[]).includes(name) || /^Status \d+$/.test(name);

/** The five files, by stand source id. */
export const RECORDING_FILES: Readonly<Record<string, string>> = {
  spur: 'spur/sessions.json',
  [`github:${STAND.issuesId}:${STAND.board}`]: `github-pr/${STAND.board.replace('/', '-')}.json`,
  [`github:${STAND.jiraId}:${STAND.service}`]: `github-pr/${STAND.service.replace('/', '-')}.json`,
  [`github-issues:${STAND.issuesId}:${STAND.board}`]: `github-issues/${STAND.board.replace('/', '-')}.json`,
  [`jira:${STAND.jiraId}`]: `jira/${STAND.jiraId}.json`,
};

const headersSchema = z.record(z.string(), z.string());
const exchangeSchema = z.strictObject({
  request: z.strictObject({
    method: z.enum(['GET', 'POST']),
    url: z.url(),
    headers: headersSchema,
    body: z.json().nullable(),
  }),
  response: z.strictObject({ status: z.int(), headers: headersSchema, body: z.json() }),
});
/** One recorded source: the requests one bootstrap poll sent and what the live system answered. */
export const recordingSchema = z.strictObject({
  source: z.string().min(1),
  recordedAt: z.iso.datetime(),
  observe: z.strictObject({
    prs: z.tuple([]),
    tickets: z.tuple([]),
    sessions: z.array(z.strictObject({ kind: z.literal('session'), id: z.string().min(1) })),
  }),
  tracker: z
    .strictObject({ doneStatuses: z.array(z.string()), readyStatuses: z.array(z.string()) })
    .optional(),
  exchanges: z.array(exchangeSchema).min(1),
});
export type Recording = z.output<typeof recordingSchema>;

/** A refusal: the recorder writes nothing and exits 1. The message never holds a live value. */
class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------
// Live config narrowing

interface Live {
  /** The live config with the two projects only, renamed to the stand's project ids. */
  config: Config;
  issuesRepo: string;
  jiraRepo: string;
  jira: JiraTracker;
  jiraOrigin: string;
  spurBase: URL;
  logins: string[];
}

function isDefaultLink(project: Project): boolean {
  const { link } = project;
  return (
    link.branchPattern === DEFAULT_LINK.branchPattern &&
    link.titlePattern === DEFAULT_LINK.titlePattern &&
    link.sources.join() === DEFAULT_LINK.sources.join()
  );
}

/** The two live projects the stand can hold, or a refusal naming the shape it cannot. */
export function narrow(config: Config): Live {
  const issues = config.projects.filter(({ tracker }) => tracker.type === 'github-issues');
  const jiras = config.projects.filter(({ tracker }) => tracker.type === 'jira');
  const [issuesProject] = issues;
  const [jiraProject] = jiras;
  if (issues.length !== 1 || issuesProject?.tracker.type !== 'github-issues')
    throw new Refusal('The live config needs exactly one github-issues project.');
  if (jiras.length !== 1 || jiraProject?.tracker.type !== 'jira')
    throw new Refusal('The live config needs exactly one Jira project.');
  const tracker = issuesProject.tracker;
  if (issuesProject.repos.length !== 1 || issuesProject.repos[0] !== tracker.repo)
    throw new Refusal('The github-issues project must list only its tracker repo in repos.');
  if (tracker.label !== undefined || tracker.milestone !== undefined)
    throw new Refusal('The github-issues tracker must have no label or milestone filter.');
  const jira = jiraProject.tracker;
  const jiraRepo = jiraProject.repos[0];
  if (jiraProject.repos.length !== 1 || jiraRepo === undefined)
    throw new Refusal('The Jira project must have exactly one repo.');
  if (jira.projectKeys.length !== 1)
    throw new Refusal('The Jira tracker must have exactly one project key.');
  if (jiraRepo.toLowerCase() === tracker.repo.toLowerCase())
    throw new Refusal('The Jira project and the github-issues project must use different repos.');
  if (!isDefaultLink(issuesProject) || !isDefaultLink(jiraProject))
    throw new Refusal('A project with a link block changes the query shape; remove it to record.');
  // The scrub maps every login to one stand login, so a PR polling skips in one project would
  // be discovered there on replay and ask for details nothing recorded.
  if (
    issuesProject.operatorGithubLogin.toLowerCase() !==
    jiraProject.operatorGithubLogin.toLowerCase()
  )
    throw new Refusal('Both projects must have the same operatorGithubLogin.');
  return {
    config: {
      ...config,
      projects: [
        { ...issuesProject, id: STAND.issuesId },
        { ...jiraProject, id: STAND.jiraId },
      ],
    },
    issuesRepo: tracker.repo,
    jiraRepo,
    jira,
    jiraOrigin: new URL(jira.baseUrl).origin,
    spurBase: new URL(`${config.adapters.spur.baseUrl.replace(/\/$/, '')}/`),
    logins: [...new Set([issuesProject.operatorGithubLogin, jiraProject.operatorGithubLogin])],
  };
}

// ---------------------------------------------------------------------------------------------
// The read guard

function requestParts(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): { url: URL; method: string; body: string | undefined } {
  const source = input instanceof Request ? input : undefined;
  const url = new URL(source?.url ?? (input as string | URL));
  const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return { url, method, body };
}

function isReadQuery(body: string | undefined): boolean {
  if (body === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('query' in parsed) ||
      typeof parsed.query !== 'string'
    )
      return false;
    return parse(parsed.query).definitions.every(
      (definition) =>
        definition.kind === Kind.OPERATION_DEFINITION && definition.operation === 'query',
    );
  } catch {
    return false;
  }
}

/** Whether a request is one of the allowlisted reads. */
function allowed(live: Live, url: URL, method: string, body: string | undefined): boolean {
  if (url.search !== '' && url.origin !== GITHUB_API) return false;
  if (url.origin === live.spurBase.origin && url.pathname.startsWith(live.spurBase.pathname)) {
    const path = url.pathname.slice(live.spurBase.pathname.length);
    return method === 'GET' && /^sessions(\/[^/]+)?$/.test(path);
  }
  if (url.href === GRAPHQL_URL) return method === 'POST' && isReadQuery(body);
  if (url.origin === GITHUB_API) {
    const match = /^\/repos\/([^/]+\/[^/]+)(\/issues|\/milestones|\/issues\/[1-9]\d*)?$/.exec(
      url.pathname,
    );
    const repo = match?.[1]?.toLowerCase();
    return (
      method === 'GET' &&
      body === undefined &&
      (repo === live.issuesRepo.toLowerCase() || repo === live.jiraRepo.toLowerCase())
    );
  }
  if (url.origin === live.jiraOrigin) {
    const path = url.pathname;
    if (method === 'POST') return path === '/rest/api/3/search/jql';
    return (
      method === 'GET' &&
      body === undefined &&
      /^\/rest\/api\/3\/(project\/[^/]+\/statuses|field|issue\/[^/]+)$/.test(path)
    );
  }
  return false;
}

/**
 * A `fetch` that sends only the recorder's read requests: GET of Spur sessions, a GraphQL `query`,
 * GET of a configured repo's issues and milestones, and Jira's statuses, fields, issue and POST
 * search. Anything else throws before `transport` and lands in `refused`. Redirects fail.
 */
export function createReadGuard(
  live: Live,
  transport: typeof fetch,
  refused: string[],
): typeof fetch {
  return (input, init) => {
    const { url, method, body } = requestParts(input, init);
    if (!allowed(live, url, method, body)) {
      const host =
        url.origin === GITHUB_API || url.origin === live.jiraOrigin
          ? 'a configured system'
          : url.origin === live.spurBase.origin
            ? 'Spur'
            : 'a host outside the live config';
      const message = `The recorder refused a ${method} request to ${host}.`;
      refused.push(message);
      return Promise.reject(new Error(message));
    }
    // A redirect would reach a host the guard never checked, and a 307 or 308 resends the body.
    return transport(input, { ...init, redirect: 'error' });
  };
}

// ---------------------------------------------------------------------------------------------
// The tap

interface RawExchange {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  status: number;
  responseHeaders: Headers;
  responseText: string;
}

function tap(transport: typeof fetch, exchanges: RawExchange[]): typeof fetch {
  return async (input, init) => {
    const { url, method, body } = requestParts(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const response = await transport(input, init);
    const responseText = await response.text();
    exchanges.push({
      method,
      url,
      headers,
      body,
      status: response.status,
      responseHeaders: response.headers,
      responseText,
    });
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Scrubbing, step 1: projection and the live -> stand map. Strings that need a placeholder become
// `Pending`; step 2 numbers them in a canonical order.

const CATEGORIES = {
  user: (n: number) => `recorded-user-${String(n)}`,
  account: (n: number) => `recorded-account-${String(n)}`,
  title: (n: number) => `Recorded title ${String(n)}`,
  branch: (n: number) => `recorded-branch-${String(n)}`,
  session: (n: number) => `recorded-session-${String(n)}`,
  project: (n: number) => `recorded-project-${String(n)}`,
  check: (n: number) => `check-${String(n)}`,
  label: (n: number) => `label-${String(n)}`,
  milestone: (n: number) => `recorded-milestone-${String(n)}`,
  sprint: (n: number) => `Recorded sprint ${String(n)}`,
  team: (n: number) => `recorded-team-${String(n)}`,
  type: (n: number) => `recorded-type-${String(n)}`,
  instance: (n: number) => `recorded-instance-${String(n)}`,
  jiraKey: (n: number) => `${STAND.key}-${String(n)}`,
  repo: (n: number) => `recorded-org/recorded-repo-${String(n)}`,
  link: (n: number) => `https://recorded.invalid/link-${String(n)}`,
  cursor: (n: number) => `recorded-cursor-${String(n)}`,
  text: (n: number) => `recorded-text-${String(n)}`,
  node: (n: number) => `recorded-node-${String(n)}`,
  sha: (n: number) => String(n).padStart(40, '0'),
  jiraId: (n: number) => String(JIRA_ID_BASE + n),
};
type Category = keyof typeof CATEGORIES;

class Pending {
  readonly category: Category;
  readonly value: string;
  readonly wrap: (placeholder: string) => string;
  constructor(category: Category, value: string, wrap: (placeholder: string) => string = (p) => p) {
    this.category = category;
    this.value = value;
    this.wrap = wrap;
  }
}
type Draft = null | boolean | number | string | Pending | Draft[] | { [key: string]: Draft };

export type System = 'spur' | 'github-pr' | 'github-issues' | 'jira';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

class Scrubber {
  private readonly live: Live;
  private readonly repos: Map<string, string>;
  private readonly logins: Set<string>;
  private readonly key: string;
  private readonly jiraHost: string;
  /** Live Jira status name -> stand name, numbered in the order the answers show them. */
  private readonly statuses = new Map<string, string>();
  /** The live Jira sprint field id, once `/field` answered. */
  sprintField: string | undefined;

  constructor(live: Live) {
    this.live = live;
    this.repos = new Map([
      [live.issuesRepo.toLowerCase(), STAND.board],
      [live.jiraRepo.toLowerCase(), STAND.service],
    ]);
    this.logins = new Set(live.logins.map((login) => login.toLowerCase()));
    this.key = live.jira.projectKeys[0] ?? '';
    this.jiraHost = new URL(live.jira.baseUrl).host;
  }

  standRepo(repo: string): string | undefined {
    return this.repos.get(repo.toLowerCase());
  }

  login(value: unknown, path: string): Draft {
    return this.text(value, path, (login) =>
      this.logins.has(login.toLowerCase()) ? STAND.login : new Pending('user', login),
    );
  }

  repo(value: unknown, path: string): Draft {
    return this.text(value, path, (repo) => this.standRepo(repo) ?? new Pending('repo', repo));
  }

  jiraKey(value: unknown, path: string): Draft {
    return this.text(value, path, (key) => this.standKey(key, path));
  }

  /**
   * `<LIVEKEY>-<n>` as a pending `STAND-<i>`, numbered first-seen with the other placeholders, so
   * no live issue number is written; `wrap` puts it into a URL. A key of another project is refused.
   */
  standKey(key: string, path: string, wrap?: (standKey: string) => string): Pending {
    const match = /^([A-Za-z][A-Za-z0-9_]*)-([1-9]\d*)$/.exec(key);
    if (match?.[1] !== this.key)
      throw new Refusal(`A Jira key at ${path} is outside the configured project key.`);
    return new Pending('jiraKey', match[2] ?? '', wrap);
  }

  /**
   * A live Jira status as a stand one: a done status as the stand's done, a ready one as its
   * ready, any other as the fake's next unused status, then `Status <n>`. One name, one mapping.
   */
  standStatus(name: string): string {
    let mapped = this.statuses.get(name);
    if (mapped === undefined) {
      if (this.live.jira.doneStatuses.includes(name)) mapped = STAND.done;
      else if (this.live.jira.readyStatuses.includes(name)) mapped = STAND.ready;
      else {
        const used = [...this.statuses.values()].filter(
          (value) => value !== STAND.done && value !== STAND.ready,
        ).length;
        mapped = OTHER_STATUSES[used] ?? `Status ${String(used - OTHER_STATUSES.length + 1)}`;
      }
      this.statuses.set(name, mapped);
    }
    return mapped;
  }

  status(value: unknown, path: string): Draft {
    return this.text(value, path, (name) => this.standStatus(name));
  }

  url(value: unknown, path: string): Draft {
    return this.text(value, path, (text) => {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return new Pending('link', text);
      }
      if (url.host === 'github.com') {
        const match = /^\/([^/]+\/[^/]+)\/(pull|issues)\/([1-9]\d*)$/.exec(url.pathname);
        if (match !== null && url.search === '' && url.hash === '') {
          const [, repo = '', kind = '', number = ''] = match;
          const tail = `/${kind}/${number}`;
          const known = this.standRepo(repo);
          return known === undefined
            ? new Pending('repo', repo, (p) => `https://github.com/${p}${tail}`)
            : `https://github.com/${known}${tail}`;
        }
      }
      if (url.host === this.jiraHost && url.search === '' && url.hash === '') {
        const browse = /^\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)$/.exec(url.pathname)?.[1];
        if (browse !== undefined)
          return this.standKey(browse, path, (key) => `${STAND.jiraBase}/browse/${key}`);
        const issue = /^\/rest\/api\/3\/issue\/([1-9]\d*)$/.exec(url.pathname)?.[1];
        if (issue !== undefined)
          return new Pending('jiraId', issue, (p) => `${STAND.jiraBase}/rest/api/3/issue/${p}`);
      }
      return new Pending('link', text);
    });
  }

  /** A string through `map`; null, numbers and booleans as they are; anything else refused. */
  text(value: unknown, path: string, map: (text: string) => Draft): Draft {
    if (typeof value === 'string') return value === '' ? '' : map(value);
    return this.scalar(value, path);
  }

  scalar(value: unknown, path: string): Draft {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value;
    throw new Refusal(`Unexpected ${Array.isArray(value) ? 'array' : typeof value} at ${path}.`);
  }

  placeholder(category: Category) {
    return (value: unknown, path: string): Draft =>
      this.text(value, path, (text) => new Pending(category, text));
  }

  /** Every string a placeholder of `text`, keys kept: for error bodies. */
  generic(value: unknown, path: string): Draft {
    if (Array.isArray(value))
      return value.map((item, i) => this.generic(item, `${path}[${String(i)}]`));
    if (isObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.generic(item, `${path}.${key}`)]),
      );
    return this.placeholder('text')(value, path);
  }

  // Requests ----------------------------------------------------------------------------------

  requestUrl(system: System, url: URL): Draft {
    if (system === 'spur')
      return new URL(
        url.pathname.slice(this.live.spurBase.pathname.length) + url.search,
        `${STAND.spurBase.replace(/\/$/, '')}/`,
      ).href;
    if (system === 'jira') {
      const key = /^\/rest\/api\/3\/issue\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)$/.exec(
        url.pathname,
      )?.[1];
      if (key !== undefined)
        return this.standKey(
          key,
          'request.url',
          (standKey) => `${STAND.jiraBase}/rest/api/3/issue/${standKey}${url.search}`,
        );
      const path = url.pathname.replace(
        /^\/rest\/api\/3\/project\/[^/]+\/statuses$/,
        `/rest/api/3/project/${STAND.key}/statuses`,
      );
      return `${STAND.jiraBase}${path}${url.search}`;
    }
    if (system === 'github-issues') {
      const mapped = new URL(url.href);
      mapped.pathname = url.pathname.replace(
        /^\/repos\/([^/]+\/[^/]+)/,
        (_all, repo: string) => `/repos/${this.standRepo(repo) ?? repo}`,
      );
      return mapped.href;
    }
    return url.href;
  }

  requestBody(system: System, body: string | undefined): Json {
    if (body === undefined) return null;
    const parsed = JSON.parse(body) as Json;
    if (!isObject(parsed)) throw new Refusal(`A ${system} request body is not an object.`);
    if (system === 'github-pr') {
      const variables = isObject(parsed['variables']) ? { ...parsed['variables'] } : {};
      const owner = variables['owner'];
      const name = variables['repo'];
      const repo =
        typeof owner === 'string' && typeof name === 'string'
          ? this.standRepo(`${owner}/${name}`)
          : undefined;
      if (repo === undefined) throw new Refusal('A GraphQL request names an unknown repo.');
      const [standOwner = '', standName = ''] = repo.split('/');
      return { ...parsed, variables: { ...variables, owner: standOwner, repo: standName } };
    }
    if (system === 'jira') {
      const fields = Array.isArray(parsed['fields'])
        ? parsed['fields'].map((field) => (field === this.sprintField ? SPRINT_FIELD : field))
        : parsed['fields'];
      return { ...parsed, jql: STAND.jql, ...(fields === undefined ? {} : { fields }) };
    }
    throw new Refusal(`A ${system} request carries a body.`);
  }

  // Responses ---------------------------------------------------------------------------------

  spurSession(value: unknown, path: string): Draft {
    if (!isObject(value)) return this.scalar(value, path);
    const out: Record<string, Draft> = {};
    const keep = (key: string, map: (value: unknown, path: string) => Draft): void => {
      if (key in value) out[key] = map(value[key], `${path}.${key}`);
    };
    keep('id', this.placeholder('session'));
    keep('project', this.placeholder('project'));
    keep('branch', this.placeholder('branch'));
    keep('status', (v, p) => this.scalar(v, p));
    keep('state', (v, p) => this.scalar(v, p));
    keep('lastActivityAt', (v, p) => this.scalar(v, p));
    keep('stopReason', (v, p) => this.scalar(v, p));
    keep('retainInList', (v, p) => this.scalar(v, p));
    const slots = value['slots'];
    if (isObject(slots)) {
      const links = slots['links'];
      out['slots'] = Array.isArray(links)
        ? {
            links: links.map((link, i) => {
              const at = `${path}.slots.links[${String(i)}]`;
              if (!isObject(link)) return this.scalar(link, at);
              return {
                label: this.scalar(link['label'], `${at}.label`),
                url: this.url(link['url'], `${at}.url`),
              };
            }),
          }
        : {};
    } else if ('slots' in value) out['slots'] = this.scalar(slots, `${path}.slots`);
    return out;
  }

  issue(value: unknown, path: string): Draft {
    if (!isObject(value)) return this.scalar(value, path);
    const out: Record<string, Draft> = {};
    const keep = (key: string, map: (value: unknown, path: string) => Draft): void => {
      if (key in value) out[key] = map(value[key], `${path}.${key}`);
    };
    const nested =
      (map: (inner: Record<string, unknown>, at: string) => Draft) => (v: unknown, p: string) =>
        isObject(v) ? map(v, p) : this.scalar(v, p);
    keep('node_id', this.placeholder('node'));
    keep('number', (v, p) => this.scalar(v, p));
    keep('title', this.placeholder('title'));
    keep('state', (v, p) => this.scalar(v, p));
    keep('html_url', (v, p) => this.url(v, p));
    keep('updated_at', (v, p) => this.scalar(v, p));
    keep('labels', (v, p) =>
      Array.isArray(v)
        ? v.map((label, i) =>
            nested((inner, at) => ({
              name: this.placeholder('label')(inner['name'], `${at}.name`),
            }))(label, `${p}[${String(i)}]`),
          )
        : this.scalar(v, p),
    );
    keep(
      'assignee',
      nested((inner, at) => ({ login: this.login(inner['login'], `${at}.login`) })),
    );
    keep(
      'milestone',
      nested((inner, at) => ({
        title: this.placeholder('milestone')(inner['title'], `${at}.title`),
        number: this.scalar(inner['number'], `${at}.number`),
      })),
    );
    keep(
      'pull_request',
      nested((inner, at) => ({ html_url: this.url(inner['html_url'], `${at}.html_url`) })),
    );
    return out;
  }

  jiraStatuses(value: unknown, path: string): Draft {
    if (!Array.isArray(value)) return this.scalar(value, path);
    return value.map((type, i) => {
      const at = `${path}[${String(i)}]`;
      if (!isObject(type)) return this.scalar(type, at);
      const statuses = type['statuses'];
      return {
        id: this.placeholder('jiraId')(type['id'], `${at}.id`),
        name: this.placeholder('type')(type['name'], `${at}.name`),
        subtask: this.scalar(type['subtask'], `${at}.subtask`),
        statuses: Array.isArray(statuses)
          ? statuses.map((status, j) => {
              const where = `${at}.statuses[${String(j)}]`;
              return isObject(status)
                ? {
                    id: this.placeholder('jiraId')(status['id'], `${where}.id`),
                    name: this.status(status['name'], `${where}.name`),
                  }
                : this.scalar(status, where);
            })
          : this.scalar(statuses, `${at}.statuses`),
      };
    });
  }

  jiraFields(value: unknown, path: string): Draft {
    if (!Array.isArray(value)) return this.scalar(value, path);
    const sprint = value.find(
      (field): field is Record<string, unknown> =>
        isObject(field) && isObject(field['schema']) && field['schema']['custom'] === SPRINT_SCHEMA,
    );
    if (sprint === undefined || typeof sprint['id'] !== 'string')
      throw new Refusal('The Jira fake expects a sprint field, and the live Jira has none.');
    this.sprintField = sprint['id'];
    const wanted = new Set([
      'summary',
      'status',
      'assignee',
      'labels',
      'updated',
      this.sprintField,
    ]);
    const standCustomId = Number(SPRINT_FIELD.slice('customfield_'.length));
    return value.flatMap((field, i): Draft[] => {
      const at = `${path}[${String(i)}]`;
      if (!isObject(field) || typeof field['id'] !== 'string' || !wanted.has(field['id']))
        return [];
      const isSprint = field['id'] === this.sprintField;
      const out: Record<string, Draft> = {
        id: isSprint ? SPRINT_FIELD : field['id'],
        name: this.scalar(field['name'], `${at}.name`),
        custom: this.scalar(field['custom'], `${at}.custom`),
      };
      const schema = field['schema'];
      if (isObject(schema)) {
        const projected: Record<string, Draft> = {};
        if ('type' in schema) projected['type'] = this.scalar(schema['type'], `${at}.schema.type`);
        if ('custom' in schema)
          projected['custom'] = this.scalar(schema['custom'], `${at}.schema.custom`);
        if ('customId' in schema)
          projected['customId'] = isSprint
            ? standCustomId
            : this.scalar(schema['customId'], `${at}.schema.customId`);
        out['schema'] = projected;
      } else if ('schema' in field) out['schema'] = this.scalar(schema, `${at}.schema`);
      return [out];
    });
  }

  jiraIssue(value: unknown, path: string): Draft {
    if (!isObject(value)) return this.scalar(value, path);
    const fields = value['fields'];
    const out: Record<string, Draft> = {
      id: this.placeholder('jiraId')(value['id'], `${path}.id`),
      key: this.jiraKey(value['key'], `${path}.key`),
    };
    if ('self' in value) out['self'] = this.url(value['self'], `${path}.self`);
    if (!isObject(fields)) {
      out['fields'] = this.scalar(fields, `${path}.fields`);
      return out;
    }
    const at = `${path}.fields`;
    const projected: Record<string, Draft> = {};
    if ('summary' in fields)
      projected['summary'] = this.placeholder('title')(fields['summary'], `${at}.summary`);
    const status = fields['status'];
    if (isObject(status))
      projected['status'] = { name: this.status(status['name'], `${at}.status.name`) };
    else if ('status' in fields) projected['status'] = this.scalar(status, `${at}.status`);
    const assignee = fields['assignee'];
    if (isObject(assignee)) {
      const person: Record<string, Draft> = {};
      if ('accountId' in assignee)
        person['accountId'] = this.placeholder('account')(
          assignee['accountId'],
          `${at}.assignee.accountId`,
        );
      if ('displayName' in assignee)
        person['displayName'] = this.placeholder('user')(
          assignee['displayName'],
          `${at}.assignee.displayName`,
        );
      projected['assignee'] = person;
    } else if ('assignee' in fields)
      projected['assignee'] = this.scalar(assignee, `${at}.assignee`);
    const labels = fields['labels'];
    if (Array.isArray(labels))
      projected['labels'] = labels.map((label, i) =>
        this.placeholder('label')(label, `${at}.labels[${String(i)}]`),
      );
    else if ('labels' in fields) projected['labels'] = this.scalar(labels, `${at}.labels`);
    if ('updated' in fields) projected['updated'] = this.scalar(fields['updated'], `${at}.updated`);
    if (this.sprintField !== undefined && this.sprintField in fields) {
      const sprint = fields[this.sprintField];
      const where = `${at}.${SPRINT_FIELD}`;
      projected[SPRINT_FIELD] = Array.isArray(sprint)
        ? sprint.map((entry, i) => {
            const inner = `${where}[${String(i)}]`;
            if (!isObject(entry)) return this.placeholder('sprint')(entry, inner);
            const picked: Record<string, Draft> = {};
            if ('name' in entry)
              picked['name'] = this.placeholder('sprint')(entry['name'], `${inner}.name`);
            if ('state' in entry) picked['state'] = this.scalar(entry['state'], `${inner}.state`);
            return picked;
          })
        : this.scalar(sprint, where);
    }
    out['fields'] = projected;
    return out;
  }

  jiraSearch(value: unknown, path: string): Draft {
    if (!isObject(value)) return this.scalar(value, path);
    const issues = value['issues'];
    const out: Record<string, Draft> = {
      issues: Array.isArray(issues)
        ? issues.map((issue, i) => this.jiraIssue(issue, `${path}.issues[${String(i)}]`))
        : this.scalar(issues, `${path}.issues`),
    };
    if ('isLast' in value) out['isLast'] = this.scalar(value['isLast'], `${path}.isLast`);
    if ('nextPageToken' in value)
      out['nextPageToken'] = this.placeholder('cursor')(
        value['nextPageToken'],
        `${path}.nextPageToken`,
      );
    return out;
  }

  /** A GraphQL answer cut to the request's selection set. */
  graphql(value: unknown, operation: OperationDefinitionNode, path: string): Draft {
    if (!isObject(value)) return this.scalar(value, path);
    const out: Record<string, Draft> = {};
    if ('data' in value)
      out['data'] = this.select(value['data'], operation.selectionSet, `${path}.data`);
    const errors = value['errors'];
    if (Array.isArray(errors))
      out['errors'] = errors.map((error, i) => {
        const at = `${path}.errors[${String(i)}]`;
        if (!isObject(error)) return this.scalar(error, at);
        const picked: Record<string, Draft> = {
          message: this.placeholder('text')(error['message'], `${at}.message`),
        };
        if ('type' in error) picked['type'] = this.scalar(error['type'], `${at}.type`);
        if (Array.isArray(error['path']))
          picked['path'] = error['path'].map((part, j) =>
            this.scalar(part, `${at}.path[${String(j)}]`),
          );
        return picked;
      });
    return out;
  }

  private select(value: unknown, set: SelectionSetNode, path: string): Draft {
    if (Array.isArray(value))
      return value.map((item, i) => this.select(item, set, `${path}[${String(i)}]`));
    if (!isObject(value)) return this.scalar(value, path);
    const out: Record<string, Draft> = {};
    for (const selection of set.selections) {
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (selection.typeCondition?.name.value === value['__typename'])
          Object.assign(out, this.select(value, selection.selectionSet, path));
        continue;
      }
      if (selection.kind !== Kind.FIELD) continue;
      const key = selection.alias?.value ?? selection.name.value;
      if (!(key in value)) continue;
      const at = `${path}.${key}`;
      out[key] =
        selection.selectionSet === undefined
          ? this.graphqlScalar(selection.name.value, value[key], at)
          : this.select(value[key], selection.selectionSet, at);
    }
    return out;
  }

  private graphqlScalar(field: string, value: unknown, path: string): Draft {
    switch (field) {
      case 'login':
        return this.login(value, path);
      case 'nameWithOwner':
        return this.repo(value, path);
      case 'url':
        return this.url(value, path);
      case 'title':
        return this.placeholder('title')(value, path);
      case 'headRefName':
        return this.placeholder('branch')(value, path);
      case 'name':
      case 'context':
        return this.placeholder('check')(value, path);
      case 'slug':
        return this.placeholder('team')(value, path);
      case 'endCursor':
      case 'startCursor':
        return this.placeholder('cursor')(value, path);
      case 'id':
        return this.placeholder('node')(value, path);
      case 'headRefOid':
      case 'oid':
        return this.placeholder('sha')(value, path);
      case '__typename':
      case 'state':
      case 'mergeable':
      case 'mergeStateStatus':
      case 'status':
      case 'conclusion':
      case 'updatedAt':
      case 'createdAt':
      case 'startedAt':
      case 'completedAt':
      case 'submittedAt':
      case 'resetAt':
        return this.scalar(value, path);
      default:
        return this.placeholder('text')(value, path);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scrubbing, step 2: placeholders, numbered per category in first-seen order over sorted keys.

class Placeholders {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<Category, number>();

  resolve(draft: Draft): Json {
    if (draft instanceof Pending) {
      const id = `${draft.category}\u0000${draft.value}`;
      let placeholder = this.seen.get(id);
      if (placeholder === undefined) {
        const n = (this.counts.get(draft.category) ?? 0) + 1;
        this.counts.set(draft.category, n);
        placeholder = CATEGORIES[draft.category](n);
        this.seen.set(id, placeholder);
      }
      return draft.wrap(placeholder);
    }
    if (Array.isArray(draft)) return draft.map((item) => this.resolve(item));
    if (draft !== null && typeof draft === 'object')
      return Object.fromEntries(
        Object.keys(draft)
          .sort()
          .map((key) => [key, this.resolve(draft[key] ?? null)]),
      );
    return draft;
  }
}

// ---------------------------------------------------------------------------------------------
// The refusal scan

interface Needles {
  /** Rule 1: substrings anywhere, ids, keys and the GraphQL query included. */
  substrings: string[];
  /** Rule 2: names of 4 or more characters, as words. */
  words: string[];
  /** Rule 3: names under 4 characters, as a whole string value. */
  shorts: string[];
}

function secretForms(value: string): string[] {
  const form = new URLSearchParams({ value }).toString().slice('value='.length);
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), form];
}

/** What must never appear in a recording, from the live config and secrets. */
export function needlesOf(config: Config, secrets: Readonly<Record<string, string>>): Needles {
  const slugs = config.projects.flatMap((project) => [
    ...project.repos,
    ...(project.tracker.type === 'github-issues' ? [project.tracker.repo] : []),
  ]);
  const jiras = config.projects.flatMap(({ tracker }) =>
    tracker.type === 'jira' ? [tracker] : [],
  );
  const names = [
    ...slugs.flatMap((slug) => slug.split('/')),
    ...config.projects.map((project) => project.operatorGithubLogin),
    ...jiras.flatMap((tracker) => tracker.projectKeys),
    ...config.projects.flatMap((project) => project.spurProjects.map(({ name }) => name)),
  ];
  const email = secrets['JIRA_EMAIL'];
  const token = secrets['JIRA_API_TOKEN'];
  const substrings = [
    ...Object.values(secrets).flatMap(secretForms),
    ...(email !== undefined && token !== undefined
      ? [Buffer.from(`${email}:${token}`).toString('base64')]
      : []),
    ...jiras.flatMap((tracker) => [new URL(tracker.baseUrl).host, tracker.jql]),
    ...slugs,
  ];
  const lower = (list: string[]): string[] =>
    [...new Set(list.map((value) => value.toLowerCase()))].filter((value) => value.length > 0);
  return {
    substrings: lower(substrings),
    words: lower(names.filter((name) => name.length >= 4)),
    shorts: lower(names.filter((name) => name.length < 4)),
  };
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// Opaque ids skip rule 2: rule 4 pins each of them to a synthetic form instead.
const OPAQUE = new Set(['id', 'node_id', 'headRefOid', 'oid']);
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Jira field ids a recording keeps: Jira's own names, the same on every site. */
const JIRA_FIELD_IDS = new Set([
  'summary',
  'status',
  'assignee',
  'labels',
  'updated',
  SPRINT_FIELD,
]);

/**
 * Rule 4 for an opaque id or commit key: the test its value must pass, as only the recorder's
 * synthetic forms may be written there. Undefined for a key that holds no id.
 */
function syntheticId(system: System, key: string): ((value: string) => boolean) | undefined {
  if (system === 'github-pr' && key === 'id') return (value) => SYNTHETIC.node.test(value);
  if (system === 'github-pr' && (key === 'headRefOid' || key === 'oid'))
    return (value) => SYNTHETIC.sha.test(value);
  if (system === 'github-issues' && key === 'node_id') return (value) => SYNTHETIC.node.test(value);
  if (system === 'jira' && key === 'id')
    return (value) => SYNTHETIC.jiraId.test(value) || JIRA_FIELD_IDS.has(value);
  if (system === 'spur' && key === 'id')
    return (value) => /^recorded-session-\d+$/.test(value) || value === PROBE_SESSION;
  return undefined;
}

interface Hit {
  path: string;
  rule: string;
}

const SHAPE = 'rule 4 (shape)';
/** Where a Jira status name stands: the statuses answer, an issue's status, the tracker lists. */
const STATUS_PATH =
  /(\.statuses\[\d+\]\.name|\.fields\.status\.name|^\$\.tracker\.(doneStatuses|readyStatuses)\[\d+\])$/;
const STAND_KEY = new RegExp(`^${STAND.key}-(\\d+)$`);
/** A Jira issue reference in a stand Jira URL: `/browse/<key>` or `/rest/api/3/issue/<id or key>`. */
const JIRA_REF = /^\/(browse|rest\/api\/3\/issue)\/([^/]+)$/;

/** A Jira key the scan saw, for the 1..N check across all recordings of a run. */
interface KeySeen {
  n: number;
  path: string;
}

/**
 * The first leak in `recording` by the four rules, or undefined. Never returns the value. Every
 * stand Jira key it passes goes into `keys`.
 */
export function scan(
  recording: unknown,
  needles: Needles,
  system: System,
  keys: KeySeen[] = [],
): Hit | undefined {
  const words = needles.words.map(
    (needle) => new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, 'i'),
  );
  const rule1 = (text: string): boolean => {
    const lower = text.toLowerCase();
    return EMAIL.test(text) || needles.substrings.some((needle) => lower.includes(needle));
  };
  const rule2 = (text: string): boolean => words.some((word) => word.test(text));
  const rule3 = (text: string): boolean => needles.shorts.includes(text.toLowerCase());

  /** Whether `text` is not a stand Jira key; a stand key is kept for the 1..N check. */
  function notStandKey(text: string, path: string): boolean {
    const n = STAND_KEY.exec(text)?.[1];
    if (n === undefined) return true;
    keys.push({ n: Number(n), path });
    return false;
  }

  function rule4(key: string, value: string, path: string): boolean {
    const id = syntheticId(system, key);
    if (id !== undefined) return !id(value);
    if (ANY_SHA.test(value)) return !SYNTHETIC.sha.test(value);
    if (key === 'project' && system === 'spur') return !/^recorded-project-\d+$/.test(value);
    if (key === 'login') return value !== STAND.login && !/^recorded-user-\d+$/.test(value);
    if (key === 'key' && system === 'jira') return notStandKey(value, path);
    if (system === 'jira' && STATUS_PATH.test(path)) return !isStandStatus(value);
    let url: URL | undefined;
    try {
      url = /^https?:\/\//i.test(value) ? new URL(value) : undefined;
    } catch {
      url = undefined;
    }
    const jiraRef =
      url?.origin === new URL(STAND.jiraBase).origin ? JIRA_REF.exec(url.pathname) : null;
    if (jiraRef !== null) {
      const [, kind, ref = ''] = jiraRef;
      if (kind !== 'browse' && /^\d+$/.test(ref)) return !SYNTHETIC.jiraId.test(ref);
      return notStandKey(ref, path);
    }
    if (url?.host === 'github.com')
      return !/^\/(stand-org\/(board|service)|recorded-org\/recorded-repo-\d+)(\/|$)/.test(
        url.pathname,
      );
    return false;
  }

  function walk(value: unknown, path: string, key: string): Hit | undefined {
    const opaque = OPAQUE.has(key);
    const isQuery = path.endsWith('.request.body.query');
    const check = (text: string, asValue: boolean, at: string): Hit | undefined => {
      if (rule1(text)) return { path: at, rule: 'rule 1 (substring)' };
      if (!opaque && !isQuery && rule2(text)) return { path: at, rule: 'rule 2 (word)' };
      if (asValue && rule3(text)) return { path: at, rule: 'rule 3 (whole value)' };
      if (asValue && rule4(key, text, at)) return { path: at, rule: SHAPE };
      return undefined;
    };
    if (typeof value === 'string') return check(value, true, path);
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) {
        const hit = walk(item, `${path}[${String(i)}]`, key);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (isObject(value))
      for (const [name, item] of Object.entries(value)) {
        const at = `${path}.${name}`;
        const keyHit =
          rule1(name) || rule2(name) ? { path: at, rule: 'rule 1 or 2 (key)' } : undefined;
        if (keyHit !== undefined) return keyHit;
        const hit = walk(item, at, name);
        if (hit !== undefined) return hit;
      }
    return undefined;
  }
  return walk(recording, '$', '');
}

// ---------------------------------------------------------------------------------------------
// Recording

const systemOf = (live: Live, url: URL): System => {
  if (url.origin === live.spurBase.origin) return 'spur';
  if (url.href === GRAPHQL_URL) return 'github-pr';
  if (url.origin === GITHUB_API) return 'github-issues';
  return 'jira';
};

function isPaging(system: System, raw: RawExchange): boolean {
  if (system === 'github-pr') {
    const body = JSON.parse(raw.body ?? '{}') as { variables?: Record<string, unknown> };
    if (body.variables?.['after'] !== undefined || body.variables?.['before'] !== undefined)
      return true;
    return /"has(Next|Previous)Page":true/.test(raw.responseText);
  }
  if (system === 'github-issues')
    return (
      raw.url.searchParams.has('page') ||
      raw.url.pathname.startsWith('/repositories/') ||
      /rel="next"/.test(raw.responseHeaders.get('link') ?? '')
    );
  if (system === 'jira') {
    if (/"nextPageToken"/.test(raw.body ?? '')) return true;
    if (raw.url.pathname !== '/rest/api/3/search/jql') return false;
    const token = (JSON.parse(raw.responseText || '{}') as { nextPageToken?: unknown })
      .nextPageToken;
    return typeof token === 'string' && token !== '';
  }
  return false;
}

/** The stand source an exchange belongs to. */
function sourceOf(scrubber: Scrubber, system: System, raw: RawExchange): string {
  if (system === 'spur') return 'spur';
  if (system === 'jira') return `jira:${STAND.jiraId}`;
  if (system === 'github-issues') return `github-issues:${STAND.issuesId}:${STAND.board}`;
  const body = JSON.parse(raw.body ?? '{}') as { variables?: Record<string, unknown> };
  const repo = scrubber.standRepo(
    `${String(body.variables?.['owner'])}/${String(body.variables?.['repo'])}`,
  );
  if (repo === undefined) throw new Refusal('A GraphQL request names an unknown repo.');
  return repo === STAND.board
    ? `github:${STAND.issuesId}:${STAND.board}`
    : `github:${STAND.jiraId}:${STAND.service}`;
}

function draftResponse(scrubber: Scrubber, system: System, raw: RawExchange, at: string): Draft {
  let body: unknown;
  try {
    body = raw.responseText === '' ? null : JSON.parse(raw.responseText);
  } catch {
    throw new Refusal(`The answer at ${at} is not JSON.`);
  }
  const path = `${at}.body`;
  if (raw.status < 200 || raw.status > 299) return scrubber.generic(body, path);
  if (system === 'spur')
    return Array.isArray(body)
      ? body.map((session, i) => scrubber.spurSession(session, `${path}[${String(i)}]`))
      : scrubber.spurSession(body, path);
  if (system === 'github-issues')
    return Array.isArray(body)
      ? body.map((issue, i) => scrubber.issue(issue, `${path}[${String(i)}]`))
      : scrubber.issue(body, path);
  if (system === 'github-pr') {
    const query = (JSON.parse(raw.body ?? '{}') as { query?: string }).query ?? '';
    const [operation] = parse(query).definitions;
    if (operation?.kind !== Kind.OPERATION_DEFINITION)
      throw new Refusal('A GraphQL request holds no operation.');
    return scrubber.graphql(body, operation, path);
  }
  const pathname = raw.url.pathname;
  if (pathname.endsWith('/statuses')) return scrubber.jiraStatuses(body, path);
  if (pathname === '/rest/api/3/field') return scrubber.jiraFields(body, path);
  if (pathname === '/rest/api/3/search/jql') return scrubber.jiraSearch(body, path);
  return scrubber.jiraIssue(body, path);
}

function draftHeaders(headers: Headers): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    out[name] = name === 'x-spur-lifecycle-instance-id' ? new Pending('instance', value) : value;
  }
  return out;
}

function requestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) if (name !== 'authorization') out[name] = value;
  return out;
}

interface DraftRecording {
  source: string;
  exchanges: { request: Draft; response: Draft }[];
}

const hasDetailNode = (recording: Recording): boolean =>
  recording.exchanges.some(({ response }) => {
    const data = isObject(response.body) ? response.body['data'] : undefined;
    return (
      isObject(data) &&
      Object.entries(data).some(
        ([alias, root]) => /^pr\d+$/.test(alias) && isObject(root) && isObject(root['pullRequest']),
      )
    );
  });

interface RecordOptions {
  paths: Paths;
  fetch: typeof fetch;
  outDir: string;
  now: () => number;
  env: Env;
  writeErr: (text: string) => void;
}

/** Masks every needle in a failure message, so a refusal can say what failed without a value. */
function mask(message: string, needles: Needles): string {
  let out = message;
  for (const needle of [...needles.substrings, ...needles.words, ...needles.shorts].sort(
    (a, b) => b.length - a.length,
  ))
    out = out.replace(new RegExp(escapeRegex(needle), 'gi'), '<live>');
  return out.replace(new RegExp(EMAIL.source, 'gi'), '<live>');
}

function loadLive(paths: Paths): { config: Config; secrets: Readonly<Record<string, string>> } {
  try {
    return loadConfig(paths);
  } catch {
    throw new Refusal('The live config.yaml or secrets.env does not load; run board doctor.');
  }
}

/**
 * Polls every live source once through the real adapters, scrubs what it saw and writes one file
 * per stand source under `outDir`. Returns the exit code: 0 written, 1 refused with nothing
 * written. Returns the written files' paths in `written`.
 */
export async function record(options: RecordOptions, written: string[] = []): Promise<number> {
  const known: { needles?: Needles } = {};
  try {
    written.push(...(await recordOrRefuse(options, known)));
    return 0;
  } catch (error) {
    // A refusal path is built from response keys and an unexpected error may quote a response:
    // once the needles are known, every message is masked; before that, only a refusal is shown.
    const { needles } = known;
    const message =
      error instanceof Refusal
        ? error.message
        : `unexpected ${error instanceof Error ? error.name : 'error'}${
            error instanceof Error && needles !== undefined ? `: ${error.message}` : ''
          }`;
    options.writeErr(
      `record:fakes refused: ${needles === undefined ? message : mask(message, needles)}\n`,
    );
    return 1;
  }
}

async function recordOrRefuse(
  options: RecordOptions,
  known: { needles?: Needles },
): Promise<string[]> {
  if (options.env['CI'] === 'true') throw new Refusal('The recorder does not run in CI.');
  const { config, secrets } = loadLive(options.paths);
  const needles = needlesOf(config, secrets);
  known.needles = needles;
  const live = narrow(config);
  const missing = SECRET_NAMES.filter((name) => (secrets[name] ?? '') === '');
  if (missing.length > 0) throw new Refusal(`secrets.env lacks ${missing.join(', ')}.`);
  const startedAt = options.now();
  const recordedAt = new Date(startedAt).toISOString();
  const refused: string[] = [];
  const raw: RawExchange[] = [];
  const probe = { kind: 'session' as const, id: PROBE_SESSION };
  const core = createFakeCore({
    context: (source) => ({
      observe: { prs: [], tickets: [], sessions: source === 'spur' ? [probe] : [] },
    }),
  });
  const failures: string[] = [];
  const runner = startAdapters(live.config, core, {
    secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, secrets[name] ?? ''])),
    fetch: tap(createReadGuard(live, options.fetch, refused), raw),
    now: () => startedAt,
    oneShot: true,
    onPollFailure: (failure) => {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      failures.push(`${failure.step} ${failure.kind}: ${mask(message, needles)}`);
    },
  });
  let attempts: Awaited<NonNullable<typeof runner.firstAttempts>>;
  try {
    if (runner.firstAttempts === undefined) throw new Error('The runner has no first attempts.');
    attempts = await runner.firstAttempts;
  } finally {
    await runner.stop();
  }
  const [firstRefusal] = refused;
  if (firstRefusal !== undefined) throw new Refusal(firstRefusal);
  const scrubber = new Scrubber(live);
  const sourceIds = new Map<string, string>();
  for (const { source } of attempts) {
    const standSource = source
      .replace(/^jira:.*$/, `jira:${STAND.jiraId}`)
      .replace(
        new RegExp(`^github-issues:${STAND.issuesId}:.*$`),
        `github-issues:${STAND.issuesId}:${STAND.board}`,
      )
      .replace(
        /^github:([^:]+):(.*)$/,
        (_all, project: string, repo: string) =>
          `github:${project}:${scrubber.standRepo(repo) ?? 'unknown'}`,
      );
    sourceIds.set(source, standSource);
  }
  for (const { source, outcome } of attempts) {
    const name = sourceIds.get(source) ?? 'unknown';
    const batch = core.observed.find((entry) => entry.source === source)?.batch;
    if (outcome?.kind !== 'delivered' || batch?.complete !== true)
      throw new Refusal(
        `Source ${name} gave no complete batch${failures.length === 0 ? '' : `: ${failures.join('; ')}`}.`,
      );
  }

  const drafts = new Map<string, DraftRecording>();
  for (const exchange of raw) {
    const system = systemOf(live, exchange.url);
    const source = sourceOf(scrubber, system, exchange);
    if (isPaging(system, exchange))
      throw new Refusal(`Source ${source} pages; the stand fakes take only their own cursors.`);
    const draft = drafts.get(source) ?? { source, exchanges: [] };
    drafts.set(source, draft);
    const at = `${RECORDING_FILES[source] ?? source}: exchanges[${String(draft.exchanges.length)}].response`;
    // The answer first: the field list sets the sprint field the search request is mapped with.
    const response: Draft = {
      status: exchange.status,
      headers: draftHeaders(exchange.responseHeaders),
      body: draftResponse(scrubber, system, exchange, at),
    };
    const request: Draft = {
      method: exchange.method,
      url: scrubber.requestUrl(system, exchange.url),
      headers: requestHeaders(exchange.headers),
      body: scrubber.requestBody(system, exchange.body),
    };
    draft.exchanges.push({ request, response });
  }

  const placeholders = new Placeholders();
  const recordings = new Map<string, Recording>();
  for (const source of Object.keys(RECORDING_FILES).sort()) {
    const draft = drafts.get(source);
    if (draft === undefined) throw new Refusal(`Source ${source} sent no request.`);
    const value = placeholders.resolve({
      source,
      recordedAt,
      observe: { prs: [], tickets: [], sessions: source === 'spur' ? [{ ...probe }] : [] },
      ...(source === `jira:${STAND.jiraId}`
        ? {
            tracker: {
              doneStatuses: [
                ...new Set(live.jira.doneStatuses.map((n) => scrubber.standStatus(n))),
              ],
              readyStatuses: [
                ...new Set(live.jira.readyStatuses.map((n) => scrubber.standStatus(n))),
              ],
            },
          }
        : {}),
      exchanges: draft.exchanges,
    });
    recordings.set(source, recordingSchema.parse(value));
  }
  if (![...recordings.values()].some(hasDetailNode))
    throw new Refusal('No pull request detail was recorded: the operator has no open PR.');
  checkAll(recordings, needles);

  const files: string[] = [];
  for (const [source, recording] of recordings) {
    const file = join(options.outDir, RECORDING_FILES[source] ?? '');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    files.push(file);
  }
  return files;
}

/** The system a stand source id belongs to. */
export const systemOfSource = (source: string): System =>
  source === 'spur'
    ? 'spur'
    : source.startsWith('jira:')
      ? 'jira'
      : source.startsWith('github-issues:')
        ? 'github-issues'
        : 'github-pr';

/**
 * The first leak in a run's recordings, by source id, or undefined: `scan` over each, then rule 4
 * over the Jira keys of all of them, which must number 1..N as the recorder numbers them.
 */
export function scanRecordings(
  recordings: ReadonlyMap<string, unknown>,
  needles: Needles,
): (Hit & { file: string }) | undefined {
  const keys: (KeySeen & { file: string })[] = [];
  for (const [source, recording] of recordings) {
    const file = RECORDING_FILES[source] ?? source;
    const seen: KeySeen[] = [];
    const hit = scan(recording, needles, systemOfSource(source), seen);
    if (hit !== undefined) return { file, ...hit };
    keys.push(...seen.map((key) => ({ file, ...key })));
  }
  // N distinct numbers all within 1..N are exactly 1..N.
  const count = new Set(keys.map(({ n }) => n)).size;
  const outside = keys.find(({ n }) => n < 1 || n > count);
  return outside === undefined
    ? undefined
    : { file: outside.file, path: outside.path, rule: SHAPE };
}

function checkAll(recordings: ReadonlyMap<string, Recording>, needles: Needles): void {
  const hit = scanRecordings(recordings, needles);
  if (hit !== undefined)
    throw new Refusal(`${hit.file} holds a live value at ${hit.path} by ${hit.rule}.`);
}

/** `--check`: the same scan, offline, over the committed files. Returns the exit code. */
function checkRecordings(options: {
  paths: Paths;
  outDir: string;
  writeErr: (text: string) => void;
}): number {
  try {
    const { config, secrets } = loadLive(options.paths);
    const recordings = new Map<string, Recording>();
    for (const [source, name] of Object.entries(RECORDING_FILES)) {
      let text: string;
      try {
        text = readFileSync(join(options.outDir, name), 'utf8');
      } catch {
        throw new Refusal(`${name} is missing.`);
      }
      const parsed = recordingSchema.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.source !== source)
        throw new Refusal(`${name} is not a recording of ${source}.`);
      recordings.set(source, parsed.data);
    }
    checkAll(recordings, needlesOf(config, secrets));
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    options.writeErr(`record:fakes --check refused: ${error.message}\n`);
    return 1;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const writeErr = (text: string): void => {
    process.stderr.write(text);
  };
  const outDir = fileURLToPath(new URL('../recordings/', import.meta.url));
  const paths = resolvePaths(process.env, homedir());
  if (argv.length === 1 && argv[0] === '--check')
    return checkRecordings({ paths, outDir, writeErr });
  if (argv.length > 0) {
    writeErr('usage: pnpm record:fakes [--check]\n');
    return 2;
  }
  const files: string[] = [];
  const code = await record(
    { paths, fetch, outDir, now: () => Date.now(), env: process.env, writeErr },
    files,
  );
  if (code !== 0) return code;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const prettier = spawnSync(join(root, 'node_modules/.bin/prettier'), ['--write', ...files], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (prettier.status !== 0) {
    writeErr('prettier failed on the recordings.\n');
    return 1;
  }
  for (const args of [
    ['status', '--porcelain', '--', outDir],
    ['diff', '--no-color', '--', outDir],
  ])
    spawnSync('git', args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `record:fakes: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
