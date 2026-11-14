import { SESSION_STATUSES, apiBaseUrl } from '@spur-board/contracts';
import type { ServerResponse } from 'node:http';
import {
  createApiServer,
  listenApiServer,
  verifyOperatorToken,
  type LiveSession,
  type ApiOptions,
  type OperationRegistry,
  type Store,
} from '@spur-board/core';
import { z } from 'zod';
import type { Module, ModuleContext } from './lifecycle.ts';
import { runDaemonDoctor } from './doctor.ts';

const SESSION_TIMEOUT_MS = 5_000;
const sessionDetailWire = z.object({
  id: z.string(),
  project: z.string().min(1),
  status: z.enum(SESSION_STATUSES),
});

/** Fetch one session after a snapshot miss; 404 is a confirmed unknown session. */
export async function lookupLiveSession(
  baseUrl: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<LiveSession | null> {
  const url = new URL(`sessions/${encodeURIComponent(id)}`, apiBaseUrl(baseUrl));
  const response = await fetcher(url, { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session lookup failed with HTTP ${String(response.status)}`);
  const detail = sessionDetailWire.safeParse(await response.json());
  if (!detail.success || detail.data.id !== id) throw new Error('Invalid session detail response');
  return { project: detail.data.project, status: detail.data.status };
}

/** Start and close the API as a daemon module, with runtime ports from its context. */
export function createHttpModule(
  ctx: ModuleContext<Store>,
  options: {
    fetcher?: typeof fetch;
    registry?: OperationRegistry;
    afterOperation?: (response: ServerResponse) => void | Promise<void>;
    runOperation?: ApiOptions['runOperation'];
    onListening?: (address: string) => void;
    productVersion?: string;
    doctor?: ApiOptions['doctor'];
    firstPollDone?: ApiOptions['firstPollDone'];
  } = {},
): Module {
  let app: Awaited<ReturnType<typeof createApiServer>> | undefined;
  return {
    async start(signal) {
      const aborted = (): boolean => signal.aborted;
      if (aborted()) return;
      const server = await createApiServer({
        store: ctx.store,
        config: ctx.config,
        port: ctx.config.http.port,
        ready: () => ctx.state() === 'ready',
        stopping: () => ctx.state() === 'stopping',
        clock: ctx.clock,
        lookupSession: (id) =>
          ctx.logCall('spur.session.lookup', () =>
            lookupLiveSession(ctx.config.adapters.spur.baseUrl, id, options.fetcher),
          ),
        verifyToken: (token) =>
          verifyOperatorToken(ctx.store, token, new Date(ctx.clock.now()), (err) => {
            ctx.log.warn({ err }, 'token use not recorded');
          }),
        registry: options.registry ?? {},
        ...(options.afterOperation === undefined ? {} : { afterOperation: options.afterOperation }),
        ...(options.runOperation === undefined ? {} : { runOperation: options.runOperation }),
        doctor:
          options.doctor ??
          (() => runDaemonDoctor(ctx, options.productVersion ?? 'unknown', options.fetcher)),
        ...(options.firstPollDone === undefined ? {} : { firstPollDone: options.firstPollDone }),
        ...(options.productVersion === undefined ? {} : { productVersion: options.productVersion }),
        logRequest: ({ requestId, method, url, status, tokenName }) => {
          const path = new URL(url, 'http://127.0.0.1').pathname;
          ctx.log.info(
            { requestId, method, path, status, ...(tokenName === undefined ? {} : { tokenName }) },
            'http request',
          );
        },
        logError: ({ requestId, err }) => {
          ctx.log.error({ err, requestId }, 'http request failed');
        },
      });
      try {
        if (aborted()) return;
        const address = await listenApiServer(server, ctx.config.http.port);
        if (aborted()) return;
        options.onListening?.(address);
        app = server;
        ctx.log.info({ port: Number(new URL(address).port) }, 'http listening');
      } finally {
        if (app !== server) await server.close();
      }
    },
    async stop() {
      const server = app;
      app = undefined;
      if (server !== undefined) await server.close();
    },
  };
}
