import { z } from 'zod';
import type { Actor } from './enums.ts';
import { type Result, err, ok } from './errors.ts';

/** Kinds of ID an operation takes: `B<n>`, `C<n>`, `I<n>`, `T<n>`, or a tracker task key. */
export const REF_KINDS = ['block', 'comment', 'item', 'turn', 'task'] as const;
export type RefKind = (typeof REF_KINDS)[number];

export type TypedRef =
  | { kind: 'block' | 'comment' | 'item' | 'turn'; text: string; n: number }
  | { kind: 'task'; text: string; form: 'jira' | 'github' | 'github-short' };

/**
 * Number in an ID or a task key: at most 15 digits, so it always converts to a safe integer
 * and two different IDs never share one number. A longer number is `usage`.
 */
const N = '[1-9]\\d{0,14}';
/** Regex source of a Jira project key prefix, as in `PROJ-12`, in either letter case. */
export const JIRA_PROJECT_KEY = '[A-Za-z][A-Za-z0-9_]*';
const TASK_FORMS = [
  { form: 'jira', source: `${JIRA_PROJECT_KEY}-${N}` },
  { form: 'github', source: `[A-Za-z0-9-]+\\/[A-Za-z0-9._-]+#${N}` },
  { form: 'github-short', source: `[A-Za-z0-9._-]+#${N}` },
] as const;

const PATTERNS: Record<RefKind, string> = {
  block: `^B${N}$`,
  comment: `^C${N}$`,
  item: `^I${N}$`,
  turn: `^T${N}$`,
  task: `^(?:${TASK_FORMS.map((t) => t.source).join('|')})$`,
};
const NUMBERED_KINDS = ['block', 'comment', 'item', 'turn'] as const;

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
 * Parses a block, comment, item or turn ID or a task key. Numbered IDs are tried first, so
 * `B12` is a block and `B-12` a Jira key. A valid ID of another kind than `expected` is
 * `wrong_id_kind`; anything else that does not parse is `usage`.
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
  turn: 'T4',
  task: 'PROJ-123, owner/repo#42 or repo#42',
};

/** A numbered ID is a letter and at most 15 digits, so never longer than 16 characters. */
const NUMBERED_ID_MAX = 16;
/** Longest task key an operation input takes. Stored and reported keys have no length cap. */
const TASK_KEY_INPUT_MAX = 300;

/** `max` goes on the base string before the refinement, so the JSON Schema keeps `pattern`. */
function refSchema(kind: RefKind, description: string, max?: number) {
  const base = z.string();
  return (max === undefined ? base : base.max(max))
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

export const blockIdSchema = refSchema(
  'block',
  'Block ID: B followed by a number, e.g. B12.',
  NUMBERED_ID_MAX,
);
export const commentIdSchema = refSchema(
  'comment',
  'Comment ID: C followed by a number, e.g. C3.',
  NUMBERED_ID_MAX,
);
export const itemIdSchema = refSchema(
  'item',
  'Item ID: I followed by a number, e.g. I7.',
  NUMBERED_ID_MAX,
);
export const turnIdSchema = refSchema(
  'turn',
  'Turn ID: T followed by a number, e.g. T4.',
  NUMBERED_ID_MAX,
);
const TASK_KEY_DESCRIPTION =
  'Task key: a Jira key (PROJ-123) or a GitHub issue (owner/repo#42, or repo#42).';
export const taskKeySchema = refSchema('task', TASK_KEY_DESCRIPTION);
/** The task key an operation input takes: `taskKeySchema` with a length cap. */
export const taskKeyInputSchema = refSchema('task', TASK_KEY_DESCRIPTION, TASK_KEY_INPUT_MAX);

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
