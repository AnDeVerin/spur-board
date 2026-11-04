import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type JsonSchemaValidatorResult,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OPERATIONS, ERRORS, renderMcpError, type Operation } from '@spur-board/contracts';
import { z } from 'zod';
import { requestOperation } from './client.ts';
import { loadClientConfig } from './config.ts';
import { CliError } from './exit-codes.ts';

type JsonObject = Record<string, unknown>;

// The SDK validates before the callback. Admit arguments here so all usage errors can be
// rendered with the catalog error shape after the original Zod input is checked below.
const handlerValidator = {
  getValidator<T>(): (input: unknown) => JsonSchemaValidatorResult<T> {
    return (input: unknown) => ({
      valid: true as const,
      data: input as T,
      errorMessage: undefined,
    });
  },
};

function toolInputSchema(op: Operation, agent: boolean): JsonSchemaType {
  const source = z.toJSONSchema(op.input, { io: 'input' }) as JsonObject;
  if (op.kind === 'query') return { ...source, type: 'object' };

  const key = {
    type: 'string',
    minLength: 1,
    description: 'Key to reuse when retrying this action.',
  };
  const withKey = (schema: JsonObject) => ({
    ...schema,
    properties: { ...(schema['properties'] as JsonObject), idempotencyKey: key },
    ...(agent
      ? { required: [...((schema['required'] as string[] | undefined) ?? []), 'idempotencyKey'] }
      : {}),
  });
  if (Array.isArray(source['oneOf'])) {
    return {
      ...source,
      type: 'object',
      oneOf: source['oneOf'].map((entry: unknown) => withKey(entry as JsonObject)),
    };
  }
  return { ...withKey(source), type: 'object' };
}

function toolDescription(op: Operation): string {
  const example =
    op.kind === 'mutation'
      ? { ...(op.examples[0].input as JsonObject), idempotencyKey: `${op.mcp.name}-example-001` }
      : op.examples[0].input;
  return [
    op.description,
    `Use when: ${op.mcp.whenToUse}`,
    `When not to use: ${op.mcp.whenNotToUse}`,
    `Example: ${JSON.stringify(example)}`,
    ...(op.kind === 'mutation'
      ? ['Choose a unique idempotencyKey for each action; reuse it on retries.']
      : []),
  ].join('\n');
}

function parseArguments(op: Operation, argumentsValue: unknown, agent: boolean) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new CliError('usage');
  }
  const { idempotencyKey, ...input } = argumentsValue as JsonObject;
  let key: string | undefined;
  if (op.kind === 'mutation') {
    if (idempotencyKey === undefined && !agent) key = randomUUID();
    else if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) key = idempotencyKey;
    else throw new CliError('usage');
  } else if (idempotencyKey !== undefined) {
    throw new CliError('usage');
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success) throw new CliError('usage');
  return { input: parsed.data, key };
}

/** One tool per catalog operation, with no daemon/config access until a tool is called. */
export function createMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  loadConfig: typeof loadClientConfig = loadClientConfig,
): McpServer {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const server = new McpServer({ name: 'spur-board', version });
  const agent = Boolean(env['SPUR_SESSION']);
  for (const op of OPERATIONS) {
    server.registerTool(
      op.mcp.name,
      {
        description: toolDescription(op),
        inputSchema: fromJsonSchema(toolInputSchema(op, agent), handlerValidator),
        outputSchema: op.output,
        annotations: {
          readOnlyHint: op.kind === 'query',
          idempotentHint: op.kind === 'mutation',
        },
      },
      async (argumentsValue) => {
        let key: string | undefined;
        try {
          const parsed = parseArguments(op, argumentsValue, agent);
          key = parsed.key;
          const config = loadConfig(env);
          const value = await requestOperation(op, parsed.input, key, config);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
            structuredContent: value as Record<string, unknown>,
          };
        } catch (cause) {
          const error = cause instanceof CliError ? cause : new CliError('unexpected');
          return renderMcpError({
            code: error.code,
            requestId: error.requestId,
            ...(error.context || (key && ERRORS[error.code].exit === 5)
              ? {
                  context: {
                    ...error.context,
                    ...(key && ERRORS[error.code].exit === 5 ? { idempotencyKey: key } : {}),
                  },
                }
              : {}),
          });
        }
      },
    );
  }
  return server;
}

/** Stdio is reserved for JSON-RPC; callers may log diagnostics only to stderr. */
export function startMcp(): void {
  serveStdio(() => createMcpServer());
}
