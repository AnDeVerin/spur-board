import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  FACT_NAMES,
  FACT_SCHEMAS,
  type FactName,
  isExternalAuthor,
  isKnownSessionHealth,
  isKnownSessionStatus,
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
} from '../src/index.ts';
import { walk } from './json-schema-walk.ts';

const sha = 'a'.repeat(40);

function prFacts(): Record<string, unknown> {
  return {
    repo: 'acme/web',
    number: 42,
    url: 'https://github.com/acme/web/pull/42',
    title: 'PROJ-123 Add the login page',
    author: 'octocat',
    headSha: sha,
    headBranch: 'PROJ-123-login-page',
    state: 'open',
    draft: false,
    mergeable: 'mergeable',
    mergeState: 'blocked',
    requiredChecks: [
      { name: 'build', state: 'success', completedAt: '2026-11-01T10:05:00Z' },
      { name: 'test', state: 'pending', completedAt: null },
    ],
    checks: [{ name: 'build', state: 'success', completedAt: '2026-11-01T10:05:00Z' }],
    reviews: [
      {
        reviewer: 'octocat',
        state: 'approved',
        commitSha: sha,
        submittedAt: '2026-11-01T11:00:00Z',
      },
    ],
    reviewThreads: [{ resolved: true }, { resolved: false }],
    reviewRequests: [{ kind: 'user', id: 'octocat', asCodeOwner: true }],
    ticketKeys: ['PROJ-123'],
    updatedAt: '2026-11-01T11:00:00Z',
    feedback: [
      {
        kind: 'comment',
        id: 'IC_1',
        author: { login: 'alice', type: 'user' },
        postedAt: '2026-11-01T10:30:00Z',
      },
      { kind: 'comment', id: 'IC_2', author: null, postedAt: '2026-11-01T10:40:00Z' },
      {
        kind: 'review',
        id: 'PRR_1',
        author: { login: 'octocat', type: 'user' },
        postedAt: '2026-11-01T11:00:00Z',
      },
    ],
    feedbackComplete: true,
  };
}

function ticketFacts(): Record<string, unknown> {
  return {
    trackerId: 'web',
    id: '10042',
    key: 'PROJ-123',
    title: 'Add the login page',
    status: 'In Progress',
    assignee: 'octocat',
    sprint: 'Sprint 7',
    labels: ['web'],
    inFilter: true,
    url: 'https://example.atlassian.net/browse/PROJ-123',
    updatedAt: '2026-11-01T09:00:00Z',
  };
}

function sessionFacts(): Record<string, unknown> {
  return {
    id: 'demo-worker-1',
    spurProject: 'demo',
    branch: 'PROJ-123-login-page',
    pr: { repo: 'acme/web', number: 42 },
    links: { preview: 'https://preview.example.com/demo-worker-1' },
    lifecycle: 'running',
    health: 'working',
    healthSince: '2026-11-01T11:20:00Z',
    lastActivityAt: '2026-11-01T11:30:00Z',
    endedAt: null,
    endReason: null,
  };
}

/** The error printed for invalid facts, or a failure if they parsed. */
function errorFor(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? '' : z.prettifyError(result.error);
}

function pathLines(error: string): string[] {
  return error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('→ at '));
}

describe('fixtures', () => {
  it.each<[string, z.ZodType, unknown]>([
    ['a PR with required checks', prFactsSchema, prFacts()],
    [
      'a draft PR',
      prFactsSchema,
      { ...prFacts(), draft: true, mergeState: 'draft', requiredChecks: [], reviews: [] },
    ],
    [
      'a PR with a review request stored by an earlier version',
      prFactsSchema,
      { ...prFacts(), reviewRequests: [{ reviewer: 'octocat', asCodeOwner: true }] },
    ],
    [
      'a PR with feedback from a bot',
      prFactsSchema,
      {
        ...prFacts(),
        feedback: [
          {
            kind: 'comment',
            id: 'IC_3',
            author: { login: 'renovate', type: 'bot' },
            postedAt: '2026-11-01T10:30:00Z',
          },
        ],
        feedbackComplete: false,
      },
    ],
    ['a Jira ticket', ticketFactsSchema, ticketFacts()],
    [
      'a GitHub issue as a ticket',
      ticketFactsSchema,
      {
        ...ticketFacts(),
        trackerId: 'board',
        id: 'I_example42',
        key: 'acme/web#42',
        status: 'open',
        sprint: null,
        assignee: null,
        inFilter: false,
        url: 'https://github.com/acme/web/issues/42',
      },
    ],
    ['a live Spur session', sessionFactsSchema, sessionFacts()],
    [
      'an ended Spur session',
      sessionFactsSchema,
      {
        ...sessionFacts(),
        lifecycle: 'completed',
        health: 'stopped',
        endedAt: '2026-11-01T12:00:00Z',
        endReason: 'complete',
      },
    ],
  ])('parses %s', (_name, schema, input) => {
    expect(schema.parse(input)).toEqual(input);
  });
});

describe('unknown health', () => {
  it('keeps an unseen health value and marks it unknown', () => {
    const session = sessionFactsSchema.parse({ ...sessionFacts(), health: 'hibernating' });
    expect(session.health).toBe('hibernating');
    expect(isKnownSessionHealth(session.health)).toBe(false);
  });

  it('marks a listed health value known', () => {
    const session = sessionFactsSchema.parse({ ...sessionFacts(), health: 'waiting' });
    expect(isKnownSessionHealth(session.health)).toBe(true);
  });

  it('rejects an empty health value', () => {
    expect(pathLines(errorFor(sessionFactsSchema, { ...sessionFacts(), health: '' }))).toContain(
      '→ at health',
    );
  });
});

describe('unknown lifecycle', () => {
  it('keeps an unseen lifecycle value and marks it unknown', () => {
    const session = sessionFactsSchema.parse({ ...sessionFacts(), lifecycle: 'archived' });
    expect(session.lifecycle).toBe('archived');
    expect(isKnownSessionStatus(session.lifecycle)).toBe(false);
  });

  it('marks a listed lifecycle value known', () => {
    const session = sessionFactsSchema.parse({ ...sessionFacts(), lifecycle: 'running' });
    expect(isKnownSessionStatus(session.lifecycle)).toBe(true);
  });
});

describe('invalid facts', () => {
  it('rejects a PR without headSha at its path', () => {
    const input = prFacts();
    delete input['headSha'];
    expect(pathLines(errorFor(prFactsSchema, input))).toContain('→ at headSha');
  });

  it('rejects a required check without state at its path', () => {
    const input = { ...prFacts(), requiredChecks: [{ name: 'build', completedAt: null }] };
    expect(pathLines(errorFor(prFactsSchema, input))).toContain('→ at requiredChecks[0].state');
  });

  it.each([
    ['names nobody', { asCodeOwner: true }],
    ['has a kind without an id', { kind: 'team', asCodeOwner: false }],
  ])('rejects a review request that %s at its path', (_name, request) => {
    const error = errorFor(prFactsSchema, { ...prFacts(), reviewRequests: [request] });
    expect(error).toContain('Set kind and id, or reviewer alone');
    expect(pathLines(error)).toContain('→ at reviewRequests[0]');
  });

  it('rejects an end time without an end reason', () => {
    const input = { ...sessionFacts(), endedAt: '2026-11-01T12:00:00Z' };
    const error = errorFor(sessionFactsSchema, input);
    expect(error).toContain('Set endedAt and endReason together');
    expect(pathLines(error)).toContain('→ at endReason');
  });

  it('rejects a ticket without its stable id at its path', () => {
    const input = ticketFacts();
    delete input['id'];
    expect(pathLines(errorFor(ticketFactsSchema, input))).toContain('→ at id');
  });

  it('rejects a session without healthSince at its path', () => {
    const input = sessionFacts();
    delete input['healthSince'];
    expect(pathLines(errorFor(sessionFactsSchema, input))).toContain('→ at healthSince');
  });

  it.each([
    ['an empty id', { kind: 'comment', id: '', author: null, postedAt: '2026-11-01T10:30:00Z' }],
    [
      'an unknown author type',
      {
        kind: 'comment',
        id: 'IC_1',
        author: { login: 'alice', type: 'team' },
        postedAt: '2026-11-01T10:30:00Z',
      },
    ],
    [
      'an author without a login',
      { kind: 'review', id: 'PRR_1', author: { type: 'user' }, postedAt: '2026-11-01T10:30:00Z' },
    ],
    ['no time', { kind: 'comment', id: 'IC_1', author: null }],
    [
      'an unknown kind',
      { kind: 'reaction', id: 'R_1', author: null, postedAt: '2026-11-01T10:30:00Z' },
    ],
  ])('rejects a feedback entry with %s at its path', (_name, entry) => {
    const error = errorFor(prFactsSchema, { ...prFacts(), feedback: [entry] });
    expect(pathLines(error).some((line) => line.startsWith('→ at feedback[0]'))).toBe(true);
  });

  it('rejects an unknown key', () => {
    expect(errorFor(ticketFactsSchema, { ...ticketFacts(), bogus: 1 })).toContain(
      'Unrecognized key: "bogus"',
    );
  });
});

describe('stored facts', () => {
  it('parses stored PR facts without feedback', () => {
    const input = prFacts();
    delete input['feedback'];
    delete input['feedbackComplete'];
    expect(prFactsSchema.parse(input)).toEqual(input);
  });
});

describe('external authors', () => {
  it.each<[string, Parameters<typeof isExternalAuthor>[0]['author'], boolean]>([
    ['the agent login', { login: 'operator', type: 'user' }, false],
    ['the agent login in another letter case', { login: 'OPERATOR', type: 'user' }, false],
    ['a bot', { login: 'dependabot', type: 'bot' }, false],
    ['a bot with the agent login', { login: 'operator', type: 'bot' }, false],
    ['another user', { login: 'alice', type: 'user' }, true],
    ['a deleted account', null, true],
  ])('classifies %s', (_name, author, external) => {
    expect(isExternalAuthor({ author }, 'operator')).toBe(external);
  });
});

describe('fact names', () => {
  it('names only fields that exist in the shape of their kind', () => {
    const fields = new Map(
      Object.entries(FACT_SCHEMAS).map(([kind, schema]) => [kind, Object.keys(schema.shape)]),
    );
    for (const name of FACT_NAMES) {
      const [kind = '', field = '', ...rest] = name.split('.');
      expect(rest).toEqual([]);
      expect(fields.get(kind), name).toContain(field);
    }
  });

  it('lists every field of every kind once', () => {
    expect(new Set(FACT_NAMES).size).toBe(FACT_NAMES.length);
    const fieldCount = Object.values(FACT_SCHEMAS).reduce(
      (sum, schema) => sum + Object.keys(schema.shape).length,
      0,
    );
    expect(FACT_NAMES).toHaveLength(fieldCount);
    expect(FACT_NAMES).toContain('pr.requiredChecks');
    expect(FACT_NAMES).toContain('session.health');
  });

  it('does not compile a misspelled fact name', () => {
    expectTypeOf<'pr.headSha'>().toExtend<FactName>();
    expectTypeOf<'session.lastActivityAt'>().toExtend<FactName>();
    expectTypeOf<'session.healthSince'>().toExtend<FactName>();
    expectTypeOf<'ticket.id'>().toExtend<FactName>();
    expectTypeOf<'pr.heaSha'>().not.toExtend<FactName>();
    expectTypeOf<'ticket.headSha'>().not.toExtend<FactName>();
  });
});

describe('descriptions', () => {
  it.each([
    ['prFactsSchema', prFactsSchema],
    ['ticketFactsSchema', ticketFactsSchema],
    ['sessionFactsSchema', sessionFactsSchema],
  ] as const)('%s describes every property', (_name, schema) => {
    const walked = walk(z.toJSONSchema(schema, { io: 'output' }));
    expect(walked.properties.length).toBeGreaterThan(0);
    expect(walked.undescribed).toEqual([]);
    expect(walked.open).toEqual([]);
  });

  it('states the 404 rule in the session description', () => {
    expect(sessionFactsSchema.description).toContain('not_found');
    expect(sessionFactsSchema.description).toContain('vanished');
  });
});
