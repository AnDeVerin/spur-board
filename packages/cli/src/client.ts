import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  ERRORS,
  errorContextSchema,
  successEnvelopeSchema,
  type Operation,
} from '@spur-board/contracts';
import type { ClientConfig } from './config.ts';
import { CliError } from './exit-codes.ts';
import { z } from 'zod';

function problemError(status: number, contentType: string | undefined, body: unknown): CliError {
  if (!body || typeof body !== 'object') return new CliError('outcome_unknown');
  const problem = body as Record<string, unknown>;
  const requestId =
    typeof problem['requestId'] === 'string' && problem['requestId']
      ? problem['requestId']
      : undefined;

  if (
    status === 503 &&
    contentType?.startsWith('application/problem+json') &&
    problem['status'] === 503 &&
    problem['code'] === 'starting'
  ) {
    return new CliError('daemon_unavailable', undefined, requestId);
  }

  const code = problem['code'];
  if (
    typeof code === 'string' &&
    Object.hasOwn(ERRORS, code) &&
    ERRORS[code as keyof typeof ERRORS].status === status
  ) {
    const context = errorContextSchema.safeParse(problem['context']);
    return new CliError(
      code as keyof typeof ERRORS,
      context.success ? context.data : undefined,
      requestId,
      typeof problem['hint'] === 'string' && problem['hint'] ? problem['hint'] : undefined,
    );
  }
  return new CliError('outcome_unknown', undefined, requestId);
}

function decodeResponse<Output extends z.ZodType>(
  output: Output,
  response: IncomingMessage,
  raw: string,
): z.output<Output> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new CliError('outcome_unknown');
  }
  if (response.statusCode === 200) {
    const envelope = successEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new CliError('outcome_unknown');
    const parsed = output.safeParse(envelope.data.value);
    if (!parsed.success) throw new CliError('outcome_unknown');
    return parsed.data;
  }
  throw problemError(response.statusCode ?? 0, response.headers['content-type'], body);
}

const instanceHeader = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The daemon instance a response came from, when it sends a well-formed one. */
function responseInstance(response: IncomingMessage): string | undefined {
  const value = response.headers['x-board-instance'];
  return typeof value === 'string' && instanceHeader.test(value) ? value : undefined;
}

interface SendOptions<Value> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  config: ClientConfig;
  anonymous: boolean;
  decode: (response: IncomingMessage, raw: string) => Value;
  observe?: ((instance: string) => void) | undefined;
}

function send<Value>({
  method,
  path,
  body,
  config,
  anonymous,
  decode,
  observe,
}: SendOptions<Value>): Promise<Value> {
  const target = new URL(path, config.address);
  const payload = method === 'POST' ? JSON.stringify(body) : undefined;
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Value>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: { value: Value } | { error: CliError }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const req = transport(
      target,
      {
        method,
        agent: false,
        headers: {
          accept: 'application/json, application/problem+json',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
          ...(anonymous
            ? {}
            : config.session
              ? { 'x-board-session': config.session }
              : { authorization: `Bearer ${config.token ?? ''}` }),
        },
      },
      (response) => {
        const instance = responseInstance(response);
        if (instance !== undefined) observe?.(instance);
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once('error', () => {
          settle({ error: new CliError('outcome_unknown') });
        });
        response.once('end', () => {
          try {
            settle({ value: decode(response, Buffer.concat(chunks).toString()) });
          } catch (error) {
            settle({ error: error instanceof CliError ? error : new CliError('outcome_unknown') });
          }
        });
      },
    );

    const onConnected = () => {
      if (settled || connected) return;
      connected = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => req.destroy(new Error('response timeout')),
        config.responseTimeoutMs,
      );
    };

    req.once('socket', (socket) => {
      if (!socket.connecting && !('secureConnecting' in socket && socket.secureConnecting)) {
        onConnected();
      } else {
        socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', onConnected);
      }
    });
    req.once('error', () => {
      settle({ error: new CliError(connected ? 'outcome_unknown' : 'daemon_unavailable') });
    });
    timer = setTimeout(() => req.destroy(new Error('connection timeout')), config.connectTimeoutMs);
    req.end(payload);
  });
}

/** Shared daemon HTTP client. The CLI owns output; this module owns transport and wire parsing. */
export async function requestOperation(
  op: Operation,
  input: unknown,
  key: string | undefined,
  config: ClientConfig,
  observe?: (instance: string) => void,
): Promise<unknown> {
  if (!config.session && !config.token) throw new CliError('identity_missing');
  return send({
    method: 'POST',
    path: `/v1/ops/${encodeURIComponent(op.id)}`,
    body: { input, ...(key ? { key } : {}) },
    config,
    anonymous: false,
    decode: (response, raw) => decodeResponse(op.output, response, raw),
    observe,
  });
}

const schemaVersion = z.looseObject({ version: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * The daemon's catalog version and instance. `/v1/schema` answers with the bare snapshot, not a
 * success envelope.
 */
export function fetchCatalogVersion(
  config: ClientConfig,
): Promise<{ version: string; instance: string | undefined }> {
  return send({
    method: 'GET',
    path: '/v1/schema',
    config,
    anonymous: true,
    decode: (response, raw) => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new CliError('outcome_unknown');
      }
      if (response.statusCode !== 200) {
        throw problemError(response.statusCode ?? 0, response.headers['content-type'], body);
      }
      const parsed = schemaVersion.safeParse(body);
      if (!parsed.success) throw new CliError('outcome_unknown');
      return { version: parsed.data.version, instance: responseInstance(response) };
    },
  });
}

const enrollmentOutput = z.strictObject({
  name: z.string(),
  status: z.literal('pending'),
  expiresAt: z.iso.datetime(),
});

/** Bootstrap sends a hash and no authorization header. */
export function requestTokenEnrollment(
  input: { name: string; folder: string; host: string; hash: string },
  config: ClientConfig,
): Promise<z.output<typeof enrollmentOutput>> {
  return send({
    method: 'POST',
    path: '/v1/tokens/requests',
    body: input,
    config,
    anonymous: true,
    decode: (response, raw) => decodeResponse(enrollmentOutput, response, raw),
  });
}
