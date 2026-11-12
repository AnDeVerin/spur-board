import { configSchema, type Batch, type Config, type TicketFacts } from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJiraAdapter } from '../../adapters/src/jira/jira.ts';
import { createFakes, type Fakes } from '../src/fakes/fetch.ts';
import { createGithubIssuesFake } from '../src/fakes/github-issues.ts';
import { createJiraFake } from '../src/fakes/jira.ts';
import { standConfig } from '../src/stand.ts';
import { BOARD, fakeFetch, NOW, pollContext, violations } from './fake-helpers.ts';

type JiraTracker = Extract<Config['projects'][number]['tracker'], { type: 'jira' }>;

const SOURCE = 'jira:stand-jira';
const BASE = 'https://jira.stand.invalid';
const API = `${BASE}/rest/api/3`;
const AUTHORIZATION = `Basic ${Buffer.from('stand@stand.invalid:dummy').toString('base64')}`;
const HEADERS = { accept: 'application/json', authorization: AUTHORIZATION };
const POST_HEADERS = { ...HEADERS, 'content-type': 'application/json' };
const FIELDS = ['summary', 'status', 'assignee', 'labels', 'updated', 'customfield_10020'];

const STAND_TRACKER: JiraTracker = (() => {
  const config = configSchema.parse(standConfig(0));
  const project = config.projects.find(({ tracker }) => tracker.type === 'jira');
  if (project?.tracker.type !== 'jira') throw new Error('No Jira tracker');
  return project.tracker;
})();
/** Two projects, one filter: OPS tickets sit outside it. */
const TWO_KEYS: JiraTracker = { ...STAND_TRACKER, projectKeys: ['STAND', 'OPS'] };

let fakes: Fakes;

function jiraFakes(tracker: JiraTracker = STAND_TRACKER, now: () => number = () => NOW): Fakes {
  return createFakes({ now, modules: [(clock) => createJiraFake({ now: clock, tracker })] });
}

beforeEach(() => {
  fakes = jiraFakes();
});

afterEach(() => {
  expect(violations(fakes)).toEqual([]);
});

interface Sent {
  method: string;
  path: string;
  jql?: string;
}

/** Polls once through the real Jira adapter; `sent` records each request it made. */
function pollJira(
  options: {
    tracker?: JiraTracker;
    tickets?: { key: string; id?: string }[];
    sent?: Sent[];
  } = {},
): Promise<Batch> {
  const inner = fakeFetch(fakes);
  const recorded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { jql: string }) : null;
    options.sent?.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(body === null ? {} : { jql: body.jql }),
    });
    return inner(input, init);
  };
  const adapter = createJiraAdapter({
    id: SOURCE,
    tracker: () => options.tracker ?? STAND_TRACKER,
    credentials: { email: 'stand@stand.invalid', token: 'dummy' },
    now: () => NOW,
    fetch: recorded,
    warn: () => undefined,
  });
  return adapter.poll(
    pollContext({
      observe: {
        prs: [],
        tickets: (options.tickets ?? []).map((ref) => ({
          kind: 'ticket',
          trackerId: SOURCE,
          ...ref,
        })),
        sessions: [],
      },
    }),
  );
}

function ticket(key: string, extra: Record<string, unknown> = {}) {
  return fakes.control({ system: 'jira', verb: 'issue', args: { key, ...extra } });
}

function ok(result: { status: number; body: unknown }): void {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

function facts(batch: Batch): TicketFacts[] {
  return batch.items.flatMap((item) => (item.kind === 'ticket' ? [item.facts] : []));
}

const byKey = (batch: Batch, key: string): TicketFacts | undefined =>
  facts(batch).find((item) => item.key === key);

function search(body: unknown, headers: Record<string, string> = POST_HEADERS) {
  return fakeFetch(fakes)(`${API}/search/jql`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('verbs', () => {
  it('issue creates a ticket the real adapter lists with a numeric id, key, title and To Do', async () => {
    ok(ticket('STAND-1', { title: 'Stand ticket one' }));
    const batch = await pollJira();
    expect(batch.complete).toBe(true);
    expect(facts(batch)).toHaveLength(1);
    const [only] = facts(batch);
    expect(only).toMatchObject({
      trackerId: SOURCE,
      key: 'STAND-1',
      title: 'Stand ticket one',
      status: 'To Do',
      assignee: null,
      sprint: null,
      labels: [],
      inFilter: true,
      url: `${BASE}/browse/STAND-1`,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(only?.id).toMatch(/^\d+$/);
  });

  it('issue --status and --title change the polled ticket and keep its id', async () => {
    ok(ticket('STAND-1'));
    const before = byKey(await pollJira(), 'STAND-1')?.id;
    ok(ticket('STAND-1', { status: 'In Progress' }));
    ok(ticket('STAND-1', { title: 'Renamed' }));
    expect(byKey(await pollJira(), 'STAND-1')).toMatchObject({
      id: before,
      title: 'Renamed',
      status: 'In Progress',
    });
    ok(ticket('STAND-1', { status: 'Done', title: 'Both' }));
    expect(byKey(await pollJira(), 'STAND-1')).toMatchObject({
      id: before,
      title: 'Both',
      status: 'Done',
    });
  });

  it('refuses an unlisted status, an unknown project, a malformed key and extra arguments', () => {
    const refused = ticket('STAND-1', { status: 'Blocked' });
    expect(refused.status).toBe(400);
    expect((refused.body as { statuses: string[] }).statuses).toEqual(
      expect.arrayContaining(['To Do', 'Done']),
    );
    expect(ticket('OPS-1').status).toBe(400);
    expect(ticket('stand-1').status).toBe(400);
    expect(ticket('STAND-0').status).toBe(400);
    expect(ticket('STAND').status).toBe(400);
    expect(ticket('STAND-1', { labels: ['x'] }).status).toBe(400);
    expect(ticket('STAND-1', { title: '' }).status).toBe(400);
    expect(fakes.control({ system: 'jira', verb: 'nope', args: {} }).status).toBe(400);
  });

  it('answers 409 for an existing key with no field to change', () => {
    ok(ticket('STAND-1'));
    expect(ticket('STAND-1').status).toBe(409);
  });

  it('moves updatedAt strictly forward under a fixed clock', () => {
    const at = (result: { body: unknown }): number =>
      Date.parse((result.body as { updatedAt: string }).updatedAt);
    expect(at(ticket('STAND-1'))).toBe(NOW);
    expect(at(ticket('STAND-1', { status: 'In Review' }))).toBe(NOW + 1);
    expect(at(ticket('STAND-1', { title: 'Again' }))).toBe(NOW + 2);
  });

  it('numbers ids from 10001, and reset clears the tickets and the counter', async () => {
    ok(ticket('STAND-1'));
    ok(ticket('STAND-2'));
    expect(
      facts(await pollJira())
        .map(({ id }) => id)
        .sort(),
    ).toEqual(['10001', '10002']);
    fakes.reset();
    expect(facts(await pollJira())).toEqual([]);
    ok(ticket('STAND-7'));
    expect(byKey(await pollJira(), 'STAND-7')?.id).toBe('10001');
  });
});

describe('detail', () => {
  it('answers pending and known refs inside and outside the filter, and missing ones', async () => {
    fakes = jiraFakes(TWO_KEYS);
    ok(ticket('STAND-1'));
    ok(ticket('OPS-1'));
    ok(ticket('OPS-2'));
    const ops2 = (ticket('OPS-2', { title: 'Known' }).body as { id: string }).id;
    const sent: Sent[] = [];
    const batch = await pollJira({
      tracker: TWO_KEYS,
      sent,
      tickets: [
        { key: 'STAND-1' },
        { key: 'OPS-1' },
        { key: 'STAND-99' },
        { key: 'OPS-2', id: ops2 },
        { key: 'STAND-98', id: '99999' },
      ],
    });
    expect(batch.complete).toBe(true);
    expect(
      batch.entities.map(({ ref, status }) => [ref.kind === 'ticket' ? ref.key : '', status]),
    ).toEqual([
      ['STAND-1', 'ok'],
      ['OPS-1', 'ok'],
      ['STAND-99', 'not_found'],
      ['OPS-2', 'ok'],
      ['STAND-98', 'not_found'],
    ]);
    expect(byKey(batch, 'STAND-1')?.inFilter).toBe(true);
    expect(byKey(batch, 'OPS-1')?.inFilter).toBe(false);
    expect(byKey(batch, 'OPS-2')).toMatchObject({ id: ops2, title: 'Known', inFilter: false });
    expect(sent.filter(({ path }) => path.startsWith('/rest/api/3/issue/'))).toEqual([
      { method: 'GET', path: '/rest/api/3/issue/OPS-1' },
      { method: 'GET', path: '/rest/api/3/issue/STAND-99' },
      { method: 'GET', path: '/rest/api/3/issue/99999' },
    ]);
    expect(sent.flatMap(({ jql }) => (jql === undefined ? [] : [jql]))).toEqual([
      'project = STAND',
      'key in ("OPS-2", "STAND-98")',
      'key in ("OPS-2")',
      'key in ("STAND-98")',
    ]);
  });

  it('answers detail by key and by id with the same ticket, and 404 for a missing one', async () => {
    ok(ticket('STAND-1', { title: 'Detail' }));
    const get = (ref: string) => fakeFetch(fakes)(`${API}/issue/${ref}`, { headers: HEADERS });
    const byKeyBody = (await (await get('STAND-1')).json()) as { id: string; key: string };
    expect(byKeyBody).toMatchObject({ key: 'STAND-1', fields: { summary: 'Detail' } });
    expect(await (await get(byKeyBody.id)).json()).toEqual(byKeyBody);
    const missing = await get('STAND-2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      errorMessages: [expect.any(String)],
      errors: {},
    });
    expect((await get('10999')).status).toBe(404);
  });
});

describe('pagination', () => {
  it('serves 101 tickets over two pages, which the real adapter reads completely', async () => {
    for (let n = 1; n <= 101; n += 1) ok(ticket(`STAND-${String(n)}`));
    const first = (await (
      await search({ jql: 'project = STAND', maxResults: 100, fields: FIELDS })
    ).json()) as { issues: unknown[]; nextPageToken?: string; isLast: boolean };
    expect(first.issues).toHaveLength(100);
    expect(first.isLast).toBe(false);
    expect(first.nextPageToken).toEqual(expect.any(String));
    const second = (await (
      await search({
        jql: 'project = STAND',
        maxResults: 100,
        fields: FIELDS,
        nextPageToken: first.nextPageToken,
      })
    ).json()) as { issues: unknown[]; nextPageToken?: string; isLast: boolean };
    expect(second).toMatchObject({ isLast: true });
    expect(second.issues).toHaveLength(1);
    expect(second.nextPageToken).toBeUndefined();

    const batch = await pollJira();
    expect(batch.complete).toBe(true);
    expect(new Set(facts(batch).map(({ key }) => key)).size).toBe(101);
  });
});

describe('matching', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    jql: 'project = STAND',
    maxResults: 100,
    fields: FIELDS,
    ...extra,
  });
  const get = (path: string, headers: Record<string, string> = HEADERS, method = 'GET') =>
    fakeFetch(fakes)(`${API}${path}`, { method, headers });

  it.each<[string, () => Promise<Response>]>([
    ['unknown path', () => get('/myself')],
    [
      'path outside the API',
      () => fakeFetch(fakes)(`${BASE}/browse/STAND-1`, { headers: HEADERS }),
    ],
    ['transitions', () => get('/issue/STAND-1/transitions')],
    ['GET search', () => get('/search/jql')],
    ['POST statuses', () => get('/project/STAND/statuses', POST_HEADERS, 'POST')],
    ['statuses of a key outside projectKeys', () => get('/project/OPS/statuses')],
    ['query string on statuses', () => get('/project/STAND/statuses?x=1')],
    ['query string on field', () => get('/field?x=1')],
    ['query string on detail', () => get('/issue/STAND-1?fields=summary')],
    [
      'query string on search',
      () =>
        fakeFetch(fakes)(`${API}/search/jql?x=1`, {
          method: 'POST',
          headers: POST_HEADERS,
          body: JSON.stringify(body()),
        }),
    ],
    ['other JQL', () => search(body({ jql: 'project = OPS' }))],
    ['JQL with ORDER BY', () => search(body({ jql: 'project = STAND ORDER BY key' }))],
    [
      'membership of another filter',
      () => search(body({ jql: '(project = OPS) AND key in ("STAND-1")' })),
    ],
    ['extra body key', () => search(body({ startAt: 0 }))],
    ['maxResults other than 100', () => search(body({ maxResults: 50 }))],
    ['missing field', () => search(body({ fields: FIELDS.slice(1) }))],
    ['extra field', () => search(body({ fields: [...FIELDS, 'priority'] }))],
    ['duplicate field', () => search(body({ fields: [...FIELDS.slice(1), 'status'] }))],
    ['unknown page token', () => search(body({ nextPageToken: 'abc' }))],
    ['non-JSON body', () => search('jql=project')],
    ['missing Accept', () => get('/field', { authorization: AUTHORIZATION })],
    ['non-Basic Authorization', () => get('/field', { ...HEADERS, authorization: 'Bearer x' })],
    ['POST without Content-Type', () => search(body(), HEADERS)],
  ])('logs one violation and refuses: %s', async (_name, send) => {
    const response = await send();
    expect(response.status).toBe(400);
    const logged = fakes.violations().items;
    expect(logged).toEqual([expect.objectContaining({ system: 'jira' })]);
    expect(JSON.stringify(logged)).not.toContain(AUTHORIZATION.slice('Basic '.length));
    fakes.reset();
  });

  it.each<[string, string, number]>([
    ['keyQuery', 'key in ("STAND-1")', 1],
    ['membershipQuery', '(project = STAND) AND key in ("STAND-1")', 1],
    ['membershipQuery of a ticket outside the filter', '(project = STAND) AND key in ("OPS-1")', 0],
  ])('answers the %s form', async (_name, jql, count) => {
    fakes = jiraFakes(TWO_KEYS);
    ok(ticket('STAND-1'));
    ok(ticket('OPS-1'));
    const response = await search(body({ jql }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { issues: unknown[] }).issues).toHaveLength(count);
  });

  it('answers a key in naming a missing key with a Jira 400, not a violation', async () => {
    ok(ticket('STAND-1'));
    const response = await search(body({ jql: 'key in ("STAND-1", "STAND-2")' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errorMessages: [expect.stringContaining('STAND-2')],
      warningMessages: [],
    });
  });

  it('refuses to build from a JQL whose project is not in projectKeys', () => {
    expect(() =>
      createJiraFake({ now: () => NOW, tracker: { ...STAND_TRACKER, jql: 'project = OTHER' } }),
    ).toThrow('project = <KEY>');
    expect(() =>
      createJiraFake({ now: () => NOW, tracker: { ...STAND_TRACKER, jql: 'assignee = me' } }),
    ).toThrow('project = <KEY>');
  });

  it('logs one violation for a poll with another JQL, and the poll fails', async () => {
    await expect(
      pollJira({ tracker: { ...STAND_TRACKER, jql: 'project = OTHER' } }),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect(violations(fakes)).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('project = OTHER') as unknown }),
    ]);
    fakes.reset();
  });
});

describe('failure modes', () => {
  const fail = (args: Record<string, unknown>): void => {
    ok(fakes.control({ system: 'jira', verb: 'fail', args }));
  };

  it.each<[string, Record<string, unknown>, string]>([
    ['auth', { mode: 'auth' }, 'auth'],
    ['server-error', { mode: 'server-error' }, 'transient'],
    ['refuse', { mode: 'refuse' }, 'transient'],
  ])('%s fails the real adapter poll as %s', async (_name, args, kind) => {
    fail(args);
    await expect(pollJira()).rejects.toMatchObject({ kind });
  });

  it('rate-limit 30 throttles until now + 30 s', async () => {
    fail({ mode: 'rate-limit', seconds: 30 });
    await expect(pollJira()).rejects.toMatchObject({
      kind: 'throttled',
      retryAt: new Date(NOW + 30_000),
    });
    fail({ mode: 'clear' });
    expect((await pollJira()).complete).toBe(true);
  });

  it('a GitHub failure leaves a Jira poll succeeding', async () => {
    fakes = createFakes({
      now: () => NOW,
      modules: [
        (clock) => createJiraFake({ now: clock, tracker: STAND_TRACKER }),
        (clock) => createGithubIssuesFake({ now: clock, repos: [BOARD] }),
      ],
    });
    ok(fakes.control({ system: 'github', verb: 'fail', args: { mode: 'auth' } }));
    ok(ticket('STAND-1'));
    expect(facts(await pollJira())).toHaveLength(1);
  });
});
