// Reads a GraphQL request with the real parser, compares its shape and answers its selection.
import {
  Kind,
  parse,
  type ArgumentNode,
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type TypeNode,
  type ValueNode,
} from 'graphql';
import { z } from 'zod';
import { FakeViolation } from './fetch.ts';

type Variables = Readonly<Record<string, unknown>>;
export type Args = Readonly<Record<string, unknown>>;

/** A field whose object does not exist: answers null with a `NOT_FOUND` error at its path. */
export class NotFound {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

/** Plain data the walker selects from; a function field computes its value from its arguments. */
export type Wire =
  | null
  | boolean
  | number
  | string
  | NotFound
  | readonly Wire[]
  | WireObject
  | ((args: Args) => Wire);
export interface WireObject {
  readonly [field: string]: Wire;
}

interface GraphqlError {
  type: 'NOT_FOUND';
  path: (string | number)[];
  message: string;
}

const requestSchema = z.strictObject({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).default({}),
});

function typeText(type: TypeNode): string {
  if (type.kind === Kind.NON_NULL_TYPE) return `${typeText(type.type)}!`;
  if (type.kind === Kind.LIST_TYPE) return `[${typeText(type.type)}]`;
  return type.name.value;
}

function parseDocument(query: string): OperationDefinitionNode {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (err) {
    throw new FakeViolation(`GraphQL syntax error: ${(err as Error).message}`);
  }
  const [operation, ...rest] = document.definitions;
  if (operation?.kind !== Kind.OPERATION_DEFINITION || rest.length > 0)
    throw new FakeViolation('Expected a document holding exactly one operation.');
  return operation;
}

/** Parses a request body and checks its variables against the operation's definitions. */
export function parseGraphqlRequest(body: string): {
  operation: OperationDefinitionNode;
  variables: Variables;
} {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new FakeViolation('The GraphQL request body is not JSON.');
  }
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) throw new FakeViolation('Expected a body of { query, variables }.');
  const { query, variables } = parsed.data;
  const operation = parseDocument(query);
  const defined = new Map(
    (operation.variableDefinitions ?? []).map((definition) => [
      definition.variable.name.value,
      typeText(definition.type),
    ]),
  );
  for (const name of Object.keys(variables))
    if (!defined.has(name)) throw new FakeViolation(`Variable $${name} is not defined.`);
  for (const [name, type] of defined) {
    const value = variables[name];
    const fits =
      type === 'String!'
        ? typeof value === 'string'
        : type === 'Int!'
          ? Number.isInteger(value)
          : false;
    if (!fits) throw new FakeViolation(`Variable $${name} is not a ${type}.`);
  }
  return { operation, variables };
}

function printValue(value: ValueNode): string {
  switch (value.kind) {
    case Kind.VARIABLE:
      return `$${value.name.value}`;
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.ENUM:
      return value.value;
    case Kind.STRING:
      return JSON.stringify(value.value);
    case Kind.BOOLEAN:
      return String(value.value);
    case Kind.NULL:
      return 'null';
    case Kind.LIST:
      return `[${value.values.map(printValue).join(',')}]`;
    case Kind.OBJECT:
      return `{${value.fields
        .map((field) => `${field.name.value}:${printValue(field.value)}`)
        .sort()
        .join(',')}}`;
  }
}

/** The PR number argument of an aliased root, which the canonical form replaces. */
const NUMBER_ARGUMENT: Readonly<Record<string, string>> = {
  pullRequest: 'number',
  isRequired: 'pullRequestNumber',
};
const PLACEHOLDER = '#';

function printArgument(field: FieldNode, argument: ArgumentNode, number?: string): string {
  const name = argument.name.value;
  if (
    number !== undefined &&
    NUMBER_ARGUMENT[field.name.value] === name &&
    argument.value.kind === Kind.INT
  ) {
    if (argument.value.value !== number)
      throw new FakeViolation(
        `${field.name.value}(${name}: ${argument.value.value}) differs from the alias's pull request ${number}.`,
      );
    return `${name}:${PLACEHOLDER}`;
  }
  return `${name}:${printValue(argument.value)}`;
}

/** No known shape has a directive, and the answer would ignore one such as `@skip`. */
function refuseDirectives(node: { readonly directives?: readonly DirectiveNode[] | undefined }) {
  const name = node.directives?.[0]?.name.value;
  if (name !== undefined)
    throw new FakeViolation(`Directive @${name} is not part of any known shape.`);
}

function printSelection(selection: SelectionNode, number?: string): string {
  if (selection.kind === Kind.FRAGMENT_SPREAD)
    throw new FakeViolation('Fragment spreads are not part of any known shape.');
  refuseDirectives(selection);
  if (selection.kind === Kind.INLINE_FRAGMENT)
    return `...on ${selection.typeCondition?.name.value ?? ''}${printSet(selection.selectionSet, number)}`;
  const alias = selection.alias === undefined ? '' : `${selection.alias.value}:`;
  const args = (selection.arguments ?? [])
    .map((argument) => printArgument(selection, argument, number))
    .sort()
    .join(',');
  const set = selection.selectionSet === undefined ? '' : printSet(selection.selectionSet, number);
  return `${alias}${selection.name.value}${args === '' ? '' : `(${args})`}${set}`;
}

function printSet(set: SelectionSetNode, number?: string): string {
  return `{${set.selections
    .map((selection) => printSelection(selection, number))
    .sort()
    .join(' ')}}`;
}

function aliasNumber(field: FieldNode): string {
  const pullRequest = field.selectionSet?.selections.find(
    (selection): selection is FieldNode =>
      selection.kind === Kind.FIELD && selection.name.value === 'pullRequest',
  );
  const argument = pullRequest?.arguments?.find((arg) => arg.name.value === 'number');
  if (argument?.value.kind !== Kind.INT)
    throw new FakeViolation(`Alias ${field.alias?.value ?? ''} names no literal pull request.`);
  return argument.value.value;
}

/** Alias numbers must run from `pr0` without a gap, and every alias must have one template. */
function printAliases(aliases: readonly FieldNode[]): string[] {
  const indexes = aliases.map((field) => Number(field.alias?.value.slice(2))).sort((a, b) => a - b);
  if (indexes.some((index, position) => index !== position))
    throw new FakeViolation(`The pr<i> aliases are not contiguous from 0: ${indexes.join(', ')}.`);
  const templates = new Set(
    aliases.map((field) => {
      const printed = printSelection({ ...field, alias: undefined }, aliasNumber(field));
      return `pr<i>:${printed}`;
    }),
  );
  if (templates.size > 1) throw new FakeViolation('The pr<i> aliases select different fields.');
  return [...templates];
}

/**
 * One text per request shape: selections, arguments and variable definitions in sorted order, and
 * `pr<i>` root aliases collapsed to one template with the pull request number replaced. A directive
 * or a variable default has no canonical form and throws `FakeViolation`.
 */
export function canonicalize(operation: OperationDefinitionNode): string {
  refuseDirectives(operation);
  const aliases: FieldNode[] = [];
  const others: SelectionNode[] = [];
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind === Kind.FIELD && /^pr\d+$/.test(selection.alias?.value ?? ''))
      aliases.push(selection);
    else others.push(selection);
  }
  const variables = (operation.variableDefinitions ?? [])
    .map((definition) => {
      const name = definition.variable.name.value;
      refuseDirectives(definition);
      if (definition.defaultValue !== undefined)
        throw new FakeViolation(`Variable $${name} has a default, which no known shape has.`);
      return `$${name}:${typeText(definition.type)}`;
    })
    .sort()
    .join(',');
  const roots = [
    ...others.map((selection) => printSelection(selection)),
    ...printAliases(aliases),
  ].sort();
  return `${operation.operation} ${operation.name?.value ?? ''}(${variables}){${roots.join(' ')}}`;
}

/** The canonical form of a query text; throws `FakeViolation` if it cannot be read. */
export function canonicalizeQuery(query: string): string {
  return canonicalize(parseDocument(query));
}

function argumentValue(value: ValueNode, variables: Variables): unknown {
  switch (value.kind) {
    case Kind.VARIABLE:
      return variables[value.name.value];
    case Kind.INT:
    case Kind.FLOAT:
      return Number(value.value);
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return value.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return value.values.map((item) => argumentValue(item, variables));
    case Kind.OBJECT:
      return Object.fromEntries(
        value.fields.map((field) => [field.name.value, argumentValue(field.value, variables)]),
      );
  }
}

function isWireObject(value: Wire): value is WireObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof NotFound)
  );
}

/** Answers an operation by walking its selection set over plain wire objects. */
export function project(
  operation: OperationDefinitionNode,
  variables: Variables,
  root: WireObject,
): { data: unknown; errors: GraphqlError[] } {
  const errors: GraphqlError[] = [];

  function resolve(
    value: Wire,
    set: SelectionSetNode | undefined,
    path: (string | number)[],
  ): unknown {
    if (value instanceof NotFound) {
      errors.push({ type: 'NOT_FOUND', path, message: value.message });
      return null;
    }
    if (Array.isArray(value))
      return (value as readonly Wire[]).map((item, index) => resolve(item, set, [...path, index]));
    if (!isWireObject(value)) return value;
    if (set === undefined) throw new FakeViolation(`${path.join('.')} needs a selection.`);
    const out: Record<string, unknown> = {};
    select(set, value, path, out);
    return out;
  }

  function select(
    set: SelectionSetNode,
    value: WireObject,
    path: (string | number)[],
    out: Record<string, unknown>,
  ): void {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD)
        throw new FakeViolation('Fragment spreads are not part of any known shape.');
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const type = selection.typeCondition?.name.value;
        if (type === undefined || value['__typename'] === type)
          select(selection.selectionSet, value, path, out);
        continue;
      }
      const name = selection.name.value;
      const key = selection.alias?.value ?? name;
      const field = value[name];
      if (field === undefined)
        throw new FakeViolation(`The fake has no field ${[...path, name].join('.')}.`);
      const args = Object.fromEntries(
        (selection.arguments ?? []).map((argument) => [
          argument.name.value,
          argumentValue(argument.value, variables),
        ]),
      );
      out[key] = resolve(
        typeof field === 'function' ? field(args) : field,
        selection.selectionSet,
        [...path, key],
      );
    }
  }

  const data: Record<string, unknown> = {};
  select(operation.selectionSet, root, [], data);
  return { data, errors };
}
