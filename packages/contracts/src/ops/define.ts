import { z } from 'zod';
import { BLOCK_TYPES, type BlockType } from '../enums.ts';
import { ERRORS, type ServerErrorCode } from '../errors.ts';

/** Who may call an operation. Core evaluates them (#34); the catalog only declares them. */
export const GRANTS = [
  'operator',
  'project-agent',
  'task-worker',
  'column-orchestrator',
  'block-addressee',
  'block-author',
] as const;
export type Grant = (typeof GRANTS)[number];

/**
 * One way to be allowed to call an operation. `mode` limits the rule to one branch of the
 * input's `mode` discriminator; `blockTypes` limits it to blocks of those types. A caller that
 * matches no rule gets `forbidden`.
 */
export const grantRuleSchema = z
  .strictObject({
    grant: z.enum(GRANTS).describe('Who the rule admits.'),
    mode: z
      .string()
      .min(1)
      .optional()
      .describe('Input mode the rule applies to; absent means every mode.'),
    blockTypes: z
      .array(z.enum(BLOCK_TYPES))
      .min(1)
      .optional()
      .describe('Block types the rule applies to; absent means every type.'),
  })
  .describe('A grant rule: who may call the operation, optionally for one mode or block type.');
export type GrantRule = z.output<typeof grantRuleSchema>;

/**
 * A CLI flag that picks one branch of a union input: `--done <ref>` sets `mode: 'done'` and
 * passes its value as `ref`. `value` is null for a flag that takes no value, like `--withdraw`.
 */
export const cliModeSchema = z
  .strictObject({
    mode: z.string().min(1).describe('Branch of the input `mode` discriminator the flag picks.'),
    flag: z
      .string()
      .regex(/^--[a-z][a-z-]*$/)
      .describe('CLI flag that picks the branch, e.g. --done.'),
    value: z
      .string()
      .min(1)
      .nullable()
      .describe('Input field the flag value fills; null for a flag without a value.'),
  })
  .describe('A CLI flag that picks one input mode.');
export type CliMode = z.output<typeof cliModeSchema>;

/**
 * How the CLI shapes an operation's terminal output when the boolean input field `when` is true:
 * `lead` prints `<label>: <text at path>` first, and `hide` leaves out the entries of the array at
 * its path whose boolean `field` is false, unless `flag` is passed. JSON output is never shaped.
 */
export interface CliView {
  when: string;
  lead: { label: string; path: readonly [string, ...string[]] };
  hide: {
    path: readonly [string, ...string[]];
    field: string;
    flag: `--${string}`;
    description: string;
  };
}

export const OPERATION_KINDS = ['query', 'mutation'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** How Slack reaches an operation, for the few operations that Slack exposes at all. */
export type SlackBinding =
  | { kind: 'slash-command'; usage: string }
  | { kind: 'button'; label: string }
  | { kind: 'thread-reply' };

type OperationInput = z.ZodObject | z.ZodDiscriminatedUnion;

interface Example<I extends z.ZodType, O extends z.ZodType> {
  summary: string;
  input: z.input<I>;
  output: z.output<O>;
}

type Grants = 'any' | readonly [GrantRule, ...GrantRule[]];

/** A catalog entry as `defineOperation` returns it, with bindings and effective errors. */
export interface Operation<
  Id extends string = string,
  K extends OperationKind = OperationKind,
  I extends OperationInput = OperationInput,
  O extends z.ZodType = z.ZodType,
> {
  id: Id;
  kind: K;
  description: string;
  input: I;
  output: O;
  grants: Grants;
  /** Block state the operation needs; a block of another type gives `wrong_block_type`. */
  preconditions: { blockTypes: readonly BlockType[] } | null;
  /** Every error the operation can return: the common ones plus its own, in `ERRORS` order. */
  errors: readonly ServerErrorCode[];
  /** Modes requiring a caller-chosen key even for operators. */
  explicitKeyModes?: readonly string[];
  /** `modes`: one flag per branch of a union input; null when the input is a plain object. */
  cli: {
    command: string;
    args: readonly string[];
    modes: readonly CliMode[] | null;
    defaultMode?: string;
    key: '--key' | null;
    /** Terminal output shaping; absent for plain human output. */
    view?: CliView;
  };
  mcp: {
    name: string;
    key: 'idempotencyKey' | null;
    whenToUse: string;
    whenNotToUse: string;
    /** MCP `destructiveHint`: false for a query and for a mutation that writes only new rows. */
    destructive: boolean;
  };
  slack: SlackBinding | null;
  /** Exposed to the operator through the optional web listener. */
  web: true | null;
  examples: readonly [Example<I, O>, ...Example<I, O>[]];
}

const COMMON_ERRORS: readonly ServerErrorCode[] = [
  'usage',
  'forbidden',
  'identity_unavailable',
  'starting',
  'stopping',
  'not_implemented',
];
const MUTATION_ERRORS: readonly ServerErrorCode[] = ['idempotency_key_mismatch'];

/**
 * Builds a catalog entry. The operation lists only its own errors; the common ones are added
 * here. Mutations get the idempotency key binding (`--key`, MCP `idempotencyKey`); input
 * schemas never contain the key.
 */
export function defineOperation<
  Id extends string,
  K extends OperationKind,
  I extends OperationInput,
  O extends z.ZodType,
>(spec: {
  id: Id;
  kind: K;
  description: string;
  input: I;
  output: O;
  grants: Grants;
  preconditions?: { blockTypes: readonly BlockType[] };
  errors: readonly ServerErrorCode[];
  explicitKeyModes?: readonly string[];
  cli: {
    command: string;
    args: readonly string[];
    modes?: readonly [CliMode, ...CliMode[]];
    defaultMode?: string;
    view?: CliView;
  };
  mcp: { whenToUse: string; whenNotToUse: string; destructive?: boolean };
  slack: SlackBinding | null;
  web?: true | null;
  examples: readonly [Example<I, O>, ...Example<I, O>[]];
}): Operation<Id, K, I, O> {
  const mutation = spec.kind === 'mutation';
  for (const mode of [
    ...(spec.explicitKeyModes ?? []),
    ...(spec.cli.defaultMode === undefined ? [] : [spec.cli.defaultMode]),
  ]) {
    if (!spec.cli.modes?.some((entry) => entry.mode === mode))
      throw new Error(`Unknown mode ${mode} in ${spec.id}.`);
  }
  if (!mutation && spec.explicitKeyModes?.length)
    throw new Error('Only mutations require explicit keys.');
  if (spec.cli.view !== undefined)
    checkView(spec.id, spec.input, spec.cli.modes ?? [], spec.cli.view);
  const order = Object.keys(ERRORS);
  const errors = [
    ...new Set([...COMMON_ERRORS, ...(mutation ? MUTATION_ERRORS : []), ...spec.errors]),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    ...spec,
    web: spec.web ?? null,
    preconditions: spec.preconditions ?? null,
    errors,
    cli: {
      command: spec.cli.command,
      args: spec.cli.args,
      modes: spec.cli.modes ?? null,
      ...(spec.cli.defaultMode === undefined ? {} : { defaultMode: spec.cli.defaultMode }),
      key: mutation ? '--key' : null,
      ...(spec.cli.view === undefined ? {} : { view: spec.cli.view }),
    },
    mcp: {
      name: spec.id.replace('.', '_'),
      key: mutation ? 'idempotencyKey' : null,
      ...spec.mcp,
      destructive: mutation ? (spec.mcp.destructive ?? true) : false,
    },
  };
}

/** The CLI flag of an input field: `--` and the field name in kebab case. */
const fieldFlag = (field: string) =>
  `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/**
 * A CLI view reads a boolean input field and binds a flag no input field, mode, `--key` or
 * `--json` already takes.
 */
function checkView(
  id: string,
  input: OperationInput,
  modes: readonly CliMode[],
  view: CliView,
): void {
  const shapes = (
    input instanceof z.ZodDiscriminatedUnion ? input.options : [input]
  ) as readonly z.ZodObject[];
  const fields = shapes.flatMap((shape) => Object.entries(shape.shape));
  const when = fields.filter(([name]) => name === view.when).map(([, schema]) => schema);
  const boolean = (schema: z.ZodType) =>
    (schema instanceof z.ZodOptional ? schema.unwrap() : schema) instanceof z.ZodBoolean;
  if (when.length === 0 || !when.every((schema) => boolean(schema as z.ZodType)))
    throw new Error(`CLI view of ${id} needs a boolean input field ${view.when}.`);
  const taken = new Set([
    ...fields.map(([name]) => fieldFlag(name)),
    ...modes.map((mode) => mode.flag),
    '--key',
    '--json',
  ]);
  if (taken.has(view.hide.flag))
    throw new Error(`CLI view flag ${view.hide.flag} of ${id} is already taken.`);
}
