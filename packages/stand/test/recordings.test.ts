// The contract test of the stand's fakes against responses recorded from the live systems by
// `pnpm record:fakes` (packages/stand/src/record.ts). A failure here after an adapter request
// change means the recordings need a refresh on the maintainer's machine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startAdapters, type PollFailure } from '@spur-board/adapters';
import { createFakeCore, type FakeCore } from '@spur-board/adapters/testing';
import { configSchema, type Batch, type Config } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeSpur } from '../src/fake-spur.ts';
import { createFakes } from '../src/fakes/fetch.ts';
import { createGithubIssuesFake } from '../src/fakes/github-issues.ts';
import { createGithubPrFake } from '../src/fakes/github-pr.ts';
import { createJiraFake } from '../src/fakes/jira.ts';
import { RECORDING_FILES, recordingSchema, type Recording } from '../src/record.ts';
import { standConfig } from '../src/stand.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Exchange = Recording['exchanges'][number];

const SECRETS = {
  GITHUB_TOKEN: 'stand-dummy-github',
  JIRA_EMAIL: 'stand@stand.invalid',
  JIRA_API_TOKEN: 'stand-dummy-jira',
};
const JIRA_SOURCE = 'jira:stand-jira';
const REFRESH = 'refresh with pnpm record:fakes';
/** The fake emits stand-made strings, not the recording's live ones: these differ by design. */
const JIRA_STATUSES = ['To Do', 'Ready for Dev', 'In Progress', 'In Review', 'Done'];

type System = 'spur' | 'github-pr' | 'github-issues' | 'jira';
const systemOf = (source: string): System =>
  source === 'spur'
    ? 'spur'
    : source.startsWith('jira:')
      ? 'jira'
      : source.startsWith('github-issues:')
        ? 'github-issues'
        : 'github-pr';

/** Keys a fake cannot model yet; each entry also covers the paths under it. */
const KNOWN_OMISSIONS: readonly { system: System; path: string; reason: string }[] = [
  { system: 'spur', path: '[].slots', reason: 'The Spur fake publishes no session links.' },
  {
    system: 'github-issues',
    path: '[].pull_request',
    reason: 'The Issues fake lists no pull requests among the issues.',
  },
  { system: 'github-issues', path: '[].assignee', reason: 'The Issues fake assigns nobody.' },
  {
    system: 'jira',
    path: 'issues[].fields.assignee',
    reason: 'The Jira fake assigns nobody.',
  },
  {
    system: 'jira',
    path: `issues[].fields.customfield_10020`,
    reason: 'The Jira fake puts no ticket in a sprint.',
  },
  { system: 'jira', path: 'issues[].fields.labels[]', reason: 'The Jira fake labels no ticket.' },
];

const recordingsDir = fileURLToPath(new URL('../recordings/', import.meta.url));

function loadRecordings(): Map<string, Recording> {
  const recordings = new Map<string, Recording>();
  for (const [source, file] of Object.entries(RECORDING_FILES)) {
    const recording = recordingSchema.parse(
      JSON.parse(readFileSync(`${recordingsDir}${file}`, 'utf8')),
    );
    if (recording.source !== source) throw new Error(`${file} records ${recording.source}.`);
    recordings.set(source, recording);
  }
  return recordings;
}

const recordings = loadRecordings();
const recordedAt = Date.parse(recordings.get('spur')?.recordedAt ?? '');
const now = (): number => recordedAt;

function canonical(value: Json): string {
  const sort = (item: Json): Json =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key] ?? null)]),
          )
        : item;
  return JSON.stringify(sort(value));
}

/** A scalar as text, for names in messages and seeds. */
const text = (value: Json | undefined): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function at(value: Json | undefined, ...keys: (string | number)[]): Json | undefined {
  let current = value;
  for (const key of keys) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key];
    else if (isObject(current) && typeof key === 'string') current = current[key];
    else return undefined;
  }
  return current;
}

function nodes(value: Json | undefined): JsonObject[] {
  const list = at(value, 'nodes');
  return Array.isArray(list) ? list.filter(isObject) : [];
}

/** The replay config: the stand's, with the Jira statuses the live tracker was recorded with. */
function replayConfig(): Config {
  const raw = standConfig(0) as { projects: { id: string; tracker: Record<string, unknown> }[] };
  const tracker = recordings.get(JIRA_SOURCE)?.tracker;
  if (tracker === undefined) throw new Error('The Jira recording holds no tracker statuses.');
  for (const project of raw.projects)
    if (project.tracker['type'] === 'jira')
      Object.assign(project.tracker, {
        doneStatuses: tracker.doneStatuses,
        readyStatuses: tracker.readyStatuses,
      });
  return configSchema.parse(raw);
}

function requestOf(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? canonical(JSON.parse(init.body) as Json) : 'null';
  return { url: url.href, method, body };
}

/** A fetch that answers each recorded request once, by method, URL and canonical body. */
function replayFetch() {
  const pending = [...recordings.values()].flatMap(({ exchanges }) => [...exchanges]);
  const fetcher: typeof fetch = (input, init) => {
    const request = requestOf(input, init);
    const index = pending.findIndex(
      (exchange) =>
        exchange.request.method === request.method &&
        exchange.request.url === request.url &&
        canonical(exchange.request.body) === request.body,
    );
    const [exchange] = index === -1 ? [] : pending.splice(index, 1);
    if (exchange === undefined)
      return Promise.reject(
        new Error(`no recording for ${request.method} ${request.url}: ${REFRESH}`),
      );
    return Promise.resolve(
      new Response(JSON.stringify(exchange.response.body), {
        status: exchange.response.status,
        headers: exchange.response.headers,
      }),
    );
  };
  return { fetcher, pending };
}

// Seed transforms: what the fakes must hold to answer the recorded requests -----------------------

const without = (node: JsonObject, keys: readonly string[]): JsonObject =>
  Object.fromEntries(Object.entries(node).filter(([key]) => !keys.includes(key)));

/** A recorded PR detail node as the PR fake's `create` seed. */
function prSeed(node: JsonObject, updatedAt: Json | undefined): JsonObject {
  const seed = without(node, ['id', 'number', 'url', 'statusCheckRollup']);
  const rollup = node['statusCheckRollup'];
  seed['contexts'] = rollup === null ? [] : nodes(at(rollup, 'contexts'));
  seed['reviews'] = nodes(node['reviews']).map((review) => without(review, ['id']));
  seed['comments'] = nodes(node['comments']).map((comment) => without(comment, ['id']));
  seed['reviewThreads'] = nodes(node['reviewThreads']);
  seed['reviewRequests'] = nodes(node['reviewRequests']);
  if ('closingIssuesReferences' in node)
    seed['closingIssuesReferences'] = nodes(node['closingIssuesReferences']);
  if (updatedAt !== undefined) seed['updatedAt'] = updatedAt;
  return seed;
}

interface PrPlan {
  repo: string;
  discovery: JsonObject[];
  details: Map<number, JsonObject>;
  baseline: JsonObject[];
}

function prPlan(recording: Recording): PrPlan {
  const repo = recording.source.split(':')[2] ?? '';
  const plan: PrPlan = { repo, discovery: [], details: new Map(), baseline: [] };
  for (const { response } of recording.exchanges) {
    const data = at(response.body, 'data');
    if (!isObject(data)) continue;
    const repository = data['repository'];
    plan.discovery.push(...nodes(at(repository, 'pullRequests')));
    plan.baseline.push(...nodes(at(repository, 'mergedBaseline')));
    for (const [alias, root] of Object.entries(data)) {
      const pr = at(root, 'pullRequest');
      if (/^pr\d+$/.test(alias) && isObject(pr) && typeof pr['number'] === 'number')
        plan.details.set(pr['number'], pr);
    }
  }
  return plan;
}

function jiraStatus(status: Json | undefined, tracker: Recording['tracker']): string {
  const name = text(status);
  if (tracker?.doneStatuses.includes(name) === true) return 'Done';
  if (tracker?.readyStatuses.includes(name) === true) return 'Ready for Dev';
  return JIRA_STATUSES.includes(name) ? name : 'To Do';
}

/** Fresh fakes on the stand's config, seeded with what each recording shows. */
function seededFakes() {
  const config = configSchema.parse(standConfig(0));
  const jira = config.projects.flatMap(({ tracker }) => (tracker.type === 'jira' ? [tracker] : []));
  const fakes = createFakes({
    now,
    modules: [
      (clock) =>
        createGithubPrFake({ now: clock, repos: config.projects.flatMap(({ repos }) => repos) }),
      (clock) =>
        createGithubIssuesFake({
          now: clock,
          repos: config.projects.flatMap(({ tracker }) =>
            tracker.type === 'github-issues' ? [tracker.repo] : [],
          ),
        }),
      ...jira.map((tracker) => (clock: () => number) => createJiraFake({ now: clock, tracker })),
    ],
  });
  const spur = createFakeSpur({ baseUrl: config.adapters.spur.baseUrl, now, log: () => undefined });
  const seeds: { what: string; status: number; body: unknown }[] = [];
  const control = (system: string, verb: string, args: JsonObject, what: string): void => {
    const result =
      system === 'spur' ? spur.control(verb, args) : fakes.control({ system, verb, args });
    seeds.push({ what, ...result });
  };

  for (const recording of recordings.values()) {
    const system = systemOf(recording.source);
    const bodies = recording.exchanges.map(({ response }) => response.body);
    if (system === 'github-pr') {
      const plan = prPlan(recording);
      for (const node of plan.discovery) {
        const number = Number(node['number']);
        const detail = plan.details.get(number);
        const seed =
          detail === undefined
            ? {
                updatedAt: node['updatedAt'] ?? null,
                author: node['author'] ?? null,
                state: node['state'] ?? null,
              }
            : prSeed(detail, node['updatedAt']);
        control(
          'github',
          'create',
          { repo: plan.repo, number, seed },
          `${plan.repo}#${String(number)}`,
        );
      }
      const [baseline] = plan.baseline;
      if (baseline !== undefined) {
        const numbers = [
          ...plan.discovery.map((node) => Number(node['number'])),
          ...plan.details.keys(),
        ];
        const number = Math.max(0, ...numbers) + 1;
        control(
          'github',
          'create',
          {
            repo: plan.repo,
            number,
            seed: { state: 'MERGED', updatedAt: baseline['updatedAt'] ?? null },
          },
          `${plan.repo} merged baseline`,
        );
      }
    }
    if (system === 'github-issues') {
      const repo = recording.source.split(':')[2] ?? '';
      for (const issue of bodies.flatMap((body) =>
        Array.isArray(body) ? body.filter(isObject) : [],
      )) {
        if ('pull_request' in issue) continue;
        const target = { repo, number: issue['number'] ?? null };
        const what = `${repo}#${text(issue['number'])}`;
        control('github', 'issue-open', { ...target, title: issue['title'] ?? null }, what);
        const labels = Array.isArray(issue['labels'])
          ? issue['labels'].filter(isObject).map((label) => label['name'] ?? null)
          : [];
        if (labels.length > 0) control('github', 'issue-label', { ...target, labels }, what);
        const milestone = at(issue['milestone'], 'title');
        if (milestone !== undefined && milestone !== null)
          control('github', 'issue-milestone', { ...target, milestone }, what);
      }
    }
    if (system === 'jira')
      for (const body of bodies)
        for (const ticket of Array.isArray(at(body, 'issues'))
          ? (at(body, 'issues') as Json[])
          : []) {
          if (!isObject(ticket)) continue;
          control(
            'jira',
            'issue',
            {
              key: ticket['key'] ?? null,
              title: at(ticket, 'fields', 'summary') ?? null,
              status: jiraStatus(at(ticket, 'fields', 'status', 'name'), recording.tracker),
            },
            text(ticket['key']),
          );
        }
    if (system === 'spur') {
      const [list] = bodies;
      for (const session of Array.isArray(list) ? list.filter(isObject) : []) {
        const status = text(session['status']);
        control(
          'spur',
          'session',
          {
            id: session['id'] ?? null,
            project: session['project'] ?? null,
            status,
            state: session['state'] ?? null,
            ...(typeof session['branch'] === 'string' ? { branch: session['branch'] } : {}),
            ...(typeof session['stopReason'] === 'string'
              ? { stopReason: session['stopReason'] }
              : {}),
            ...(status === 'completed' || status === 'killed' ? { retain: true } : {}),
          },
          text(session['id']),
        );
      }
    }
  }
  return { config, fakes, spur, seeds, fetch: fakes.wrap(spur.fetch) };
}

// Polling through the real adapters ------------------------------------------------------------

async function pollOnce(config: Config, fetcher: typeof fetch) {
  const failures: PollFailure[] = [];
  const core: FakeCore = createFakeCore({
    context: (source) => {
      const observe = recordings.get(source)?.observe;
      return {
        observe: {
          prs: [],
          tickets: [],
          sessions: observe?.sessions.map((ref) => ({ ...ref })) ?? [],
        },
      };
    },
  });
  const runner = startAdapters(config, core, {
    secrets: SECRETS,
    fetch: fetcher,
    now,
    oneShot: true,
    onPollFailure: (failure) => failures.push(failure),
  });
  try {
    const attempts = (await runner.firstAttempts) ?? [];
    return { attempts, core, failures };
  } finally {
    await runner.stop();
  }
}

function itemKey(item: Batch['items'][number]): string {
  if (item.kind === 'pr') return `${item.facts.repo}#${String(item.facts.number)}`;
  if (item.kind === 'ticket') return item.facts.key;
  return item.facts.id;
}

function summary(core: FakeCore) {
  return Object.fromEntries(
    core.observed.map(({ source, batch }) => [
      source,
      {
        complete: batch.complete,
        keys: batch.items.map(itemKey).sort(),
        ...(source.startsWith('github:') ? { cursor: batch.cursor } : {}),
      },
    ]),
  );
}

function expectDelivered(result: Awaited<ReturnType<typeof pollOnce>>): void {
  expect(result.failures.map(({ source, step, kind }) => `${source} ${step} ${kind}`)).toEqual([]);
  expect(
    result.attempts.map(({ source, outcome }) => `${source} ${outcome?.kind ?? 'none'}`).sort(),
  ).toEqual(
    Object.keys(RECORDING_FILES)
      .map((source) => `${source} delivered`)
      .sort(),
  );
  expect(result.core.observed.map(({ source }) => source).sort()).toEqual(
    Object.keys(RECORDING_FILES).sort(),
  );
  for (const { source, batch } of result.core.observed) expect(batch.complete, source).toBe(true);
}

// Shape comparison ------------------------------------------------------------------------------

type Shape = Map<string, Set<string>>;

function shapeOf(value: Json, path = '', out: Shape = new Map()): Shape {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = out.get(path) ?? new Set<string>();
  types.add(type);
  out.set(path, types);
  if (Array.isArray(value)) for (const item of value) shapeOf(item, `${path}[]`, out);
  else if (isObject(value)) {
    const typename = typeof value['__typename'] === 'string' ? `<${value['__typename']}>` : '';
    for (const [key, item] of Object.entries(value)) {
      // Each alias holds one PR detail: `pr0`, `pr1` and so on share one shape.
      const name = /^pr\d+$/.test(key) ? 'pr*' : key;
      shapeOf(item, `${path}${typename}${path === '' && typename === '' ? '' : '.'}${name}`, out);
    }
  }
  return out;
}

/**
 * The paths where `fake` differs from `recorded` by type: a key or type the fake emits that the
 * recording lacks, a recorded key the fake lacks, or a fake null or empty list over a recorded
 * value. A recorded null matches any fake value. Values are never compared.
 */
function shapeDiff(recorded: Json, fake: Json, omitted: readonly string[] = []): string[] {
  const left = shapeOf(recorded);
  const right = shapeOf(fake);
  const isOmitted = (path: string): boolean =>
    omitted.some(
      (prefix) =>
        path === prefix || (/^[.[<]/.test(path.slice(prefix.length)) && path.startsWith(prefix)),
    );
  const diffs: string[] = [];
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    if (isOmitted(path)) continue;
    const shown = path === '' ? '(root)' : path;
    const want = left.get(path);
    const got = right.get(path);
    if (want === undefined) {
      diffs.push(`${shown}: the fake emits ${[...(got ?? [])].join('|')}, the recording has none`);
      continue;
    }
    if (got === undefined) {
      diffs.push(`${shown}: the recording has ${[...want].join('|')}, the fake has none`);
      continue;
    }
    const wanted = [...want].filter((type) => type !== 'null');
    const given = [...got].filter((type) => type !== 'null');
    if (wanted.length === 0) continue;
    if (given.length === 0) diffs.push(`${shown}: the fake has null over ${wanted.join('|')}`);
    const extra = given.filter((type) => !wanted.includes(type));
    if (extra.length > 0)
      diffs.push(`${shown}: the fake emits ${extra.join('|')} over ${wanted.join('|')}`);
  }
  return diffs;
}

/** Sends every recorded request, with the auth each fake checks, to freshly seeded fakes. */
async function askFakes() {
  const seeded = seededFakes();
  const basic = `Basic ${Buffer.from(`${SECRETS.JIRA_EMAIL}:${SECRETS.JIRA_API_TOKEN}`).toString('base64')}`;
  const answers: { source: string; exchange: Exchange; status: number; body: Json }[] = [];
  for (const recording of recordings.values()) {
    const system = systemOf(recording.source);
    for (const exchange of recording.exchanges) {
      const { method, url, headers, body } = exchange.request;
      const auth =
        system === 'jira'
          ? { authorization: basic }
          : system === 'spur'
            ? {}
            : { authorization: `Bearer ${SECRETS.GITHUB_TOKEN}` };
      const response = await seeded.fetch(url, {
        method,
        headers: { ...headers, ...auth },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      answers.push({
        source: recording.source,
        exchange,
        status: response.status,
        body: (await response.json()) as Json,
      });
    }
  }
  return { seeded, answers };
}

describe('stand fakes against the recorded live responses', () => {
  it('has a recording of every source', () => {
    expect([...recordings.keys()].sort()).toEqual(Object.keys(RECORDING_FILES).sort());
    for (const recording of recordings.values())
      expect(recording.exchanges.length, recording.source).toBeGreaterThan(0);
    const details = [...recordings.values()]
      .filter(({ source }) => systemOf(source) === 'github-pr')
      .reduce((count, recording) => count + prPlan(recording).details.size, 0);
    expect(details).toBeGreaterThan(0);
    expect(new Set([...recordings.values()].map((recording) => recording.recordedAt)).size).toBe(1);
  });

  it('replays recordings through the real adapters', async () => {
    const replay = replayFetch();
    const result = await pollOnce(replayConfig(), replay.fetcher);
    expectDelivered(result);
    expect(replay.pending.map(({ request }) => `${request.method} ${request.url}`)).toEqual([]);
  });

  it('seeded fakes answer the real adapters', async () => {
    const replayed = await pollOnce(replayConfig(), replayFetch().fetcher);
    const seeded = seededFakes();
    expect(seeded.seeds.filter(({ status }) => status !== 200)).toEqual([]);
    const result = await pollOnce(seeded.config, seeded.fetch);
    expectDelivered(result);
    expect(summary(result.core)).toEqual(summary(replayed.core));
    expect(seeded.fakes.violations().items).toEqual([]);
    expect(seeded.spur.violations().items).toEqual([]);
  });

  it('every recorded PR is a valid fake seed', () => {
    const config = configSchema.parse(standConfig(0));
    const fakes = createFakes({
      now,
      modules: [
        (clock) =>
          createGithubPrFake({ now: clock, repos: config.projects.flatMap(({ repos }) => repos) }),
      ],
    });
    let count = 0;
    for (const recording of recordings.values()) {
      if (systemOf(recording.source) !== 'github-pr') continue;
      const plan = prPlan(recording);
      for (const [number, node] of plan.details) {
        const args = { repo: plan.repo, number, seed: prSeed(node, undefined) };
        const result = fakes.control({ system: 'github', verb: 'create', args });
        expect(result, `${plan.repo}#${String(number)}`).toMatchObject({ status: 200 });
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('the fakes accept every recorded request', async () => {
    const { seeded, answers } = await askFakes();
    expect(
      answers
        .filter(({ exchange, status }) => status !== exchange.response.status)
        .map(
          ({ exchange, status }) =>
            `${exchange.request.method} ${exchange.request.url}: ${String(status)}`,
        ),
    ).toEqual([]);
    // A GraphQL error answers 200: an unknown PR or field would show here.
    expect(answers.filter(({ body }) => isObject(body) && 'errors' in body)).toEqual([]);
    expect(seeded.fakes.violations().total).toBe(0);
    expect(seeded.spur.violations().total).toBe(0);
  });

  it('fake responses have the recorded shape', async () => {
    const { answers } = await askFakes();
    const diffs = answers.flatMap(({ source, exchange, body }) => {
      const system = systemOf(source);
      const omitted = KNOWN_OMISSIONS.filter((entry) => entry.system === system).map(
        ({ path }) => path,
      );
      return shapeDiff(exchange.response.body, body, omitted).map(
        (diff) => `${source} ${exchange.request.method} ${exchange.request.url} ${diff}`,
      );
    });
    expect(diffs).toEqual([]);
  });

  it('a renamed key or changed type is a shape difference', async () => {
    const { answers } = await askFakes();
    const answer = (source: string, path: string) => {
      const found = answers.find(
        (entry) => entry.source === source && new URL(entry.exchange.request.url).pathname === path,
      );
      if (found === undefined) throw new Error(`No answer for ${source} ${path}`);
      return found;
    };
    const spur = answer('spur', '/sessions');
    const renamed = (spur.body as JsonObject[]).map(({ lastActivityAt, ...rest }) => ({
      ...rest,
      lastActiveAt: lastActivityAt ?? null,
    }));
    expect(shapeDiff(spur.exchange.response.body, renamed, ['[].slots'])).toEqual([
      '[].lastActivityAt: the recording has string, the fake has none',
      '[].lastActiveAt: the fake emits string, the recording has none',
    ]);

    const issues = answer('github-issues:stand:stand-org/board', '/repos/stand-org/board/issues');
    const stringly = (issues.body as JsonObject[]).map((issue) => ({
      ...issue,
      number: text(issue['number']),
    }));
    expect(
      shapeDiff(issues.exchange.response.body, stringly, ['[].pull_request', '[].assignee']),
    ).toEqual(['[].number: the fake emits string over number']);

    const search = answer(JIRA_SOURCE, '/rest/api/3/search/jql');
    const body = search.body as { issues: JsonObject[] };
    const nulled = {
      ...body,
      issues: body.issues.map((issue) => ({
        ...issue,
        fields: { ...(issue['fields'] as JsonObject), summary: null },
      })),
    };
    expect(
      shapeDiff(
        search.exchange.response.body,
        nulled,
        KNOWN_OMISSIONS.filter(({ system }) => system === 'jira').map(({ path }) => path),
      ),
    ).toEqual(['issues[].fields.summary: the fake has null over string']);
  });
});
