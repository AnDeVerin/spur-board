import { randomUUID } from 'node:crypto';
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

function toolInputSchema(op: Operation): JsonSchemaType {
  const source = z.toJSONSchema(op.input, { io: 'input' }) as JsonObject;
  if (op.kind === 'query') return { ...source, type: 'object' };

  const key = {
    type: 'string',
    minLength: 1,
    description: 'Key to reuse when retrying this action.',
  };
  if (Array.isArray(source['oneOf'])) {
    return {
      ...source,
      type: 'object',
      oneOf: source['oneOf'].map((entry: unknown) => {
        const branch = entry as JsonObject;
        return {
          ...branch,
          properties: { ...(branch['properties'] as JsonObject), idempotencyKey: key },
        };
      }),
    };
  }
  return {
    ...source,
    type: 'object',
    properties: { ...(source['properties'] as JsonObject), idempotencyKey: key },
  };
}

function toolDescription(op: Operation): string {
  return [
    op.description,
    `Use when: ${op.mcp.whenToUse}`,
    `When not to use: ${op.mcp.whenNotToUse}`,
    `Example: ${JSON.stringify(op.examples[0].input)}`,
    ...(op.kind === 'mutation' ? ['Retries must reuse the same idempotencyKey.'] : []),
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
  const server = new McpServer({ name: 'spur-board', version: '0.0.0' });
  for (const op of OPERATIONS) {
    server.registerTool(
      op.mcp.name,
      {
        description: toolDescription(op),
        inputSchema: fromJsonSchema(toolInputSchema(op), handlerValidator),
        outputSchema: op.output,
        annotations: {
          readOnlyHint: op.kind === 'query',
          idempotentHint: op.kind === 'mutation',
        },
      },
      async (argumentsValue) => {
        let key: string | undefined;
        try {
          const parsed = parseArguments(op, argumentsValue, Boolean(env['SPUR_SESSION']));
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
