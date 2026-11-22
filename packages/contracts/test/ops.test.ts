import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERRORS,
  GRANTS,
  type Grant,
  OPERATIONS,
  type SchemaRole,
  buildCatalogSnapshot,
  type ServerErrorCode,
  commentSchema,
  errorCodeOf,
  roleCanUseOperation,
} from '../src/index.ts';
import { browserOperations } from '../src/browser.ts';
import { inboxEntrySchema, inboxHandledSchema } from '../src/ops/inbox-schemas.ts';
import { defineOperation } from '../src/ops/define.ts';
import { SCHEMA_ROLES } from '../src/ops/schema-get-schema.ts';
import { linkViewSchema, statusTaskSchema } from '../src/ops/schemas.ts';
import { catalogSnapshotBody, catalogVersion } from '../src/ops/snapshot.ts';
import { type JsonObject, isObject, walk } from './json-schema-walk.ts';

const schemas = OPERATIONS.map((op) => ({
  op,
  input: z.toJSONSchema(op.input, { io: 'input' }),
  output: z.toJSONSchema(op.output, { io: 'output' }),
}));

describe('operator inbox URLs', () => {
  const entry = {
    id: 'I1',
    project: '_board',
    kind: 'board_observation',
    severity: 'failure',
    text: 'Run failed',
    at: '2026-11-04T08:00:00.000Z',
    task: null,
  };
  it.each([inboxEntrySchema, inboxHandledSchema])(
    'accepts omission and HTTP(S) in the shared entry schema',
    (schema) => {
      const value = { ...entry, ...(schema === inboxHandledSchema ? { handledAt: entry.at } : {}) };
      expect(schema.parse(value)).not.toHaveProperty('url');
      for (const url of [
        'http://example.test/run',
        'https://example.test/run',
        'HTTPS://example.test/run',
      ]) {
        expect(schema.parse({ ...value, url })).toMatchObject({ url });
      }
      for (const url of ['', '/relative', 'ftp://example.test/run', 'javascript:alert(1)']) {
        expect(schema.safeParse({ ...value, url }).success, url).toBe(false);
      }
      const output = {
        items: [{ ...entry, url: 'https://example.test/run' }],
        handled: [{ ...entry, url: 'http://example.test/run', handledAt: entry.at }],
      };
      expect(browserOperations['inbox.operator'].output.parse(output)).toEqual(output);
      expect(OPERATIONS.find((op) => op.id === 'inbox.operator')?.output.parse(output)).toEqual(
        output,
      );
    },
  );
});

/** The top-level object branches of an input: one, or one per union member. */
function inputBranches(input: JsonObject): JsonObject[] {
  const oneOf = input['oneOf'];
  return Array.isArray(oneOf) ? oneOf.filter(isObject) : [input];
}

function propertyNames(branch: JsonObject): string[] {
  return isObject(branch['properties']) ? Object.keys(branch['properties']) : [];
}

/** The `mode` constant of a union branch, or undefined for a branch without one. */
function branchMode(branch: JsonObject): string | undefined {
  const mode = isObject(branch['properties']) ? branch['properties']['mode'] : undefined;
  return isObject(mode) && typeof mode['const'] === 'string' ? mode['const'] : undefined;
}

describe('schema walker', () => {
  it('flags a missing description and passes a described one', () => {
    const bare = z.toJSONSchema(z.strictObject({ a: z.string() }));
    const described = z.toJSONSchema(z.strictObject({ a: z.string().describe('A.') }));
    expect(walk(bare).undescribed).toEqual(['.a']);
    expect(walk(described).undescribed).toEqual([]);
  });

  it('flags a loose object and records an opaque payload without descending', () => {
    const loose = z.toJSONSchema(z.looseObject({ a: z.string().describe('A.') }));
    expect(walk(loose).open).toEqual(['']);
    const payload = z.toJSONSchema(
      z.strictObject({ p: z.record(z.string(), z.unknown()).describe('P.') }),
    );
    expect(walk(payload)).toMatchObject({ open: [], undescribed: [], opaque: ['.p'] });
  });
});

describe('catalog', () => {
  it('requires a described nullable UTC column entry timestamp on status rows only', () => {
    const field = statusTaskSchema.shape.columnEnteredAt;
    for (const value of ['2026-11-04T08:00:00.000Z', null])
      expect(field.safeParse(value).success).toBe(true);
    for (const value of [undefined, 'yesterday', '2026-11-04T08:00:00+02:00'])
      expect(field.safeParse(value).success).toBe(false);
    const schema = z.toJSONSchema(statusTaskSchema);
    expect(schema.required).toContain('columnEnteredAt');
    const property = schema.properties?.['columnEnteredAt'];
    if (!isObject(property)) throw new Error('Missing column entry schema');
    expect(property['description']).toContain('original add');
  });
  it('lists optional approvals on status prSummary and task.get PR links', () => {
    const summary = statusTaskSchema.shape.prSummary.unwrap().element;
    const link = linkViewSchema;
    const approvals = [
      {
        author: 'alice',
        sha: 'a'.repeat(40),
        onHead: false,
        commitsAfter: 1,
        changedAfter: ['back/', 'docs/'],
        watchedAfter: ['back/'],
      },
      { author: 'bob', sha: 'b'.repeat(40), onHead: false, notCounted: 'history_rewritten' },
      { author: 'carol', sha: 'c'.repeat(40), onHead: false },
      {
        author: 'dave',
        sha: 'd'.repeat(40),
        onHead: true,
        commitsAfter: 0,
        changedAfter: [],
        watchedAfter: [],
      },
    ];
    const field = summary.shape.approvals;
    expect(field.parse(approvals)).toEqual(approvals);
    expect(field.parse(undefined)).toBeUndefined();
    expect(link.shape.approvals.parse(approvals)).toEqual(approvals);
    for (const bad of [
      { ...approvals[2], notCounted: 'throttled' },
      { ...approvals[2], sha: 'short' },
      { ...approvals[2], extra: true },
      { sha: 'a'.repeat(40), onHead: false },
    ])
      expect(field.safeParse([bad]).success, JSON.stringify(bad)).toBe(false);
  });
  it('defaults web off and exposes exactly the screen reads and ten operator writes', () => {
    expect(
      OPERATIONS.filter((op) => op.web !== null)
        .map((op) => op.id)
        .sort(),
    ).toEqual([
      'block.answer',
      'block.followup',
      'columns.describe',
      'comment.add',
      'config.get',
      'inbox.ack',
      'inbox.get',
      'inbox.operator',
      'item.close',
      'status.get',
      'task.get',
      'task.history',
      'task.move',
      'task.order',
      'task.return',
      'task.submit',
      'task.wait',
    ]);
    expect(
      OPERATIONS.filter((op) => op.kind === 'mutation' && op.web !== null)
        .map((op) => op.id)
        .sort(),
    ).toEqual([
      'block.answer',
      'block.followup',
      'comment.add',
      'inbox.ack',
      'item.close',
      'task.move',
      'task.order',
      'task.return',
      'task.submit',
      'task.wait',
    ]);
    expect(OPERATIONS.find((op) => op.id === 'schema.get')?.web).toBeNull();
    expect(catalogSnapshotBody(OPERATIONS).operations.every((op) => Object.hasOwn(op, 'web'))).toBe(
      true,
    );
  });

  it('binds every browser operation to its web catalog op and shares browser schemas', () => {
    for (const browserOp of Object.values(browserOperations)) {
      const op = OPERATIONS.find((candidate) => candidate.id === browserOp.id);
      expect(op?.web, browserOp.id).not.toBeNull();
      expect(op?.kind, browserOp.id).toBe(browserOp.kind);
      expect(op?.input, browserOp.id).toBe(browserOp.input);
      expect(op?.output, browserOp.id).toBe(browserOp.output);
    }
  });

  it('pins the explicit configuration output field allowlist', () => {
    const schema = schemas.find(({ op }) => op.id === 'config.get')?.output;
    expect(walk(schema).properties.map(({ path }) => path)).toMatchInlineSnapshot(`
      [
        ".projects",
        ".projects[].id",
        ".projects[].columns",
        ".projects[].columns[].id",
        ".projects[].columns[].executor",
        ".projects[].columns[].executor.kind",
        ".projects[].columns[].executor.name",
        ".projects[].columns[].group",
        ".projects[].columns[].source",
        ".projects[].columns[].source|0.kind",
        ".projects[].columns[].source|1.kind",
        ".projects[].columns[].source|1.tracker",
        ".projects[].columns[].source|1.name",
        ".projects[].columns[].source|1.project",
        ".projects[].columns[].source|1.field",
        ".projects[].columns[].source|1.value",
        ".projects[].columns[].source|1.health",
        ".projects[].columns[].source|1.readAt",
        ".projects[].columns[].source|1.error",
        ".projects[].columns[].source|1.error.code",
        ".projects[].columns[].source|1.error.message",
        ".projects[].columns[].quietTurnAfterMs",
        ".projects[].columns[].noRecipientAfterMs",
        ".projects[].columns[].quietAfterMs",
        ".projects[].dispatcher",
        ".projects[].dispatcher.mode",
        ".projects[].spurProjects",
        ".projects[].spurProjects[].name",
        ".projects[].spurProjects[].role",
        ".projects[].spurProjects[].displayName",
        ".projects[].ticketBrowseBase",
        ".projects[].checksGate",
        ".web",
        ".web.publicOrigin",
        ".web.spurUiOrigin",
      ]
    `);
  });

  it('requires one link target mode and a reason', () => {
    for (const id of ['link.add', 'link.remove']) {
      const operation = OPERATIONS.find((entry) => entry.id === id);
      if (operation === undefined) throw new Error(`Missing ${id}`);
      for (const input of [
        { mode: 'pr', pr: 'https://github.com/example/web/pull/7' },
        { mode: 'session', session: 'web-7' },
        { mode: 'ticket', ticket: 'PROJ-456' },
      ]) {
        expect(
          operation.input.safeParse({ task: 'PROJ-123', reason: 'Correction.', ...input }).success,
        ).toBe(true);
        expect(operation.input.safeParse({ task: 'PROJ-123', ...input }).success).toBe(false);
      }
      expect(
        operation.input.safeParse({
          mode: 'pr',
          task: 'PROJ-123',
          pr: 'https://github.com/example/web/pull/7',
          session: 'web-7',
          reason: 'Correction.',
        }).success,
      ).toBe(false);
      expect(operation.cli.args).toEqual(['task']);
      expect(operation.cli.modes?.map(({ flag }) => flag)).toEqual([
        '--pr',
        '--session',
        '--ticket',
      ]);
    }
  });

  it('task.move binds --correct and excludes Done', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'task.move');
    if (operation === undefined) throw new Error('Missing task.move');
    const input = { mode: 'correct', task: 'PROJ-123', column: 'dev', reason: 'Wrong PR.' };
    expect(operation.input.safeParse(input).success).toBe(true);
    expect(operation.input.safeParse({ ...input, column: 'done' }).success).toBe(false);
    expect(operation.cli.args).toEqual(['task', 'column']);
    expect(operation.cli.modes).toEqual([
      { mode: 'manual', flag: '--manual', value: null },
      { mode: 'correct', flag: '--correct', value: null },
    ]);
    expect(operation.cli.defaultMode).toBe('manual');
    expect(operation.explicitKeyModes).toEqual(['manual']);
    const reason = '  literal\r\n\t<script> & *text*  ';
    expect(operation.input.parse({ ...input, mode: 'manual', column: 'done', reason })).toEqual({
      ...input,
      mode: 'manual',
      column: 'done',
      reason,
    });
    for (const reason of ['', ' \t\r\n', 'x'.repeat(20_001)])
      expect(operation.input.safeParse({ ...input, mode: 'manual', reason }).success).toBe(false);
    expect(
      operation.input.safeParse({ ...input, mode: 'manual', reason: 'x'.repeat(20_000) }).success,
    ).toBe(true);
  });

  it('shows a separate ticket link in task detail without changing the task view', () => {
    const operation = OPERATIONS.find((entry) => entry.id === 'task.get');
    if (operation === undefined) throw new Error('Missing task.get');
    expect(
      operation.output.safeParse({
        task: { key: 'PROJ-123', project: 'web', column: 'dev', membership: 'active' },
        turn: null,
        links: [{ kind: 'ticket', ref: 'PROJ-456', role: null }],
        blocks: [],
        comments: [],
      }).success,
    ).toBe(true);
  });

  it('shows handed links and the return on task.get and inbox.get turns', () => {
    const op = (id: string) => {
      const operation = OPERATIONS.find((entry) => entry.id === id);
      if (operation === undefined) throw new Error(`Missing ${id}`);
      return operation;
    };
    const at = '2026-01-05T09:30:00.000Z';
    const handed = {
      repo: 'acme/web',
      number: 42,
      kind: 'review',
      id: 'PRR_1',
      postedAt: at,
      url: 'https://github.com/acme/web/pull/42#pullrequestreview-1',
      editedAt: at,
      comments: [
        { id: 'PRRC_1', url: 'https://github.com/acme/web/pull/42#discussion_r1', threadId: 'T_1' },
      ],
    };
    const returned = {
      by: 'agent:rev/rev-1',
      from: 'review',
      turn: 'T2',
      block: 'B5',
      reason: 'Handle the empty list.',
    };
    const turn = { id: 'T3', column: 'dev', addressee: 'worker', at, taken: null, closed: null };
    const task = { key: 'PROJ-123', project: 'web', column: 'dev', membership: 'active' };
    const taskGet = (value: unknown) =>
      op('task.get').output.safeParse({ task, turn: value, links: [], blocks: [], comments: [] });
    expect(taskGet({ ...turn, handed: [handed], returned }).success).toBe(true);
    expect(taskGet({ ...turn, handed: [] }).success).toBe(true);
    expect(taskGet(turn).success).toBe(false);
    expect(taskGet({ ...turn, handed: [], returned: { ...returned, block: 'T2' } }).success).toBe(
      false,
    );
    const inboxTurn = {
      id: 'T3',
      task: 'PROJ-123',
      column: 'dev',
      addressee: 'worker',
      reason: 'Changes were requested.',
      handed: [handed],
      returned,
      head: null,
      at,
      taken: null,
    };
    const inbox = (value: unknown) =>
      op('inbox.get').output.safeParse({ comments: [], blocks: [], turns: [value] });
    expect(inbox(inboxTurn).success).toBe(true);
    expect(inbox({ ...inboxTurn, handed: [{ ...handed, url: 'file:///etc' }] }).success).toBe(
      false,
    );
  });

  it('projects operation grants and mode grants by role', () => {
    const byId = new Map(OPERATIONS.map((operation) => [operation.id, operation]));
    const schema = byId.get('schema.get');
    const tokenList = byId.get('token.list');
    const unblock = byId.get('block.unblock');
    if (schema === undefined || tokenList === undefined || unblock === undefined)
      throw new Error('Missing catalog operation');

    expect(roleCanUseOperation(schema, 'worker')).toBe(true);
    expect(roleCanUseOperation(tokenList, 'worker')).toBe(false);
    expect(roleCanUseOperation(tokenList, 'operator')).toBe(true);
    expect(roleCanUseOperation(unblock, 'orchestrator', 'reason')).toBe(true);
    expect(roleCanUseOperation(unblock, 'orchestrator', 'done')).toBe(false);
    expect(roleCanUseOperation(unblock, 'worker', 'done')).toBe(true);
    expect(roleCanUseOperation(unblock, 'worker', 'withdraw')).toBe(true);
  });

  it('maps every grant to the roles that may hold it', () => {
    // Pins ROLE_GRANTS in src/ops/roles.ts; changing a row is a Changed checks entry.
    const GRANT_HOLDERS: Record<Grant, readonly SchemaRole[]> = {
      operator: ['operator'],
      'project-agent': ['worker', 'orchestrator'],
      'task-worker': ['worker'],
      'column-orchestrator': ['orchestrator'],
      'block-addressee': ['operator', 'worker', 'orchestrator'],
      'block-author': ['operator', 'worker', 'orchestrator'],
    };

    for (const grant of GRANTS) {
      const holders = SCHEMA_ROLES.filter((role) =>
        roleCanUseOperation({ grants: [{ grant }] }, role),
      );
      expect(holders, grant).toEqual(GRANT_HOLDERS[grant]);
      expect(holders.length, grant).toBeGreaterThan(0);
    }
    expect(Object.keys(GRANT_HOLDERS).sort()).toEqual([...GRANTS].sort());
  });

  it('has unique ids, CLI commands and MCP names', () => {
    for (const pick of [
      (op: (typeof OPERATIONS)[number]) => op.id,
      (op: (typeof OPERATIONS)[number]) => op.cli.command,
      (op: (typeof OPERATIONS)[number]) => op.mcp.name,
    ]) {
      const values = OPERATIONS.map(pick);
      expect(new Set(values).size).toBe(values.length);
    }
    for (const op of OPERATIONS) {
      expect(op.mcp.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(op.cli.command).toMatch(/\S/);
    }
  });

  it.each(OPERATIONS.map((op) => [op.id, op] as const))(
    '%s binds the idempotency key exactly when it is a mutation',
    (_id, op) => {
      const mutation = op.kind === 'mutation';
      expect(op.cli.key).toBe(mutation ? '--key' : null);
      expect(op.mcp.key).toBe(mutation ? 'idempotencyKey' : null);
    },
  );

  it('marks only the mutations that write new rows as non-destructive', () => {
    const additive = ['block.ask', 'project.ask', 'comment.add', 'block.create', 'block.followup'];
    const mutations = OPERATIONS.filter((op) => op.kind === 'mutation');
    expect(mutations.filter((op) => !op.mcp.destructive).map((op) => op.id)).toEqual(additive);
    for (const op of mutations) {
      if (additive.includes(op.id)) continue;
      expect(op.mcp.destructive, op.id).toBe(true);
    }
    for (const op of OPERATIONS.filter((entry) => entry.kind === 'query')) {
      expect(op.mcp.destructive, op.id).toBe(false);
    }
  });

  it('never puts the idempotency key into an input schema', () => {
    for (const { input } of schemas) {
      for (const branch of inputBranches(input)) {
        expect(propertyNames(branch)).not.toContain('key');
        expect(propertyNames(branch)).not.toContain('idempotencyKey');
      }
    }
  });

  it('provides use and neighboring-tool guidance for every MCP tool', () => {
    for (const op of OPERATIONS) {
      expect(op.mcp.whenToUse.trim(), op.id).not.toBe('');
      expect(op.mcp.whenNotToUse.trim(), op.id).not.toBe('');
      expect(op.mcp.whenNotToUse, op.id).toMatch(/Use [a-z]+_[a-z]+/);
    }
  });

  it('describes every property and closes every object in inputs and outputs', () => {
    for (const { op, input, output } of schemas) {
      for (const [side, json] of [
        ['input', input],
        ['output', output],
      ] as const) {
        const walked = walk(json);
        expect(walked.undescribed, `${op.id} ${side}`).toEqual([]);
        expect(walked.open, `${op.id} ${side}`).toEqual([]);
      }
    }
  });

  it('bounds every string and array in every input', () => {
    const unbounded: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => {
          visit(child, `${path}[${String(index)}]`);
        });
        return;
      }
      if (!isObject(node)) return;
      const types = [node['type']].flat();
      const fixed = 'enum' in node || 'const' in node;
      if (types.includes('string') && !fixed && typeof node['maxLength'] !== 'number') {
        unbounded.push(`${path} string`);
      }
      if (types.includes('array') && typeof node['maxItems'] !== 'number') {
        unbounded.push(`${path} array`);
      }
      for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
    };
    for (const { op, input } of schemas) visit(input, op.id);
    expect(unbounded).toEqual([]);
  });

  it('refuses an over-long comment and too many inbox acks with usage', () => {
    const add = OPERATIONS.find((op) => op.id === 'comment.add');
    const comment = (text: string) => add?.input.safeParse({ task: 'PROJ-123', text });
    expect(comment('x'.repeat(20_000))?.success).toBe(true);
    const long = comment('x'.repeat(20_001));
    expect(long?.success).toBe(false);
    if (long?.error !== undefined) expect(errorCodeOf(long.error)).toBe('usage');

    const ack = OPERATIONS.find((op) => op.id === 'inbox.ack');
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `C${String(index + 1)}`, revision: 1 }));
    expect(ack?.input.safeParse({ entries: entries(100) }).success).toBe(true);
    const many = ack?.input.safeParse({ entries: entries(101) });
    expect(many?.success).toBe(false);
    if (many?.error !== undefined) expect(errorCodeOf(many.error)).toBe('usage');
  });

  it('lets token.revoke take any name the pre-#242 enrollment could store', () => {
    const revoke = OPERATIONS.find((op) => op.id === 'token.revoke');
    expect(revoke?.input.safeParse({ name: 'x'.repeat(257) }).success).toBe(true);
    expect(revoke?.input.safeParse({ name: 'old desk' }).success).toBe(true);
    const revokeJson = schemas.find(({ op }) => op.id === 'token.revoke')?.input;
    const nameJson = isObject(revokeJson?.['properties']) ? revokeJson['properties']['name'] : {};
    expect(isObject(nameJson) && nameJson['maxLength']).toBe(1_048_576);
  });

  it('caps task keys at 300 characters in inputs only', () => {
    const key300 = `P${'A'.repeat(297)}-1`;
    const key301 = `P${'A'.repeat(298)}-1`;
    expect(key300).toHaveLength(300);
    const get = OPERATIONS.find((op) => op.id === 'task.get');
    const link = OPERATIONS.find((op) => op.id === 'link.add');
    expect(get?.input.safeParse({ task: key300 }).success).toBe(true);
    const long = get?.input.safeParse({ task: key301 });
    expect(long?.success).toBe(false);
    if (long?.error !== undefined) expect(errorCodeOf(long.error)).toBe('usage');

    const getOutput = get?.examples[0]?.output as { task: { key: string } } | undefined;
    const linkOutput = link?.examples[0]?.output as { task: string } | undefined;
    if (getOutput === undefined || linkOutput === undefined) throw new Error('no examples');
    expect(
      get?.output.safeParse({ ...getOutput, task: { ...getOutput.task, key: key301 } }).error,
    ).toBeUndefined();
    expect(link?.output.safeParse({ ...linkOutput, task: key301 }).error).toBeUndefined();
    const linkJson = schemas.find(({ op }) => op.id === 'link.add')?.output;
    const taskJson = isObject(linkJson?.['properties']) ? linkJson['properties']['task'] : {};
    expect(isObject(taskJson) && 'maxLength' in taskJson).toBe(false);
  });

  it('has opaque payloads only at the two named schema.get fields', () => {
    const opaque = schemas.flatMap(({ op, input, output }) => [
      ...walk(input).opaque.map((path) => `${op.id} input${path}`),
      ...walk(output).opaque.map((path) => `${op.id} output${path}`),
    ]);
    expect(opaque).toEqual([
      'schema.get output.operations[].inputSchema',
      'schema.get output.operations[].outputSchema',
    ]);
  });

  it.each(OPERATIONS.map((op) => [op.id, op] as const))('%s examples parse', (_id, op) => {
    expect(op.examples.length).toBeGreaterThan(0);
    for (const example of op.examples) {
      expect(op.input.safeParse(example.input).error).toBeUndefined();
      expect(op.output.safeParse(example.output).error).toBeUndefined();
    }
  });

  it('lists only server errors that exist in the error catalog', () => {
    for (const op of OPERATIONS) {
      for (const code of op.errors) {
        expect(ERRORS[code].status, `${op.id} ${code}`).not.toBeNull();
      }
    }
  });

  it('binds every op to CLI and MCP, and Slack only on the exceptions list', () => {
    const slackExceptions = {
      'status.get': { kind: 'slash-command', usage: '/board status' },
      'task.get': { kind: 'slash-command', usage: '/board task <KEY> [why]' },
      'task.history': { kind: 'slash-command', usage: '/board task <KEY> history' },
      'token.list': { kind: 'slash-command', usage: '/board tokens' },
      'item.retry': { kind: 'button', label: 'Retry' },
      'item.close': { kind: 'button', label: 'Close' },
      'block.answer': { kind: 'thread-reply' },
      'block.followup': { kind: 'thread-reply' },
    };
    const slack = Object.fromEntries(
      OPERATIONS.filter((op) => op.slack !== null).map((op) => [op.id, op.slack]),
    );
    expect(slack).toEqual(slackExceptions);
    expect(
      OPERATIONS.filter((op) => op.slack?.kind === 'slash-command').map((op) => op.id),
    ).toEqual(['status.get', 'task.get', 'task.history', 'token.list']);
    for (const op of OPERATIONS) {
      expect(op.cli.command).not.toBe('');
      expect(op.mcp.name).toBe(op.id.replace('.', '_'));
    }
  });

  it('names an input property with every CLI arg, in every union branch', () => {
    for (const { op, input } of schemas) {
      for (const branch of inputBranches(input)) {
        for (const arg of op.cli.args) expect(propertyNames(branch), op.id).toContain(arg);
      }
    }
  });

  it('binds one CLI flag per branch of a union input, and none to a plain input', () => {
    for (const { op, input } of schemas) {
      const branches = inputBranches(input);
      if (input['oneOf'] === undefined) {
        expect(op.cli.modes, op.id).toBeNull();
        continue;
      }
      const modes = op.cli.modes ?? [];
      expect(modes.map((m) => m.mode).sort(), op.id).toEqual(
        branches.map((branch) => branchMode(branch)).sort(),
      );
      expect(new Set(modes.map((m) => m.flag)).size, op.id).toBe(modes.length);
      for (const { mode, flag, value } of modes) {
        expect(flag, op.id).not.toBe(op.cli.key);
        const branch = branches.find((b) => branchMode(b) === mode);
        if (branch === undefined || value === null) continue;
        expect(propertyNames(branch), `${op.id} ${flag}`).toContain(value);
        expect(['mode', ...op.cli.args], `${op.id} ${flag}`).not.toContain(value);
      }
    }
  });

  it('binds unblock as --done [ref] | --reason <reason> | --withdraw <answer>', () => {
    const unblock = OPERATIONS.find((op) => op.id === 'block.unblock');
    expect(unblock?.cli).toEqual({
      command: 'unblock',
      args: ['block'],
      modes: [
        { mode: 'done', flag: '--done', value: 'ref' },
        { mode: 'reason', flag: '--reason', value: 'reason' },
        { mode: 'withdraw', flag: '--withdraw', value: 'answer' },
      ],
      key: '--key',
    });
    expect(unblock?.input.safeParse({ mode: 'done', block: 'B13' }).success).toBe(true);
    expect(unblock?.input.safeParse({ mode: 'withdraw', block: 'B12' }).success).toBe(false);
    expect(
      unblock?.input.safeParse({ mode: 'withdraw', block: 'B12', answer: 'Answered elsewhere.' })
        .success,
    ).toBe(true);
  });

  it('task.order binds --before/--after <anchor> | --top | --bottom', () => {
    const order = OPERATIONS.find((op) => op.id === 'task.order');
    if (order === undefined) throw new Error('Missing task.order');
    expect(order.cli).toEqual({
      command: 'order',
      args: ['task'],
      modes: [
        { mode: 'before', flag: '--before', value: 'anchor' },
        { mode: 'after', flag: '--after', value: 'anchor' },
        { mode: 'top', flag: '--top', value: null },
        { mode: 'bottom', flag: '--bottom', value: null },
      ],
      key: '--key',
    });
    expect(order.cli.defaultMode).toBeUndefined();
    expect(order.explicitKeyModes).toEqual(['before', 'after', 'top', 'bottom']);
    expect(order.input.safeParse({ mode: 'before', task: 'A-1', anchor: 'A-2' }).success).toBe(
      true,
    );
    expect(order.input.safeParse({ mode: 'after', task: 'A-1' }).success).toBe(false);
    expect(order.input.safeParse({ mode: 'top', task: 'A-1', anchor: 'A-2' }).success).toBe(false);
    expect(order.input.safeParse({ mode: 'bottom', task: 'A-1' }).success).toBe(true);
  });

  it('requires an exact revision when acknowledging a comment', () => {
    const ack = OPERATIONS.find((op) => op.id === 'inbox.ack');
    expect(ack?.input.safeParse({ entries: [{ id: 'C3', revision: 2 }] }).success).toBe(true);
    expect(ack?.input.safeParse({ entries: [{ id: 'C3' }] }).success).toBe(false);
    expect(ack?.input.safeParse({ ids: ['C3'] }).success).toBe(false);
  });

  it('takes the ring id of a doorbell and reports already handled entries', () => {
    const ack = OPERATIONS.find((op) => op.id === 'inbox.ack');
    for (const id of ['N18-1', 'N18']) {
      expect(ack?.input.safeParse({ entries: [{ id }] }).success, id).toBe(true);
    }
    for (const id of ['N0-1', 'N18-0', '(N18-1)', 'N18-1@1', 'N1234567890123456-1']) {
      const result = ack?.input.safeParse({ entries: [{ id }] });
      expect(result?.success, id).toBe(false);
      if (result?.error !== undefined) expect(errorCodeOf(result.error), id).toBe('usage');
    }
    expect(ack?.input.safeParse({ entries: [{ id: 'N18-1', revision: 1 }] }).success).toBe(false);
    expect(ack?.output.safeParse({ acked: ['N18-1'], alreadyHandled: ['N18-1'] }).success).toBe(
      true,
    );
    expect(ack?.output.safeParse({ acked: ['B13'] }).success).toBe(true);
  });

  it('gives wrong_id_kind for a task key passed as a block ID', () => {
    const answer = OPERATIONS.find((op) => op.id === 'block.answer');
    const result = answer?.input.safeParse({ block: 'PROJ-123', text: 'Yes.' });
    expect(result?.success).toBe(false);
    if (result?.error === undefined) return;
    expect(errorCodeOf(result.error)).toBe('wrong_id_kind');
  });
});

describe('grants', () => {
  const operator = { grant: 'operator' };
  const projectAgent = { grant: 'project-agent' };
  const id = ['wrong_id_kind', 'not_found'] as const;
  const archived = [...id, 'task_archived'] as const;
  // id, kind, grants, preconditions, specific errors
  const table: [string, string, unknown, unknown, readonly ServerErrorCode[]][] = [
    ['status.get', 'query', [operator, projectAgent], null, ['not_found']],
    ['task.get', 'query', [operator, projectAgent], null, [...id, 'github_unavailable']],
    ['task.history', 'query', [operator, projectAgent], null, id],
    ['schema.get', 'query', 'any', null, []],
    ['inbox.get', 'query', [projectAgent, operator], null, ['not_found']],
    ['inbox.operator', 'query', [operator], null, []],
    ['inbox.ack', 'mutation', [projectAgent, operator], null, [...id, 'stale_comment_revision']],
    ['token.list', 'query', [operator], null, []],
    ['token.revoke', 'mutation', [operator], null, ['not_found']],
    ['task.add', 'mutation', [operator], null, id],
    ['task.archive', 'mutation', [operator], null, archived],
    [
      'link.add',
      'mutation',
      [operator],
      null,
      [...archived, 'link_conflict', 'github_unavailable'],
    ],
    ['link.remove', 'mutation', [operator], null, archived],
    ['item.retry', 'mutation', [operator], null, [...archived, 'retry_not_applicable']],
    ['item.close', 'mutation', [operator], null, id],
    ['block.ask', 'mutation', [projectAgent], null, archived],
    ['project.ask', 'mutation', [projectAgent], null, ['not_found']],
    ['comment.add', 'mutation', [projectAgent, operator], null, archived],
    ['comment.edit', 'mutation', [projectAgent, operator], null, archived],
    ['block.create', 'mutation', [{ grant: 'column-orchestrator' }, operator], null, archived],
    [
      'block.escalate',
      'mutation',
      [{ grant: 'block-addressee' }],
      null,
      ['wrong_id_kind', 'not_found', 'block_not_open', 'task_archived'],
    ],
    [
      'block.answer',
      'mutation',
      [{ grant: 'block-addressee' }, operator],
      { blockTypes: ['needs_input'] },
      ['wrong_id_kind', 'not_found', 'block_not_open', 'wrong_block_type', 'task_archived'],
    ],
    [
      'block.followup',
      'mutation',
      [operator],
      null,
      ['wrong_id_kind', 'not_found', 'block_still_open', 'task_archived'],
    ],
    [
      'block.unblock',
      'mutation',
      [
        { grant: 'task-worker', mode: 'done', blockTypes: ['code'] },
        { grant: 'block-addressee', mode: 'reason' },
        { grant: 'column-orchestrator', mode: 'reason', blockTypes: ['code'] },
        { grant: 'operator', mode: 'reason' },
        { grant: 'block-author', mode: 'withdraw', blockTypes: ['needs_input'] },
      ],
      null,
      ['wrong_id_kind', 'not_found', 'block_not_open', 'task_archived'],
    ],
    [
      'task.submit',
      'mutation',
      [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }, operator],
      null,
      [
        ...archived,
        'turn_closed',
        'not_turn_taker',
        'submit_basis_invalid',
        'submit_source_not_tested',
        'head_mismatch',
        'github_unavailable',
      ],
    ],
    [
      'task.return',
      'mutation',
      [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }, operator],
      null,
      [...archived, 'turn_closed', 'not_turn_taker', 'return_not_allowed'],
    ],
    [
      'task.wait',
      'mutation',
      [{ grant: 'task-worker' }, { grant: 'column-orchestrator' }, operator],
      null,
      [
        ...archived,
        'not_operator',
        'turn_closed',
        'not_turn_taker',
        'turn_wait_limit',
        'no_active_wait',
      ],
    ],
    [
      'task.move',
      'mutation',
      [operator],
      null,
      [
        ...archived,
        'move_not_allowed',
        'move_outside_todo_group',
        'work_started',
        'column_mirrored',
      ],
    ],
    ['task.order', 'mutation', [operator], null, [...archived, 'order_anchor_invalid']],
    ['config.get', 'query', [operator, projectAgent], null, ['not_found']],
    ['columns.describe', 'query', [operator, projectAgent], null, ['not_found']],
  ];

  it('declares the six grants', () => {
    expect(GRANTS).toEqual([
      'operator',
      'project-agent',
      'task-worker',
      'column-orchestrator',
      'block-addressee',
      'block-author',
    ]);
  });

  it('pins the 31 operations with kinds, grants, preconditions and errors', () => {
    const order = Object.keys(ERRORS);
    expect(
      OPERATIONS.map((op) => [op.id, op.kind, op.grants, op.preconditions, op.errors]),
    ).toEqual(
      table.map(([opId, kind, grants, preconditions, specific]) => {
        const common: ServerErrorCode[] = [
          'usage',
          'forbidden',
          'identity_unavailable',
          'starting',
          'stopping',
          'not_implemented',
        ];
        if (kind === 'mutation') common.push('idempotency_key_mismatch');
        const errors = [...new Set([...common, ...specific])].sort(
          (a, b) => order.indexOf(a) - order.indexOf(b),
        );
        return [opId, kind, grants, preconditions, errors];
      }),
    );
    expect(OPERATIONS).toHaveLength(31);
  });

  it('names a branch of the input discriminator in every grant mode', () => {
    for (const { op, input } of schemas) {
      if (op.grants === 'any') continue;
      const modes = inputBranches(input).flatMap((branch) => branchMode(branch) ?? []);
      for (const rule of op.grants) {
        if (rule.mode !== undefined) expect(modes, op.id).toContain(rule.mode);
      }
    }
  });

  it('lists wrong_block_type only where preconditions exist, on block.answer alone', () => {
    const withPreconditions = OPERATIONS.filter((op) => op.preconditions !== null).map(
      (op) => op.id,
    );
    const withWrongType = OPERATIONS.filter((op) => op.errors.includes('wrong_block_type')).map(
      (op) => op.id,
    );
    expect(withPreconditions).toEqual(['block.answer']);
    expect(withWrongType).toEqual(['block.answer']);
  });

  it('lists task_archived on task mutations only', () => {
    const missing = OPERATIONS.filter(
      (op) => op.kind === 'mutation' && !op.errors.includes('task_archived'),
    ).map((op) => op.id);
    expect(missing).toEqual(['inbox.ack', 'token.revoke', 'task.add', 'item.close', 'project.ask']);
  });
});

describe('comment shape', () => {
  const comment: JsonObject = { ...z.toJSONSchema(commentSchema, { io: 'output' }) };
  delete comment['$schema'];

  it('includes task, block link, revision and trust marker on every comment', () => {
    const properties = isObject(comment['properties']) ? comment['properties'] : {};
    expect(Object.keys(properties)).toEqual([
      'id',
      'task',
      'block',
      'author',
      'at',
      'text',
      'revision',
      'ackedRevision',
      'untrusted',
    ]);
    expect(comment['required']).toEqual(Object.keys(properties));
    expect(properties['untrusted']).toMatchObject({ const: true });
  });

  it('is the comment shape in every output that returns comments', () => {
    const output = (opId: string): JsonObject => {
      const found = schemas.find(({ op }) => op.id === opId);
      const properties = found?.output['properties'];
      return isObject(properties) ? properties : {};
    };
    const itemsOf = (node: unknown) => (isObject(node) ? node['items'] : undefined);
    expect(itemsOf(output('task.get')['comments'])).toEqual(comment);
    expect(itemsOf(output('inbox.get')['comments'])).toEqual(comment);
    expect(output('comment.add')['comment']).toEqual(comment);
    expect(output('comment.edit')['comment']).toEqual(comment);
    expect(output('block.answer')['comment']).toEqual(comment);
    expect(output('block.followup')['comment']).toEqual(comment);
  });

  it('gives every at and *At output property the date-time format', () => {
    const timestamps = schemas.flatMap(({ op, output }) =>
      walk(output)
        .properties.filter(({ name }) => name === 'at' || name.endsWith('At'))
        .map(({ path, node }) => ({ path: `${op.id}${path}`, node })),
    );
    expect(timestamps.length).toBeGreaterThan(0);
    for (const { path, node } of timestamps) {
      const nullable =
        [
          'unblockedAt',
          'completedAt',
          'lastActivityAt',
          'endedAt',
          'factAt',
          'observedAt',
          'lastCompleteAt',
          'approvedAt',
          'lastUsedAt',
          'lastDispatchAt',
          'lastGoodAt',
          'columnEnteredAt',
          'readAt',
        ].some((name) => path.endsWith(name)) && !path.includes('.prSummary');
      expect(Array.isArray(node['anyOf']), path).toBe(nullable);
      const variants: unknown[] = Array.isArray(node['anyOf']) ? node['anyOf'] : [node];
      expect(
        variants.map((variant) =>
          isObject(variant) ? [variant['type'], variant['format']] : [undefined, undefined],
        ),
        path,
      ).toEqual(
        nullable
          ? [
              ['string', 'date-time'],
              ['null', undefined],
            ]
          : [['string', 'date-time']],
      );
    }
  });
});

describe('snapshot', () => {
  it('pins the catalog excluding columns.describe after scoping project operators', async () => {
    const baseline = catalogSnapshotBody(
      OPERATIONS.filter((operation) => operation.id !== 'columns.describe'),
    );
    // Manual moves extend task.move, move views, schema metadata and the error catalog. #761
    // then added sources[].project, sources[].waitsForBudget (the runner's rate limit pause)
    // and board-wide project, sources and services texts to status.get; the external_round kind
    // extends the task.history event kinds. #733 adds the review-rule gate reasons and condition
    // to task.get --why. The web Turn section then set web on inbox.ack, task.submit and
    // task.return; their schemas, grants and errors are unchanged. #738 adds the mirror move kind
    // and reason, sources[].failure and the github-project service texts. #755 adds
    // tasks[].qaSubmission to status.get. #753 adds the optional approvals list to status.get
    // prSummary and task.get PR links. #737 adds task.order, tasks[].position, the
    // order_anchor_invalid code and the task_reordered kind; the task.order description
    // names its one-placement and non-blank key rule. #798 drops the other-project operator
    // source from status.get bindings and rewords the inbox.operator description. #800 names the
    // operator's take of a turn addressed to it in inbox.ack and points it to inbox_operator, the
    // operator kind of unbound columns in config.get and the no-turn Done without a live worker.
    // #804 adds task.wait, the optional turn wait in turn views, the turn_wait_limit code and the
    // turn wait event kinds. #810 adds the optional projects[].columns[].quietAfterMs to
    // config.get. #815 says which items item.close also closes the block of. #826 rewords the
    // task.wait guidance and its reason field. #827 lets the operator end a turn's wait early:
    // task.wait gains end and web, optional for, reason and output wait, the ended outcome, and
    // the not_operator and no_active_wait codes. #841 rewords the task.wait description, its
    // guidance and its reason field: wait only on what the Board cannot see, not on what it watches,
    // unless your own next step needs the watched fact, and names mergeability. #799 adds state
    // and since to status.get unlinkedSessions, and leaves lifecycle, health, healthSince and
    // rateLimitResetAt out of ended and absent ones.
    expect(await catalogVersion(baseline)).toBe(
      '413c63bc851a1df0d93e5c8e31e1d5a315282f3c13546b2fd6c9dcc8cb5dbb3f',
    );
  });
  const throwaway = (input: z.ZodObject, output: z.ZodType) =>
    defineOperation({
      id: 'test.op',
      kind: 'query',
      description: 'Throwaway.',
      input,
      output,
      grants: 'any',
      errors: [],
      cli: { command: 'test', args: [] },
      mcp: { whenToUse: 'Test.', whenNotToUse: 'Use another_test instead.' },
      slack: null,
      examples: [{ summary: 'x', input: {}, output: {} }],
    });
  const plain = z.strictObject({ a: z.string().describe('A.') });
  const transformed = z.strictObject({
    a: z
      .string()
      .transform((s) => s.length)
      .describe('A.'),
  });

  it('throws for a transform on an input field and on an output field', () => {
    expect(() => catalogSnapshotBody([throwaway(plain, plain)])).not.toThrow();
    expect(() => catalogSnapshotBody([throwaway(transformed, plain)])).toThrow(/Transforms/);
    expect(() => catalogSnapshotBody([throwaway(plain, transformed)])).toThrow(/Transforms/);
  });

  it('matches the committed ops.snapshot.json, with version as its hash', async () => {
    const body = catalogSnapshotBody(OPERATIONS);
    const committed: unknown = JSON.parse(
      readFileSync(new URL('../ops.snapshot.json', import.meta.url), 'utf8'),
    );
    const stale = 'ops.snapshot.json is stale: run pnpm gen:ops-snapshot';
    const expected = {
      version: await catalogVersion(body),
      ...body,
    };
    expect(await buildCatalogSnapshot(OPERATIONS)).toEqual(expected);
    expect(committed, stale).toEqual(expected);
  });

  it('hashes key-sorted JSON, so key order does not change the version', async () => {
    expect(await catalogVersion({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
      await catalogVersion({ b: [{ d: 3, c: 2 }], a: 1 }),
    );
    expect(await catalogVersion('')).toMatch(/^[0-9a-f]{64}$/);
  });
});
