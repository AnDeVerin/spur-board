import { randomUUID } from 'node:crypto';
import {
  OPERATIONS,
  buildCatalogSnapshot,
  errorCodeOf,
  renderHttpProblem,
  type ActorId,
  type OperationId,
  type ServerErrorCode,
} from '@spur-board/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { createApply, CommandError, type Mutation } from '../app/commands.ts';
import { createQuery, type Query } from '../app/queries.ts';
import { identify, type IdentityPorts } from './identity.ts';

type CatalogEntry = (typeof OPERATIONS)[number];
type MutationId = Extract<CatalogEntry, { kind: 'mutation' }>['id'];
type QueryId = Extract<CatalogEntry, { kind: 'query' }>['id'];
type MutationEntry = Extract<CatalogEntry, { kind: 'mutation' }>;
type QueryEntry = Extract<CatalogEntry, { kind: 'query' }>;

/** Each catalog ID may have one app-layer handler, supplied by the composition root. */
export type OperationRegistry = Partial<{
  [Id in OperationId]: Id extends QueryId
    ? Query<Id>
    : Id extends MutationId
      ? Mutation<Id>
      : never;
}>;

export interface ApiOptions extends IdentityPorts {
  readonly port: number;
  readonly ready: () => boolean;
  readonly clock: { now(): number };
  readonly registry: OperationRegistry;
  readonly logRequest: (entry: {
    requestId: string;
    method: string;
    url: string;
    status: number;
  }) => void;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function inputBody(body: unknown): { input: unknown; key: string | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CommandError('usage', 'Send a JSON object with input and optional key.');
  }
  const record = body as Record<string, unknown>;
  if (
    !Object.hasOwn(record, 'input') ||
    Object.keys(record).some((name) => name !== 'input' && name !== 'key') ||
    (record['key'] !== undefined && typeof record['key'] !== 'string')
  ) {
    throw new CommandError('usage', 'Send a JSON object with input and optional key.');
  }
  return { input: record['input'], key: record['key'] };
}

/** Construct the local HTTP transport; the caller owns listen and close. */
export async function createApiServer(options: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), trustProxy: false });
  const snapshot = await buildCatalogSnapshot(OPERATIONS);
  const apply = createApply(options);
  const query = createQuery(options);
  const actors = new WeakMap<object, ActorId>();

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (request.headers.origin !== undefined) {
      throw new CommandError('forbidden', 'Browser origins are not accepted.');
    }
    if (header(request.headers.host) !== `127.0.0.1:${String(options.port)}`) {
      throw new CommandError('forbidden', 'Use the local API host.');
    }
    const contentType = header(request.headers['content-type']);
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (
      (contentType !== undefined && mediaType !== 'application/json') ||
      (request.method === 'POST' && mediaType !== 'application/json')
    ) {
      throw new CommandError('forbidden', 'Use application/json.');
    }
  });

  app.addHook('onResponse', (request, reply, done) => {
    options.logRequest({
      requestId: request.id,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
    });
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    let code: ServerErrorCode = 'unexpected';
    let hint: string | undefined;
    if (error instanceof CommandError) {
      code = error.code;
      hint = error.hint;
    } else if (error instanceof Error && 'statusCode' in error) {
      if (error.statusCode === 400 || error.statusCode === 413) code = 'usage';
      if (error.statusCode === 413) hint = 'Send a smaller JSON body.';
    }
    const problem = renderHttpProblem({ code, requestId: request.id });
    reply
      .code(problem.status)
      .type('application/problem+json')
      .send(hint === undefined ? problem.body : { ...problem.body, hint });
  });

  app.setNotFoundHandler(() => {
    throw new CommandError('not_found', 'This API route is not available.');
  });

  app.get('/v1/schema', async (_request, reply) => {
    if (!options.ready()) throw new CommandError('starting', 'Wait until the daemon is ready.');
    return reply.send(snapshot);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/ops/:id',
    {
      onRequest: async (request) => {
        if (!options.ready()) throw new CommandError('starting', 'Wait until the daemon is ready.');
        const sessionHeader = request.headers['x-board-session'];
        if (Array.isArray(sessionHeader)) {
          throw new CommandError('forbidden', 'Use one session identity header.');
        }
        actors.set(
          request,
          await identify(options, {
            session: sessionHeader,
            authorization: header(request.headers.authorization),
          }),
        );
      },
    },
    async (request, reply) => {
      const actor = actors.get(request);
      if (actor === undefined) throw new Error('Operation identity was not resolved.');
      const operation = OPERATIONS.find((entry) => entry.id === request.params.id);
      if (operation === undefined) throw new CommandError('usage', 'Unknown catalog operation.');
      const body = inputBody(request.body);
      const parsed = operation.input.safeParse(body.input);
      if (!parsed.success) {
        throw new CommandError(errorCodeOf(parsed.error), 'Fix the operation input.');
      }
      const handler = options.registry[operation.id];
      if (handler === undefined || handler.id !== operation.id) {
        throw new CommandError(
          'not_implemented',
          `Operation ${operation.id} is not available in this daemon build. Ask the operator to update the daemon.`,
        );
      }
      const result =
        operation.kind === 'query'
          ? await query(
              handler as unknown as Query<QueryId>,
              parsed.data as z.input<QueryEntry['input']>,
              actor,
            )
          : await apply(
              handler as unknown as Mutation<MutationId>,
              parsed.data as z.input<MutationEntry['input']>,
              actor,
              body.key,
            );
      return reply.send({ ok: true, requestId: request.id, value: result });
    },
  );

  return app;
}

/** The only supported listener for the local API. */
export function listenApiServer(app: FastifyInstance, port: number): Promise<string> {
  return app.listen({ host: '127.0.0.1', port });
}
