// Fixtures in fixtures/project-mirror/, each a raw GraphQL response body:
// - Recorded once, live and read-only, with `gh api graphql` and PROJECT_MIRROR_QUERY against a
//   public repository and its GitHub Project (2026-11-20): `live-snapshot` (Status field, 24 open
//   issues; #729 is Ready, #83 is Backlog), `live-project-not-found` (number 9999),
//   `live-field-not-found` (field NoSuchField) and `live-field-wrong-type` (field Title).
// - Derived from `live-snapshot` by one edit: `cleared` (#729's fieldValueByName -> null),
//   `removed` (#729's projectItems.nodes -> []), `archived` (#729's item isArchived -> true),
//   `other-project` (#729's item project.id -> another id), `empty-project` (every
//   projectItems.nodes -> []), `issues-next-page` (issues.pageInfo.hasNextPage -> true) and
//   `items-next-page` (#83's projectItems.pageInfo.hasNextPage -> true).
// - Hand-authored, because no read-only call with a token holding the project scope produces
//   them: `scope-missing` (INSUFFICIENT_SCOPES at [repositoryOwner, projectV2]), `rate-limited`
//   (RATE_LIMITED) and `item-error` (FORBIDDEN at one issue's projectItems). The HTTP 502 and the
//   non-JSON body are built inline.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterError, batchSchema, type MirrorFailureCode } from '@spur-board/contracts';
import {
  PROJECT_MIRROR_QUERY,
  createGithubProjectAdapter,
  readProjectMirror,
} from '../../src/github/projectMirror.ts';

const id = 'github-project:board:andeverin/2';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const now = () => NOW;
const READY = 'AnDeVerin/spur-board#729';
const BACKLOG = 'AnDeVerin/spur-board#83';

type Body = Record<string, unknown>;
function fixture(name: string): Body {
  return JSON.parse(
    readFileSync(new URL(`fixtures/project-mirror/${name}.json`, import.meta.url), 'utf8'),
  ) as Body;
}

function answering(...bodies: (Body | (() => Response))[]) {
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>((_input, init) => {
    requests.push(
      JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> },
    );
    const next = bodies.shift();
    if (next === undefined) throw new Error('unexpected request');
    return Promise.resolve(typeof next === 'function' ? next() : Response.json(next));
  });
  return { fetcher, requests };
}

function adapter(fetcher: typeof fetch, value = 'Ready') {
  return createGithubProjectAdapter({
    id,
    repo: 'AnDeVerin/spur-board',
    mirror: { owner: 'AnDeVerin', number: 2, field: 'Status', value },
    token: 'test',
    intervalMs: 60_000,
    now,
    fetch: fetcher,
  });
}

function context(signal = new AbortController().signal) {
  return { observe: { prs: [], tickets: [], sessions: [] }, signal };
}

async function readiness(name: string, value = 'Ready') {
  const batch = await adapter(answering(fixture(name)).fetcher, value).poll(context());
  return new Map(batch.mirror?.readiness.map((entry) => [entry.key, entry.state]));
}

async function rejection(answer: Body | (() => Response), value = 'Ready') {
  const error = await adapter(answering(answer).fetcher, value)
    .poll(context())
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  expect(error).toBeInstanceOf(AdapterError);
  return error as AdapterError;
}

function expectFailure(
  error: AdapterError,
  kind: AdapterError['kind'],
  code: MirrorFailureCode,
): void {
  expect({ kind: error.kind, code: error.code }).toEqual({ kind, code });
}

describe('GitHub Project mirror', () => {
  it('reads the live snapshot as one complete batch with readiness per open issue', async () => {
    const { fetcher, requests } = answering(fixture('live-snapshot'));
    const batch = await adapter(fetcher).poll(context());
    expect(batchSchema.safeParse(batch).success).toBe(true);
    expect(batch).toMatchObject({
      source: id,
      complete: true,
      items: [],
      entities: [],
      mirror: { title: 'spur-board' },
      // The recorded rateLimit.
      usage: { points: 1 },
      budget: { remaining: 4713, limit: 5000, resetAt: '2026-11-20T10:24:48Z' },
    });
    const states = new Map(batch.mirror?.readiness.map((entry) => [entry.key, entry.state]));
    expect(states.size).toBe(24);
    expect(states.get(READY)).toBe('ready');
    expect(states.get(BACKLOG)).toBe('not_ready');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toBe(PROJECT_MIRROR_QUERY);
    expect(PROJECT_MIRROR_QUERY).not.toContain('items(');
    expect(requests[0]?.variables).toEqual({
      owner: 'AnDeVerin',
      repo: 'spur-board',
      projectOwner: 'AnDeVerin',
      number: 2,
      field: 'Status',
    });
  });

  it('compares by the option the value names: Backlog flips the recorded issues', async () => {
    const states = await readiness('live-snapshot', 'Backlog');
    expect(states.get(READY)).toBe('not_ready');
    expect(states.get(BACKLOG)).toBe('ready');
  });

  it('rejects a value that names no option with mirror_field_not_found', async () => {
    expectFailure(
      await rejection(fixture('live-snapshot'), 'Blocked'),
      'config',
      'mirror_field_not_found',
    );
  });

  it.each([['cleared'], ['removed'], ['archived'], ['other-project']])(
    'reads the Ready issue not_ready when %s',
    async (name) => {
      const states = await readiness(name);
      expect(states.get(READY)).toBe('not_ready');
      expect(states.get(BACKLOG)).toBe('not_ready');
      expect(states.size).toBe(24);
    },
  );

  it('reads every issue not_ready in a readable Project with no items', async () => {
    const states = await readiness('empty-project');
    expect(states.size).toBe(24);
    expect([...states.values()].every((state) => state === 'not_ready')).toBe(true);
  });

  it.each([['live-project-not-found'], ['scope-missing']])(
    'rejects %s with mirror_project_forbidden, never an empty Project',
    async (name) => {
      const error = await rejection(fixture(name));
      expectFailure(error, 'auth', 'mirror_project_forbidden');
      expect(error.message).toContain('AnDeVerin/2');
      expect(error.message).toContain('read:project');
    },
  );

  it('rejects a null Project without an error with mirror_project_forbidden', async () => {
    const body = fixture('live-snapshot');
    (body['data'] as { repositoryOwner: unknown }).repositoryOwner = null;
    expectFailure(await rejection(body), 'auth', 'mirror_project_forbidden');
  });

  it.each([['live-field-not-found'], ['live-field-wrong-type']])(
    'rejects %s with mirror_field_not_found',
    async (name) => {
      expectFailure(await rejection(fixture(name)), 'config', 'mirror_field_not_found');
    },
  );

  it.each([['issues-next-page'], ['items-next-page']])(
    'rejects %s with mirror_snapshot_incomplete',
    async (name) => {
      expectFailure(await rejection(fixture(name)), 'transient', 'mirror_snapshot_incomplete');
    },
  );

  it('rejects a rate limit as throttled with retryAt and mirror_rate_limited', async () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const error = await rejection(() =>
      Response.json(fixture('rate-limited'), {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
    );
    expectFailure(error, 'throttled', 'mirror_rate_limited');
    expect(error.retryAt?.getTime()).toBe(reset * 1000);
  });

  it.each([
    ['item-error', () => Response.json(fixture('item-error'))],
    ['an HTTP 502', () => new Response('bad gateway', { status: 502 })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
  ])('rejects %s as transient with mirror_read_failed', async (_name, answer) => {
    expectFailure(await rejection(answer), 'transient', 'mirror_read_failed');
  });

  it('attaches the reported cost of a failed read to the error', async () => {
    const error = await rejection(fixture('live-field-not-found'));
    expect(error.usage).toEqual({ points: 1 });
  });

  it('rethrows an abort and returns no batch', async () => {
    const abort = new AbortController();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const polled = adapter(fetcher).poll(context(abort.signal));
    abort.abort(new Error('stopped'));
    await expect(polled).rejects.toThrow('stopped');
    await expect(polled).rejects.not.toBeInstanceOf(AdapterError);
  });

  it('keeps the resolved option id and fails once it leaves the field', async () => {
    const renamed = fixture('live-snapshot');
    const project = (
      renamed['data'] as {
        repositoryOwner: { projectV2: { field: { options: { id: string; name: string }[] } } };
      }
    ).repositoryOwner.projectV2;
    const ready = project.field.options.find((option) => option.name === 'Ready');
    if (ready === undefined) throw new Error('fixture lost its Ready option');
    const gone = structuredClone(renamed);
    // A renamed option keeps its id, so it still matches.
    ready.name = 'Ready to start';
    (
      gone['data'] as {
        repositoryOwner: { projectV2: { field: { options: { id: string }[] } } };
      }
    ).repositoryOwner.projectV2.field.options = project.field.options.filter(
      (option) => option.id !== ready.id,
    );
    const source = adapter(answering(fixture('live-snapshot'), renamed, gone).fetcher);
    await source.poll(context());
    const second = await source.poll(context());
    expect(second.mirror?.readiness.find((entry) => entry.key === READY)?.state).toBe('ready');
    const error = await source.poll(context()).then(
      () => undefined,
      (failure: unknown) => failure as AdapterError,
    );
    expect(error).toBeInstanceOf(AdapterError);
    if (error !== undefined) expectFailure(error, 'config', 'mirror_field_not_found');
  });

  it('reads the mirror with a token for board doctor', async () => {
    const read = await readProjectMirror(
      {
        repo: 'AnDeVerin/spur-board',
        mirror: { owner: 'AnDeVerin', number: 2, field: 'Status', value: 'Ready' },
      },
      {
        token: 'test',
        now,
        fetch: answering(fixture('live-snapshot')).fetcher,
        signal: context().signal,
      },
    );
    expect(read).toMatchObject({ title: 'spur-board', projectId: 'PVT_kwHOAdCPFc4Bp2FU' });
    await expect(
      readProjectMirror(
        {
          repo: 'AnDeVerin/spur-board',
          mirror: { owner: 'AnDeVerin', number: 9999, field: 'Status', value: 'Ready' },
        },
        {
          token: 'test',
          now,
          fetch: answering(fixture('live-project-not-found')).fetcher,
          signal: context().signal,
        },
      ),
    ).rejects.toMatchObject({ kind: 'auth', code: 'mirror_project_forbidden' });
  });
});
