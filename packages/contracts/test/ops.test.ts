import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERRORS,
  GRANTS,
  OPERATIONS,
  buildCatalogSnapshot,
  type ServerErrorCode,
  commentSchema,
  errorCodeOf,
} from '../src/index.ts';
import { defineOperation } from '../src/ops/define.ts';
import { catalogSnapshotBody, catalogVersion } from '../src/ops/snapshot.ts';
import { type JsonObject, isObject, walk } from './json-schema-walk.ts';

const schemas = OPERATIONS.map((op) => ({
  op,
  input: z.toJSONSchema(op.input, { io: 'input' }),
  output: z.toJSONSchema(op.output, { io: 'output' }),
}));

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

  it('never puts the idempotency key into an input schema', () => {
    for (const { input } of schemas) {
      for (const branch of inputBranches(input)) {
        expect(propertyNames(branch)).not.toContain('key');
        expect(propertyNames(branch)).not.toContain('idempotencyKey');
      }
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
      'task.get': { kind: 'slash-command', usage: '/board task <KEY>' },
      'task.history': { kind: 'slash-command', usage: '/board task <KEY> history' },
      'item.retry': { kind: 'button', label: 'Retry' },
      'item.close': { kind: 'button', label: 'Close' },
      'block.answer': { kind: 'thread-reply' },
    };
    const slack = Object.fromEntries(
      OPERATIONS.filter((op) => op.slack !== null).map((op) => [op.id, op.slack]),
    );
    expect(slack).toEqual(slackExceptions);
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

  it('binds unblock as --done <ref> | --reason <reason> | --withdraw', () => {
    const unblock = OPERATIONS.find((op) => op.id === 'block.unblock');
    expect(unblock?.cli).toEqual({
      command: 'unblock',
      args: ['block'],
      modes: [
        { mode: 'done', flag: '--done', value: 'ref' },
        { mode: 'reason', flag: '--reason', value: 'reason' },
        { mode: 'withdraw', flag: '--withdraw', value: null },
      ],
      key: '--key',
    });
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
    ['task.get', 'query', [operator, projectAgent], null, id],
    ['task.history', 'query', [operator, projectAgent], null, id],
    ['schema.get', 'query', 'any', null, []],
    ['inbox.get', 'query', [projectAgent, operator], null, ['not_found']],
    ['inbox.ack', 'mutation', [projectAgent], null, id],
    ['task.add', 'mutation', [operator], null, id],
    ['task.archive', 'mutation', [operator], null, archived],
    ['link.add', 'mutation', [operator], null, archived],
    ['link.remove', 'mutation', [operator], null, archived],
    ['item.retry', 'mutation', [operator], null, [...archived, 'retry_not_applicable']],
    ['item.close', 'mutation', [operator], null, id],
    ['block.ask', 'mutation', [projectAgent], null, archived],
    ['comment.add', 'mutation', [projectAgent, operator], null, archived],
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

  it('pins the 18 operations with kinds, grants, preconditions and errors', () => {
    const order = Object.keys(ERRORS);
    expect(
      OPERATIONS.map((op) => [op.id, op.kind, op.grants, op.preconditions, op.errors]),
    ).toEqual(
      table.map(([opId, kind, grants, preconditions, specific]) => {
        const common: ServerErrorCode[] = ['usage', 'forbidden', 'identity_unavailable'];
        if (kind === 'mutation') common.push('idempotency_key_mismatch');
        const errors = [...new Set([...common, ...specific])].sort(
          (a, b) => order.indexOf(a) - order.indexOf(b),
        );
        return [opId, kind, grants, preconditions, errors];
      }),
    );
    expect(OPERATIONS).toHaveLength(18);
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

  it('lists task_archived on every mutation except task.add, inbox.ack and item.close', () => {
    const missing = OPERATIONS.filter(
      (op) => op.kind === 'mutation' && !op.errors.includes('task_archived'),
    ).map((op) => op.id);
    expect(missing).toEqual(['inbox.ack', 'task.add', 'item.close']);
  });
});

describe('comment shape', () => {
  const comment: JsonObject = { ...z.toJSONSchema(commentSchema, { io: 'output' }) };
  delete comment['$schema'];

  it('is {id, author, at, text, untrusted: true}, all required', () => {
    const properties = isObject(comment['properties']) ? comment['properties'] : {};
    expect(Object.keys(properties)).toEqual(['id', 'author', 'at', 'text', 'untrusted']);
    expect(comment['required']).toEqual(['id', 'author', 'at', 'text', 'untrusted']);
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
    expect(output('block.answer')['comment']).toEqual(comment);
  });

  it('gives every at and *At output property the date-time format', () => {
    const timestamps = schemas.flatMap(({ op, output }) =>
      walk(output)
        .properties.filter(({ name }) => name === 'at' || name.endsWith('At'))
        .map(({ path, node }) => ({ path: `${op.id}${path}`, format: node['format'] })),
    );
    expect(timestamps.length).toBeGreaterThan(0);
    for (const { path, format } of timestamps) expect(format, path).toBe('date-time');
  });
});

describe('snapshot', () => {
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
