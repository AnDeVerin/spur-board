import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ActorId,
  actorIdSchema,
  blockIdSchema,
  commentIdSchema,
  encodeActorId,
  errorCodeOf,
  itemIdSchema,
  parseActorId,
  parseRef,
  taskKeySchema,
} from '../src/index.ts';

describe('typed refs', () => {
  it.each([
    ['B12', { kind: 'block', text: 'B12', n: 12 }],
    ['C3', { kind: 'comment', text: 'C3', n: 3 }],
    ['I7', { kind: 'item', text: 'I7', n: 7 }],
    ['PROJ-123', { kind: 'task', text: 'PROJ-123', form: 'jira' }],
    ['B-12', { kind: 'task', text: 'B-12', form: 'jira' }],
    ['acme/web#42', { kind: 'task', text: 'acme/web#42', form: 'github' }],
    ['web#42', { kind: 'task', text: 'web#42', form: 'github-short' }],
  ])('parses %s', (text, ref) => {
    expect(parseRef(text)).toEqual({ ok: true, value: ref });
  });

  it.each(['B0', 'b12', '#42', '', 'B12x', 'PROJ-0', 'a/b/c#1'])('rejects %j as usage', (text) => {
    expect(parseRef(text)).toEqual({ ok: false, error: 'usage' });
    expect(parseRef(text, 'block')).toEqual({ ok: false, error: 'usage' });
  });

  it('keeps the number of a B, C or I ID a safe integer', () => {
    const largest = parseRef('B999999999999999');
    expect(largest).toMatchObject({ ok: true, value: { kind: 'block', n: 999999999999999 } });
    expect(largest.ok && 'n' in largest.value && Number.isSafeInteger(largest.value.n)).toBe(true);
    for (const text of ['B1000000000000000', 'C9007199254740992', 'I9007199254740993']) {
      expect(parseRef(text), text).toEqual({ ok: false, error: 'usage' });
    }
    const schemas = [
      [blockIdSchema, 'B'],
      [commentIdSchema, 'C'],
      [itemIdSchema, 'I'],
    ] as const;
    for (const [schema, prefix] of schemas) {
      const pattern = new RegExp(String(z.toJSONSchema(schema).pattern));
      expect(pattern.test(`${prefix}999999999999999`)).toBe(true);
      expect(pattern.test(`${prefix}1000000000000000`)).toBe(false);
      expect(schema.safeParse(`${prefix}9007199254740993`).success).toBe(false);
    }
  });

  it('gives wrong_id_kind for a valid ID of another kind', () => {
    expect(parseRef('PROJ-123', 'block')).toEqual({ ok: false, error: 'wrong_id_kind' });
    expect(parseRef('B12', 'task')).toEqual({ ok: false, error: 'wrong_id_kind' });
    expect(parseRef('C3', 'comment')).toMatchObject({ ok: true });
  });

  it('maps a schema failure to wrong_id_kind or usage, with one issue', () => {
    const input = z.strictObject({ block: blockIdSchema, text: z.string() });
    const wrongKind = input.safeParse({ block: 'PROJ-123', text: 'yes' });
    expect(wrongKind.success).toBe(false);
    if (wrongKind.success) return;
    expect(wrongKind.error.issues).toHaveLength(1);
    expect(wrongKind.error.issues[0]?.path).toEqual(['block']);
    expect(errorCodeOf(wrongKind.error)).toBe('wrong_id_kind');

    const malformed = input.safeParse({ block: 'B0', text: 'yes' });
    expect(malformed.success).toBe(false);
    if (malformed.success) return;
    expect(malformed.error.issues).toHaveLength(1);
    expect(errorCodeOf(malformed.error)).toBe('usage');
  });

  it.each([
    [blockIdSchema, 'B12', 'C3'],
    [commentIdSchema, 'C3', 'I7'],
    [itemIdSchema, 'I7', 'B12'],
    [taskKeySchema, 'acme/web#42', 'B12'],
  ])('a schema accepts its kind and rejects another (%#)', (schema, good, bad) => {
    expect(schema.parse(good)).toBe(good);
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it('describes each ID schema with a pattern that matches what it accepts', () => {
    const cases = [
      [blockIdSchema, ['B12'], ['B0', 'C3']],
      [commentIdSchema, ['C3'], ['C0', 'B12']],
      [itemIdSchema, ['I7'], ['I0', 'B12']],
      [taskKeySchema, ['PROJ-123', 'acme/web#42', 'web#42'], ['B12', '#42']],
    ] as const;
    for (const [schema, accepted, rejected] of cases) {
      const json = z.toJSONSchema(schema);
      expect(json.description).toMatch(/\S/);
      const pattern = new RegExp(String(json.pattern));
      for (const text of accepted) expect(pattern.test(text)).toBe(true);
      for (const text of rejected) expect(pattern.test(text)).toBe(false);
    }
  });
});

describe('actor id', () => {
  it.each([
    ['operator', { actor: 'operator' }],
    ['system', { actor: 'system' }],
    ['agent:sb/sb-6949', { actor: 'agent', actorRef: { project: 'sb', session: 'sb-6949' } }],
  ] as const)('round-trips %s', (text, parsed) => {
    expect(parseActorId(text)).toEqual(parsed);
    expect(encodeActorId(parsed)).toBe(text);
    expect(actorIdSchema.parse(text)).toBe(text);
  });

  it.each(['agent:/', 'agent:a/', 'agent:/b', 'agent:a/b/c', 'agent:a b/c', 'Operator'])(
    'rejects %j',
    (text) => {
      expect(parseActorId(text)).toBeNull();
      expect(actorIdSchema.safeParse(text).success).toBe(false);
    },
  );

  it.each([
    ['a/b', 'c'],
    ['a', 'b/c'],
    ['', 'c'],
  ])('refuses to encode project %j, session %j', (project, session) => {
    expect(() => encodeActorId({ actor: 'agent', actorRef: { project, session } })).toThrow(
      /Invalid actor part/,
    );
  });

  it('refuses to encode a missing or extra actorRef', () => {
    expect(() => encodeActorId({ actor: 'agent' })).toThrow(/required/);
    expect(() =>
      encodeActorId({ actor: 'operator', actorRef: { project: 'sb', session: 'sb-1' } }),
    ).toThrow(/only when actor is agent/);
  });

  it('keeps the ActorId type the store columns use', () => {
    const ids: ActorId[] = ['operator', 'system', 'agent:sb/sb-6949'];
    expect(ids.map((id) => actorIdSchema.parse(id))).toEqual(ids);
  });
});
