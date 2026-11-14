import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  OPERATIONS,
  buildCatalogSnapshot,
  errorCodeOf,
  renderHttpProblem,
  successEnvelopeSchema,
  tokenRequestSchema,
  type OperationId,
  type ServerErrorCode,
} from '@spur-board/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CommandError } from '../app/commands.ts';
import { dispatchOperation, type OperationRegistry } from '../app/operations.ts';
import {
  RELOAD_SESSIONS,
  SKILL_VERSION,
  requestSkillReload,
  skillReloads,
} from '../app/skill-reload.ts';
import { requestToken, tokenStatusByHash } from '../app/tokens.ts';
import { identifyCaller, type IdentifiedCaller, type IdentityPorts } from './identity.ts';

export type { OperationRegistry } from '../app/operations.ts';

export interface ApiOptions extends IdentityPorts {
  readonly port: number;
  readonly ready: () => boolean;
  /** Whether the daemon is shutting down; read only when `ready()` is false. Absent: starting. */
  readonly stopping?: () => boolean;
  readonly clock: { now(): number };
  readonly registry: OperationRegistry;
  readonly afterOperation?: (response: ServerResponse) => void | Promise<void>;
  /** Wraps one operation's dispatch, e.g. to order `item.retry` behind inbound recovery. */
  readonly runOperation?: <T>(id: OperationId, input: unknown, run: () => Promise<T>) => Promise<T>;
  readonly doctor?: () => Promise<DoctorReport>;
  /** Whether every non-blind source has completed a poll; read per request, with no probes. */
  readonly firstPollDone?: () => Promise<boolean>;
  /** The installed spur-board version the daemon runs; absent, skill reload is unavailable. */
  readonly productVersion?: string;
  readonly logRequest: (entry: {
    requestId: string;
    method: string;
    url: string;
    status: number;
    tokenName?: string;
  }) => void;
  /**
   * Called once for each request answered as `unexpected`, before the reply; never for a
   * `CommandError` or a 400/413 input error. Must not throw.
   */
  readonly logError?: (entry: { requestId: string; err: unknown }) => void;
}

interface DoctorCheck {
  id: string;
  status: 'pass' | 'fail' | 'warning';
  blocking: boolean;
  fix: string | null;
}

interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
}

const doctorReportSchema = z.strictObject({
  version: z.string().min(1).max(50),
  checks: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[a-z][a-z._]+$/)
          .max(60),
        status: z.enum(['pass', 'fail', 'warning']),
        blocking: z.boolean(),
        fix: z.string().max(300).nullable(),
      }),
    )
    .max(30),
});

const tokenStatusSchema = z.strictObject({ hash: tokenRequestSchema.shape.hash });
const skillReloadSchema = z.strictObject({ version: SKILL_VERSION });
const skillReloadsSchema = z.strictObject({ version: SKILL_VERSION, sessions: RELOAD_SESSIONS });

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
  /** Lets clients notice a daemon restart and check its catalog again. */
  const instance = randomUUID();
  const callers = new WeakMap<object, IdentifiedCaller>();
  let doctorInFlight: Promise<DoctorReport> | null = null;
  let doctorCached: DoctorReport | null = null;
  let doctorNextProbeAt = 0;
  const notReady = (): CommandError =>
    options.stopping?.() === true
      ? new CommandError('stopping', 'Wait until the daemon is running again.')
      : new CommandError('starting', 'Wait until the daemon is ready.');

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-board-instance', instance);
    if (request.headers.origin !== undefined) {
      throw new CommandError('forbidden', 'Browser origins are not accepted.');
    }
    const address = app.server.address();
    const port = address !== null && typeof address === 'object' ? address.port : options.port;
    if (header(request.headers.host) !== `127.0.0.1:${String(port)}`) {
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
    const caller = callers.get(request);
    options.logRequest({
      requestId: request.id,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ...(caller?.tokenName === undefined ? {} : { tokenName: caller.tokenName }),
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
    if (code === 'unexpected') options.logError?.({ requestId: request.id, err: error });
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
    if (!options.ready()) throw notReady();
    return reply.send(snapshot);
  });

  app.get('/v1/doctor', async (_request, reply) => {
    if (!options.ready()) throw notReady();
    if (options.doctor === undefined) throw new CommandError('not_found', 'Doctor is unavailable.');
    if (doctorInFlight !== null) return reply.send(await doctorInFlight);
    if (options.clock.now() < doctorNextProbeAt) {
      if (doctorCached !== null) return reply.send(doctorCached);
      throw new CommandError('starting', 'Retry board doctor in a few seconds.');
    }
    doctorNextProbeAt = options.clock.now() + 5_000;
    doctorInFlight = options.doctor().then((report) => doctorReportSchema.parse(report));
    try {
      doctorCached = await doctorInFlight;
      return await reply.send(doctorCached);
    } finally {
      doctorInFlight = null;
    }
  });

  app.get('/v1/health', async (_request, reply) => {
    if (!options.ready()) throw notReady();
    if (options.firstPollDone === undefined)
      throw new CommandError('not_found', 'Health is unavailable.');
    return reply.send({ firstPollDone: await options.firstPollDone() });
  });

  app.post('/v1/tokens/requests', async (request, reply) => {
    if (!options.ready()) throw notReady();
    const result = await requestToken(
      options.store,
      options.config,
      request.body,
      new Date(options.clock.now()),
    );
    return reply.send(
      successEnvelopeSchema.parse({ ok: true, requestId: request.id, value: result }),
    );
  });

  /** The hash travels in the body because request logs record the URL. */
  app.post('/v1/tokens/status', async (request, reply) => {
    if (!options.ready()) throw notReady();
    const parsed = tokenStatusSchema.safeParse(request.body);
    if (!parsed.success) throw new CommandError('usage', 'Provide a SHA-256 token hash.');
    const status = await tokenStatusByHash(
      options.store,
      parsed.data.hash,
      new Date(options.clock.now()),
    );
    return reply.send(
      successEnvelopeSchema.parse({ ok: true, requestId: request.id, value: { status } }),
    );
  });

  /** Anonymous: the message is fixed and goes at most once per session for the running version. */
  app.post('/v1/skills/reload', async (request, reply) => {
    if (!options.ready()) throw notReady();
    if (options.productVersion === undefined) {
      throw new CommandError('not_found', 'Skill reload is unavailable.');
    }
    const parsed = skillReloadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new CommandError(
        'usage',
        'Send {"version": "<x.y.z>"} with the installed spur-board version.',
      );
    }
    if (parsed.data.version !== options.productVersion) {
      throw new CommandError(
        'version_mismatch',
        `The daemon runs ${options.productVersion}. Run \`board service restart\` to start the installed version.`,
      );
    }
    const { version } = parsed.data;
    const { queued } = await requestSkillReload(
      options.store,
      options.config,
      version,
      new Date(options.clock.now()),
    );
    return reply.send(
      successEnvelopeSchema.parse({ ok: true, requestId: request.id, value: { version, queued } }),
    );
  });

  /** Session ids travel in the body because request logs record the URL; only named ids answer. */
  app.post('/v1/skills/reloads', async (request, reply) => {
    if (!options.ready()) throw notReady();
    const parsed = skillReloadsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new CommandError(
        'usage',
        'Send {"version": "<x.y.z>", "sessions": ["<session id>", ...]} with 1 to 200 session ids.',
      );
    }
    const { version, sessions } = parsed.data;
    const records = await skillReloads(options.store.db, version, sessions);
    return reply.send(
      successEnvelopeSchema.parse({
        ok: true,
        requestId: request.id,
        value: { version, sessions: records },
      }),
    );
  });

  app.post<{ Params: { id: string } }>(
    '/v1/ops/:id',
    {
      onRequest: async (request) => {
        if (!options.ready()) throw notReady();
        const sessionHeader = request.headers['x-board-session'];
        if (Array.isArray(sessionHeader)) {
          throw new CommandError('forbidden', 'Use one session identity header.');
        }
        callers.set(
          request,
          await identifyCaller(options, {
            session: sessionHeader,
            authorization: header(request.headers.authorization),
          }),
        );
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
      const body = inputBody(request.body);
      const parsed = operation.input.safeParse(body.input);
      if (!parsed.success) {
        throw new CommandError(errorCodeOf(parsed.error), 'Fix the operation input.');
      }
      const dispatch = () =>
        dispatchOperation(options, operation.id, parsed.data, caller.actor, body.key);
      const result = await (options.runOperation === undefined
        ? dispatch()
        : options.runOperation(operation.id, parsed.data, dispatch));
      await options.afterOperation?.(reply.raw);
      return reply.send(
        successEnvelopeSchema.parse({ ok: true, requestId: request.id, value: result }),
      );
    },
  );

  return app;
}

/** The only supported listener for the local API. */
export function listenApiServer(app: FastifyInstance, port: number): Promise<string> {
  return app.listen({ host: '127.0.0.1', port });
}
