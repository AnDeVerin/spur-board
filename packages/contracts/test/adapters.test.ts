import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  ADAPTER_ERROR_KINDS,
  type Adapter,
  AdapterError,
  type Batch,
  ENTITY_STATUSES,
  type EntityStatus,
  type FactKind,
  batchSchema,
} from '../src/index.ts';
import { walk } from './json-schema-walk.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownFile = fileURLToPath(import.meta.url);
const sha = 'b'.repeat(40);

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'github',
    observedAt: '2026-11-01T12:00:00Z',
    complete: true,
    items: [],
    entities: [],
    ...overrides,
  };
}

const prFacts = {
  repo: 'acme/web',
  number: 42,
  url: 'https://github.com/acme/web/pull/42',
  title: 'PROJ-123 Add the login page',
  author: 'octocat',
  headSha: sha,
  headBranch: 'PROJ-123-login-page',
  state: 'open',
  draft: false,
  mergeable: 'unknown',
  mergeState: 'unknown',
  requiredChecks: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  reviewRequests: [],
  ticketKeys: ['PROJ-123'],
  updatedAt: '2026-11-01T11:00:00Z',
};

const ticketFacts = {
  trackerId: 'web',
  key: 'PROJ-123',
  title: 'Add the login page',
  status: 'To Do',
  assignee: null,
  sprint: null,
  labels: [],
  inFilter: true,
  url: 'https://example.atlassian.net/browse/PROJ-123',
  updatedAt: '2026-11-01T09:00:00Z',
};

const sessionFacts = {
  id: 'demo-worker-1',
  spurProject: 'demo',
  branch: null,
  pr: null,
  links: {},
  lifecycle: 'running',
  health: 'waiting',
  lastActivityAt: null,
  endedAt: null,
  endReason: null,
};

const items: Record<FactKind, { valid: unknown; invalid: unknown }> = {
  pr: { valid: { kind: 'pr', facts: prFacts }, invalid: { kind: 'pr', facts: ticketFacts } },
  ticket: {
    valid: { kind: 'ticket', facts: ticketFacts },
    invalid: { kind: 'ticket', facts: { ...ticketFacts, inFilter: 'yes' } },
  },
  session: {
    valid: { kind: 'session', facts: sessionFacts },
    invalid: { kind: 'session', facts: { ...sessionFacts, endReason: 'complete' } },
  },
};

const entities: Record<EntityStatus, unknown> = {
  ok: { ref: { kind: 'pr', repo: 'acme/web', number: 42 }, status: 'ok' },
  not_found: { ref: { kind: 'session', id: 'demo-worker-1' }, status: 'not_found' },
  no_access: {
    ref: { kind: 'ticket', trackerId: 'web', key: 'PROJ-123' },
    status: 'no_access',
  },
};

describe('batch', () => {
  it.each(Object.entries(items))('parses a valid %s item and rejects an invalid one', (_k, i) => {
    expect(batchSchema.safeParse(batch({ items: [i.valid] })).success).toBe(true);
    expect(batchSchema.safeParse(batch({ items: [i.invalid] })).success).toBe(false);
  });

  it('has an entity fixture for every status', () => {
    expect(Object.keys(entities)).toEqual([...ENTITY_STATUSES]);
  });

  it.each(Object.entries(entities))('parses a %s entity', (_status, entity) => {
    expect(batchSchema.safeParse(batch({ entities: [entity] })).success).toBe(true);
  });

  it('rejects an unknown entity status', () => {
    const entity = { ref: { kind: 'session', id: 'demo-worker-1' }, status: 'gone' };
    expect(batchSchema.safeParse(batch({ entities: [entity] })).success).toBe(false);
  });

  it('parses a complete batch with a session that answered 404 and no item', () => {
    const input = batch({
      source: 'spur',
      complete: true,
      entities: [{ ref: { kind: 'session', id: 'demo-worker-1' }, status: 'not_found' }],
      items: [],
    });
    expect(batchSchema.parse(input)).toEqual(input);
  });

  it('keeps an optional cursor and rejects an empty one', () => {
    expect(batchSchema.parse(batch({ cursor: 'opaque-1' })).cursor).toBe('opaque-1');
    expect(batchSchema.safeParse(batch({ cursor: '' })).success).toBe(false);
  });

  it('describes every property', () => {
    const walked = walk(z.toJSONSchema(batchSchema, { io: 'output' }));
    expect(walked.undescribed).toEqual([]);
    expect(walked.open).toEqual([]);
  });
});

describe('AdapterError', () => {
  it('lists the error kinds', () => {
    expect(ADAPTER_ERROR_KINDS).toEqual(['auth', 'config', 'throttled', 'transient']);
  });

  it('carries kind, retryAt and cause', () => {
    const retryAt = new Date('2026-11-01T12:15:00Z');
    const cause = new Error('quota spent');
    const error = new AdapterError('throttled', 'GitHub quota spent', { retryAt, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ kind: 'throttled', retryAt, cause, name: 'AdapterError' });
    expect(error.message).toBe('GitHub quota spent');
  });

  it('leaves retryAt and cause unset when not given', () => {
    const error = new AdapterError('auth', 'Token rejected');
    expect(error.retryAt).toBeUndefined();
    expect(error).not.toHaveProperty('cause');
  });
});

const minimal = {
  id: 'spur',
  intervalMs: 15_000,
  poll: (): Promise<Batch> =>
    Promise.resolve({
      source: 'spur',
      observedAt: '2026-11-01T12:00:00Z',
      complete: true,
      items: [],
      entities: [],
    }),
};
type Minimal = typeof minimal;

it('accepts a minimal adapter', () => {
  expectTypeOf(minimal).toExtend<Adapter>();
  expectTypeOf<Omit<Minimal, 'id'>>().not.toExtend<Adapter>();
  expectTypeOf<Omit<Minimal, 'intervalMs'>>().not.toExtend<Adapter>();
  expectTypeOf<Omit<Minimal, 'poll'>>().not.toExtend<Adapter>();
});

describe('obligation ids', () => {
  const source = readFileSync(join(root, 'packages/contracts/src/adapters.ts'), 'utf8');

  it('lists A1-A7 in order, each once, in the Adapter TSDoc', () => {
    const ids = [...source.matchAll(/^\s*\*\s+- (A\d+):/gm)].map((match) => match[1]);
    expect(ids).toEqual(Array.from({ length: 7 }, (_, i) => `A${String(i + 1)}`));
  });

  it('states the 404 rule in A4', () => {
    const a4 = source.slice(source.indexOf('- A4:'), source.indexOf('- A5:'));
    expect(a4).toContain('not_found');
    expect(a4).toContain('vanished');
  });
});

const scanned = ['packages/contracts', 'packages/core'];
const skipped = new Set(['node_modules', 'dist', 'coverage']);
const wireTerms = /rateLimit|pageInfo|endCursor|nextPageToken|statusCheckRollup/i;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('no wire formats', () => {
  it('flags wire terms and leaves neutral words alone', () => {
    for (const term of ['X-RateLimit-Reset', 'pageInfo']) expect(term).toMatch(wireTerms);
    for (const word of ['cursor', 'retryAt', 'throttled']) expect(word).not.toMatch(wireTerms);
  });

  it('keeps wire terms out of the contracts and core', () => {
    const files = scanned
      .flatMap((dir) => filesUnder(join(root, dir)))
      .filter((file) => file !== ownFile);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const hits = files
      .filter((file) => wireTerms.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(hits).toEqual([]);
  });
});
