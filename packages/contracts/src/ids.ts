import { z } from 'zod';
import type { Actor } from './enums.ts';
import { type Result, err, ok } from './errors.ts';

/** Kinds of ID an operation takes: `B<n>`, `C<n>`, `I<n>`, or a tracker task key. */
export const REF_KINDS = ['block', 'comment', 'item', 'task'] as const;
export type RefKind = (typeof REF_KINDS)[number];

export type TypedRef =
  | { kind: 'block' | 'comment' | 'item'; text: string; n: number }
  | { kind: 'task'; text: string; form: 'jira' | 'github' | 'github-short' };

const N = '[1-9]\\d*';
/**
 * Number in a `B`, `C` or `I` ID: at most 15 digits, so it always converts to a safe integer
 * and two different IDs never share one `n`. A longer number is `usage`.
 */
const ID_N = '[1-9]\\d{0,14}';
const TASK_FORMS = [
  { form: 'jira', source: `[A-Za-z][A-Za-z0-9_]*-${N}` },
  { form: 'github', source: `[A-Za-z0-9-]+\\/[A-Za-z0-9._-]+#${N}` },
  { form: 'github-short', source: `[A-Za-z0-9._-]+#${N}` },
] as const;

const PATTERNS: Record<RefKind, string> = {
  block: `^B${ID_N}$`,
  comment: `^C${ID_N}$`,
  item: `^I${ID_N}$`,
  task: `^(?:${TASK_FORMS.map((t) => t.source).join('|')})$`,
};
const NUMBERED_KINDS = ['block', 'comment', 'item'] as const;

function matchRef(text: string): TypedRef | null {
  for (const kind of NUMBERED_KINDS) {
    if (new RegExp(PATTERNS[kind]).test(text)) return { kind, text, n: Number(text.slice(1)) };
  }
  for (const { form, source } of TASK_FORMS) {
    if (new RegExp(`^${source}$`).test(text)) return { kind: 'task', text, form };
  }
  return null;
}

/**
 * Parses a block, comment or item ID or a task key. Block, comment and item IDs are tried
 * first, so `B12` is a block and `B-12` a Jira key. A valid ID of another kind than `expected`
 * is `wrong_id_kind`; anything else that does not parse is `usage`.
 */
export function parseRef(
  text: string,
  expected?: RefKind,
): Result<TypedRef, 'usage' | 'wrong_id_kind'> {
  const ref = matchRef(text);
  if (ref === null) return err('usage');
  if (expected !== undefined && ref.kind !== expected) return err('wrong_id_kind');
  return ok(ref);
}

const EXAMPLES: Record<RefKind, string> = {
  block: 'B12',
  comment: 'C3',
  item: 'I7',
  task: 'PROJ-123, owner/repo#42 or repo#42',
};

function refSchema(kind: RefKind, description: string) {
  return z
    .string()
    .superRefine((value, ctx) => {
      const result = parseRef(value, kind);
      if (result.ok) return;
      ctx.addIssue({
        code: 'custom',
        message:
          result.error === 'wrong_id_kind'
            ? `Expected a ${kind} ID like ${EXAMPLES[kind]}, got a ${String(matchRef(value)?.kind)} ID`
            : `Expected a ${kind} ID like ${EXAMPLES[kind]}`,
        params: { code: result.error },
      });
    })
    .meta({ pattern: PATTERNS[kind] })
    .describe(description);
}

export const blockIdSchema = refSchema('block', 'Block ID: B followed by a number, e.g. B12.');
export const commentIdSchema = refSchema('comment', 'Comment ID: C followed by a number, e.g. C3.');
export const itemIdSchema = refSchema('item', 'Item ID: I followed by a number, e.g. I7.');
export const taskKeySchema = refSchema(
  'task',
  'Task key: a Jira key (PROJ-123) or a GitHub issue (owner/repo#42, or repo#42).',
);

/** The error code for a failed parse: `wrong_id_kind` when an ID of another kind was given. */
export function errorCodeOf(error: z.ZodError): 'usage' | 'wrong_id_kind' {
  const wrongKind = error.issues.some(
    (issue) => issue.code === 'custom' && issue.params?.['code'] === 'wrong_id_kind',
  );
  return wrongKind ? 'wrong_id_kind' : 'usage';
}

const ACTOR_PART = /^[A-Za-z0-9._-]+$/;

/** A spur project or session name inside an actor ID. It never contains `/`. */
export const actorPartSchema = z
  .string()
  .regex(ACTOR_PART, 'Expected letters, digits, ".", "_" or "-"');

/**
 * Who did something, as one string: `operator`, `system`, or `agent:<project>/<session>` for
 * an agent, naming its spur project and session. Every store column that records a doer uses
 * it. The session lets the dispatcher accept a submission only from the column's executor and
 * a withdrawal only from the block's author, and keeps the `(actor, key)` pair of a command
 * from mixing two agents' idempotency keys. The journal records the same facts split into
 * `actor` and `actorRef`; `encodeActorId` and `parseActorId` convert between the two forms.
 */
export const actorIdSchema = z
  .union([
    z.literal('operator'),
    z.literal('system'),
    z.templateLiteral(['agent:', actorPartSchema, '/', actorPartSchema]),
  ])
  .describe('Actor: operator, system, or agent:<project>/<session>.');
export type ActorId = z.output<typeof actorIdSchema>;

export type ParsedActorId =
  | { actor: 'operator' | 'system' }
  | { actor: 'agent'; actorRef: { project: string; session: string } };

/** Joins the journal's `actor` and `actorRef` into an `ActorId`. Throws on an invalid pair. */
export function encodeActorId(value: {
  actor: Actor;
  actorRef?: { project: string; session: string } | undefined;
}): ActorId {
  const { actor, actorRef } = value;
  if (actor !== 'agent') {
    if (actorRef !== undefined) throw new Error('actorRef is set only when actor is agent');
    return actor;
  }
  if (actorRef === undefined) throw new Error('actorRef is required when actor is agent');
  for (const part of [actorRef.project, actorRef.session]) {
    if (!ACTOR_PART.test(part)) {
      throw new Error(`Invalid actor part ${JSON.stringify(part)}: use letters, digits, . _ -`);
    }
  }
  return `agent:${actorRef.project}/${actorRef.session}`;
}

/** Splits an `ActorId` into `actor` and `actorRef`; `null` when the text is not an actor ID. */
export function parseActorId(text: string): ParsedActorId | null {
  const result = actorIdSchema.safeParse(text);
  if (!result.success) return null;
  const id = result.data;
  if (id === 'operator' || id === 'system') return { actor: id };
  const [project = '', session = ''] = id.slice('agent:'.length).split('/');
  return { actor: 'agent', actorRef: { project, session } };
}
