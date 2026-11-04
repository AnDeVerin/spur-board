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

/** Shared daemon HTTP client. The CLI owns output; this module owns transport and wire parsing. */
async function post<Output extends z.ZodType>(
  path: string,
  body: unknown,
  config: ClientConfig,
  output: Output,
  anonymous: boolean,
): Promise<z.output<Output>> {
  const target = new URL(path, config.address);
  const payload = JSON.stringify(body);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<z.output<Output>>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: { value: z.output<Output> } | { error: CliError }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const req = transport(
      target,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, application/problem+json',
          'content-length': Buffer.byteLength(payload),
          ...(anonymous
            ? {}
            : config.session
              ? { 'x-board-session': config.session }
              : { authorization: `Bearer ${config.token ?? ''}` }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once('error', () => {
          settle({ error: new CliError('outcome_unknown') });
        });
        response.once('end', () => {
          try {
            settle({
              value: decodeResponse(output, response, Buffer.concat(chunks).toString()),
            });
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
): Promise<unknown> {
  if (!config.session && !config.token) throw new CliError('config');
  return post(
    `/v1/ops/${encodeURIComponent(op.id)}`,
    { input, ...(key ? { key } : {}) },
    config,
    op.output,
    false,
  );
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
  return post('/v1/tokens/requests', input, config, enrollmentOutput, true);
}
