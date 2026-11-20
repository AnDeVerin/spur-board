import {
  OPERATIONS,
  errorCodeOf,
  renderHttpProblem,
  successEnvelopeSchema,
  type Operation,
  type ServerErrorCode,
} from '@spur-board/contracts';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CommandError } from '../app/commands.ts';
import { withVia } from '../app/board-utils.ts';
import { dispatchOperation } from '../app/operations.ts';
import type { IdentifiedCaller } from './identity.ts';
import type { ApiOptions } from './server.ts';

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

export function installOperationErrors(
  app: FastifyInstance,
  options: Pick<ApiOptions, 'logError'>,
) {
  const handler = (error: unknown, request: FastifyRequest, reply: FastifyReply): void => {
    let code: ServerErrorCode = 'unexpected';
    let hint: string | undefined;
    if (error instanceof CommandError) {
      code = error.code;
      hint = error.hint;
    } else if (error instanceof Error && 'statusCode' in error) {
      if (error.statusCode === 400 || error.statusCode === 413) code = 'usage';
      if (error.statusCode === 413) hint = 'Send a smaller JSON body.';
    }
    if (code === 'unexpected') options.logError?.({ requestId: request.id, err: error });
    const problem = renderHttpProblem({ code, requestId: request.id });
    reply
      .code(problem.status)
      .type('application/problem+json')
      .send(hint === undefined ? problem.body : { ...problem.body, hint });
  };
  app.setErrorHandler(handler);
  return handler;
}

export function createOpsRoute(
  app: FastifyInstance,
  options: Pick<
    ApiOptions,
    | 'store'
    | 'config'
    | 'clock'
    | 'registry'
    | 'ready'
    | 'stopping'
    | 'runOperation'
    | 'afterOperation'
  > & {
    identify: (request: FastifyRequest) => Promise<IdentifiedCaller>;
    allow?: (operation: Operation) => boolean;
    /** Operations this listener runs only with a client idempotency key, so a retry cannot apply twice. */
    requireKey?: (operation: Operation) => boolean;
  },
  callers = new WeakMap<object, IdentifiedCaller>(),
): void {
  const notReady = () =>
    options.stopping?.() === true
      ? new CommandError('stopping', 'Wait until the daemon is running again.')
      : new CommandError('starting', 'Wait until the daemon is ready.');
  app.post<{ Params: { id: string } }>(
    '/v1/ops/:id',
    {
      onRequest: async (request) => {
        if (!options.ready()) throw notReady();
        callers.set(request, await options.identify(request));
      },
    },
    async (request, reply) => {
      const caller = callers.get(request);
      if (caller === undefined) throw new Error('Operation identity was not resolved.');
      const operation = OPERATIONS.find((entry) => entry.id === request.params.id);
      if (operation === undefined) {
        throw new CommandError(
          'version_mismatch',
          'This daemon does not know the operation. Run `board service restart` to update the daemon, then retry.',
        );
      }
      if (options.allow?.(operation) === false) {
        throw new CommandError('forbidden', 'This operation is not available on the web.');
      }
      const body = inputBody(request.body);
      if (options.requireKey?.(operation) === true && (body.key ?? '').trim() === '') {
        throw new CommandError(
          'usage',
          'Send a non-blank idempotency key with this write; a retry sends the same key.',
        );
      }
      const parsed = operation.input.safeParse(body.input);
      if (!parsed.success) {
        throw new CommandError(errorCodeOf(parsed.error), 'Fix the operation input.');
      }
      const run = () =>
        dispatchOperation(options, operation.id, parsed.data, caller.actor, body.key);
      const { via } = caller;
      const dispatch = via === undefined ? run : () => withVia(via, run);
      const result = await (options.runOperation === undefined
        ? dispatch()
        : options.runOperation(operation.id, parsed.data, dispatch));
      await options.afterOperation?.(reply.raw);
      return reply.send(
        successEnvelopeSchema.parse({ ok: true, requestId: request.id, value: result }),
      );
    },
  );
}
