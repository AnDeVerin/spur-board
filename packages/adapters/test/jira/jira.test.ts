import {
  AdapterError,
  batchSchema,
  type PollContext,
  type TicketEntityRef,
} from '@spur-board/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJiraAdapter } from '../../src/jira/jira.ts';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const BASE = 'https://jira.example.test';
const FIELD = 'customfield_10020';
const CREDENTIALS = { email: 'operator@example.test', token: 'synthetic-secret' };

function tracker() {
  return {
    type: 'jira' as const,
    baseUrl: BASE,
    jql: 'project = PROJ AND status != Closed',
    projectKeys: ['PROJ'],
    doneStatuses: ['Done'],
    readyStatuses: ['Ready'],
  };
}

function issue(
  id: string,
  key: string,
  sprint: unknown = [{ name: 'Sprint 12', state: 'active' }],
) {
  return {
    id,
    key,
    fields: {
      summary: `Synthetic ticket ${key}`,
      status: { name: 'Ready' },
      assignee: { accountId: 'user-123' },
      labels: ['demo'],
      updated: '2025-12-31T11:00:00.000+0000',
      [FIELD]: sprint,
    },
  };
}

function context(
  tickets: TicketEntityRef[] = [],
  signal = new AbortController().signal,
): PollContext {
  return { observe: { prs: [], tickets, sessions: [] }, signal };
}

function ref(id: string, key: string): TicketEntityRef {
  return { kind: 'ticket', trackerId: 'jira-proj', id, key };
}

interface Call {
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
  signal: AbortSignal | null;
}

function fake(
  search: (body: Record<string, unknown>) => unknown = () => ({ issues: [] }),
  statuses: () => unknown = () => [{ statuses: [{ name: 'Ready' }, { name: 'Done' }] }],
) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, body, headers, signal: init?.signal ?? null });
    let result: unknown;
    if (url.pathname.endsWith('/statuses')) result = statuses();
    else if (url.pathname.endsWith('/field'))
      result = [{ id: FIELD, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }];
    else if (url.pathname.endsWith('/search/jql')) result = search(body ?? {});
    else throw new Error(`Unexpected path ${url.pathname}`);
    if (result instanceof Response) return Promise.resolve(result);
    return Promise.resolve(Response.json(result));
  };
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch, current = tracker(), warn = vi.fn()) {
  return {
    source: createJiraAdapter({
      id: 'jira-proj',
      tracker: () => current,
      credentials: CREDENTIALS,
      fetch: fetcher,
      warn,
    }),
    warn,
  };
}

async function rejection(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw error;
  }
  throw new Error('Expected a Jira adapter failure');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Jira adapter', () => {
  it('walks the full JQL filter and normalizes stable ticket facts', async () => {
    const { fetcher, calls } = fake((body) => {
      if (body['nextPageToken'] === undefined)
        return { issues: [issue('100', 'PROJ-1')], nextPageToken: 'page-2' };
      if (body['nextPageToken'] === 'page-2')
        return {
          issues: [
            issue('101', 'PROJ-2', [
              { name: 'Old', state: 'closed' },
              { name: 'Next', state: 'future' },
            ]),
          ],
          nextPageToken: 'page-3',
        };
      return { issues: [issue('102', 'PROJ-3', [])], isLast: true };
    });
    const { source } = adapter(fetcher);
    const ctx = context();
    const result = await source.poll(ctx);

    expect(source.intervalMs).toBe(120_000);
    expect(batchSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      source: 'jira-proj',
      observedAt: NOW.toISOString(),
      complete: true,
      entities: [],
    });
    expect(result.items.map((item) => item.facts)).toEqual([
      {
        trackerId: 'jira-proj',
        id: '100',
        key: 'PROJ-1',
        title: 'Synthetic ticket PROJ-1',
        status: 'Ready',
        assignee: 'user-123',
        sprint: 'Sprint 12',
        labels: ['demo'],
        inFilter: true,
        url: `${BASE}/browse/PROJ-1`,
        updatedAt: '2025-12-31T11:00:00.000Z',
      },
      expect.objectContaining({ id: '101', key: 'PROJ-2', sprint: 'Next', inFilter: true }),
      expect.objectContaining({ id: '102', key: 'PROJ-3', sprint: null, inFilter: true }),
    ]);
    expect(
      calls
        .filter((call) => call.path.endsWith('/search/jql'))
        .map((call) => call.body?.['nextPageToken']),
    ).toEqual([undefined, 'page-2', 'page-3']);
    expect(calls[0]?.path).toBe('/rest/api/3/project/PROJ/statuses');
    expect(calls[1]?.path).toBe('/rest/api/3/field');
    expect(calls.every((call) => call.signal === ctx.signal)).toBe(true);
    expect(calls.every((call) => call.headers.get('authorization')?.startsWith('Basic '))).toBe(
      true,
    );
  });

  it('uses an active sprint from Jira legacy values and ignores closed-only history', async () => {
    const legacy =
      'Sprint@[id=12,rapidViewId=1,state=ACTIVE,name=Sprint Legacy,goal=Demo,startDate=2025-12-01]';
    const closed =
      'Sprint@[id=11,rapidViewId=1,state=CLOSED,name=Sprint Old,goal=Demo,startDate=2025-11-01]';
    const { fetcher } = fake(() => ({
      issues: [issue('100', 'PROJ-1', [closed, legacy]), issue('101', 'PROJ-2', [closed])],
      isLast: true,
    }));
    const result = await adapter(fetcher).source.poll(context());
    expect(
      result.items.filter((item) => item.kind === 'ticket').map((item) => item.facts.sprint),
    ).toEqual(['Sprint Legacy', null]);
  });

  it.each([true, false])('stops at page 20 (continuation %s)', async (continued) => {
    let pages = 0;
    const { fetcher, calls } = fake(() => {
      pages += 1;
      return {
        issues: [issue(String(pages), `PROJ-${String(pages)}`)],
        ...(pages < 20 || continued
          ? { nextPageToken: `page-${String(pages + 1)}` }
          : { isLast: true }),
      };
    });
    const { source, warn } = adapter(fetcher);
    const result = await source.poll(context());
    expect(calls.filter((call) => call.path.endsWith('/search/jql'))).toHaveLength(20);
    expect(result.items).toHaveLength(20);
    expect(result.complete).toBe(!continued);
    expect(warn).toHaveBeenCalledTimes(continued ? 1 : 0);
  });

  it.each([
    [
      'project = PROJ AND status != Closed',
      '(project = PROJ AND status != Closed) AND key in ("PROJ-21", "PROJ-200")',
    ],
    [
      'project = PROJ AND summary ~ "ORDER BY Rank" ORDER BY Rank DESC',
      '(project = PROJ AND summary ~ "ORDER BY Rank") AND key in ("PROJ-21", "PROJ-200") ORDER BY Rank DESC',
    ],
    ['ORDER BY Rank', 'key in ("PROJ-21", "PROJ-200") ORDER BY Rank'],
    ['  ORDER BY Rank', 'key in ("PROJ-21", "PROJ-200") ORDER BY Rank'],
  ])('checks capped-scan membership for JQL %s', async (jql, membershipJql) => {
    const current = tracker();
    current.jql = jql;
    let filterPages = 0;
    const { fetcher, calls } = fake((body) => {
      const requestedJql = String(body['jql']);
      if (requestedJql === current.jql) {
        filterPages += 1;
        return {
          issues: [issue(String(filterPages), `PROJ-${String(filterPages)}`)],
          nextPageToken: `page-${String(filterPages + 1)}`,
        };
      }
      if (requestedJql === membershipJql) return { issues: [issue('21', 'PROJ-21')], isLast: true };
      if (requestedJql === 'key in ("PROJ-200")')
        return { issues: [issue('200', 'PROJ-200')], isLast: true };
      throw new Error(`Unexpected JQL ${requestedJql}`);
    });
    const { source, warn } = adapter(fetcher, current);
    const result = await source.poll(context([ref('21', 'PROJ-21'), ref('200', 'PROJ-200')]));
    expect(batchSchema.safeParse(result).success).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.entities.map((entity) => entity.status)).toEqual(['ok', 'ok']);
    expect(
      result.items
        .filter((item) => item.kind === 'ticket')
        .filter((item) => ['21', '200'].includes(item.facts.id))
        .map((item) => [item.facts.id, item.facts.inFilter]),
    ).toEqual([
      ['21', true],
      ['200', false],
    ]);
    expect(filterPages).toBe(20);
    expect(calls.filter((call) => call.body?.['jql'] === membershipJql)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fetches outside tickets through every page before assigning per-ticket outcomes', async () => {
    const { fetcher, calls } = fake((body) => {
      if (String(body['jql']).startsWith('key in')) {
        if (!body['nextPageToken'])
          return { issues: [issue('200', 'PROJ-20')], nextPageToken: 'outside-2' };
        return { issues: [issue('201', 'PROJ-21')], isLast: true };
      }
      return { issues: [issue('100', 'PROJ-1')], isLast: true };
    });
    const { source } = adapter(fetcher);
    const result = await source.poll(
      context([
        ref('100', 'PROJ-1'),
        ref('200', 'PROJ-20'),
        ref('201', 'PROJ-21'),
        ref('202', 'PROJ-22'),
      ]),
    );
    expect(batchSchema.safeParse(result).success).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.entities.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok', 'not_found']);
    expect(
      result.items
        .filter((item) => item.kind === 'ticket')
        .map((item) => [item.facts.id, item.facts.inFilter]),
    ).toEqual([
      ['100', true],
      ['200', false],
      ['201', false],
    ]);
    const outside = calls.filter((call) => String(call.body?.['jql']).startsWith('key in'));
    expect(outside).toHaveLength(2);
    expect(outside[0]?.body?.['jql']).toBe('key in ("PROJ-20", "PROJ-21", "PROJ-22")');
    expect(outside[1]?.body?.['nextPageToken']).toBe('outside-2');
  });

  it('keeps valid tickets when an outside ticket is deleted or inaccessible', async () => {
    const { fetcher } = fake((body) =>
      String(body['jql']).startsWith('key in')
        ? { issues: [issue('200', 'PROJ-20')], isLast: true }
        : { issues: [issue('100', 'PROJ-1')], isLast: true },
    );
    const { source } = adapter(fetcher);
    const result = await source.poll(context([ref('200', 'PROJ-20'), ref('201', 'PROJ-21')]));
    expect(batchSchema.safeParse(result).success).toBe(true);
    expect(result.entities).toEqual([
      { ref: ref('200', 'PROJ-20'), status: 'ok' },
      { ref: ref('201', 'PROJ-21'), status: 'not_found' },
    ]);
    expect(
      result.items.filter((item) => item.kind === 'ticket').map((item) => item.facts.id),
    ).toEqual(['100', '200']);
  });

  it('fails an outside lookup that cannot reach its final page', async () => {
    let outsidePages = 0;
    const { fetcher } = fake((body) => {
      if (!String(body['jql']).startsWith('key in')) return { issues: [], isLast: true };
      outsidePages += 1;
      return { issues: [], nextPageToken: `outside-${String(outsidePages + 1)}` };
    });
    const { source } = adapter(fetcher);
    const failure = await rejection(source.poll(context([ref('200', 'PROJ-20')])));
    expect(failure.kind).toBe('transient');
    expect(outsidePages).toBe(20);
  });

  it.each([
    [401, {}, 'auth', undefined],
    [
      429,
      { 'retry-after': '30', 'x-ratelimit-reset': '1767225720' },
      'throttled',
      NOW.getTime() + 30_000,
    ],
    [429, { 'x-ratelimit-reset': '1767225720' }, 'throttled', 1_767_225_720_000],
  ] as const)(
    'classifies HTTP %s without revealing credentials',
    async (status, headers, kind, retryAt) => {
      const { fetcher } = fake(
        () => ({ issues: [] }),
        () => new Response('private response', { status, headers }),
      );
      const { source, warn } = adapter(fetcher);
      const error = await rejection(source.poll(context()));
      expect(error.kind).toBe(kind);
      expect(error.retryAt?.getTime()).toBe(retryAt);
      expect(error.message).not.toContain(CREDENTIALS.token);
      expect(error.message).not.toContain('private response');
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid statuses on the first and every later poll, then recovers', async () => {
    const current = tracker();
    let remoteStatuses = ['Ready', 'Done'];
    const { fetcher, calls } = fake(
      () => ({ issues: [] }),
      () => [{ statuses: remoteStatuses.map((name) => ({ name })) }],
    );
    const { source } = adapter(fetcher, current);
    current.doneStatuses = ['Finished'];
    const first = await rejection(source.poll(context()));
    expect(first.kind).toBe('config');
    expect(first.message).toContain('Finished');
    expect(calls.map((call) => call.path)).toEqual(['/rest/api/3/project/PROJ/statuses']);
    current.doneStatuses = ['Done'];
    await expect(source.poll(context())).resolves.toMatchObject({ complete: true });
    remoteStatuses = ['Ready'];
    const third = await rejection(source.poll(context()));
    expect(third.kind).toBe('config');
    expect(third.message).toContain('Done');
    remoteStatuses = ['Ready', 'Done'];
    await expect(source.poll(context())).resolves.toMatchObject({ complete: true });
    current.readyStatuses = ['Prepared'];
    const fifth = await rejection(source.poll(context()));
    expect(fifth.kind).toBe('config');
    expect(fifth.message).toContain('Prepared');
    expect(calls.filter((call) => call.path.endsWith('/statuses'))).toHaveLength(5);
    expect(calls.filter((call) => call.path.endsWith('/search/jql'))).toHaveLength(2);
  });

  it('names a missing project key and rejects an empty project-key list', async () => {
    const { fetcher, calls } = fake(
      () => ({ issues: [] }),
      () => new Response('', { status: 404 }),
    );
    const { source } = adapter(fetcher);
    const missing = await rejection(source.poll(context()));
    expect(missing.kind).toBe('config');
    expect(missing.message).toContain('PROJ');
    expect(calls).toHaveLength(1);
    const empty = tracker();
    empty.projectKeys = [];
    const withoutKey = adapter(fetcher, empty).source;
    const noKey = await rejection(withoutKey.poll(context()));
    expect(noKey.kind).toBe('config');
    expect(noKey.message).toContain('project key');
    expect(calls).toHaveLength(1);
  });
});
