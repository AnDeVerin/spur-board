import { SESSION_STATUSES, apiBaseUrl } from '@spur-board/contracts';
import type { ServerResponse } from 'node:http';
import {
  createApiServer,
  createWebServer,
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

/** Port of an http listener address; URL parsing drops the default port 80, so restore it. */
export function listenerPort(address: string): number {
  return Number(new URL(address).port || 80);
}

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
    webListening?: () => boolean;
    firstPollDone?: ApiOptions['firstPollDone'];
    instance?: string;
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
        ...(options.instance === undefined ? {} : { instance: options.instance }),
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
          (() =>
            runDaemonDoctor(ctx, options.productVersion ?? 'unknown', options.fetcher, {
              webListening: options.webListening,
            })),
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
        ctx.log.info({ port: listenerPort(address) }, 'http listening');
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

/** Optional browser listener: a bind failure must not take down the agent API. */
export function createWebModule(
  ctx: ModuleContext<Store>,
  options: {
    registry: OperationRegistry;
    runOperation?: ApiOptions['runOperation'];
    afterOperation?: ApiOptions['afterOperation'];
    firstPollDone?: ApiOptions['firstPollDone'];
    webRoot?: string | URL;
    onListening?: (address: string) => void;
    instance?: string;
  },
): Module & { listening(): boolean } {
  let app: Awaited<ReturnType<typeof createWebServer>> | undefined;
  return {
    listening: () => app !== undefined,
    async start(signal) {
      const aborted = (): boolean => signal.aborted;
      if (aborted()) return;
      let server: Awaited<ReturnType<typeof createWebServer>> | undefined;
      try {
        server = await createWebServer({
          store: ctx.store,
          config: ctx.config,
          clock: ctx.clock,
          registry: options.registry,
          ready: () => ctx.state() === 'ready',
          stopping: () => ctx.state() === 'stopping',
          ...(options.runOperation === undefined ? {} : { runOperation: options.runOperation }),
          ...(options.afterOperation === undefined
            ? {}
            : { afterOperation: options.afterOperation }),
          ...(options.firstPollDone === undefined ? {} : { firstPollDone: options.firstPollDone }),
          webRoot: options.webRoot ?? new URL('./web/', import.meta.url),
          logRequest: (entry) => {
            ctx.log.info(entry, 'web request');
          },
          logError: ({ requestId, err }) => {
            ctx.log.error({ requestId, err }, 'web request failed');
          },
          logStreamError: ({ err, step }) => {
            ctx.log.warn({ err, step }, 'event stream read failed');
          },
          ...(options.instance === undefined ? {} : { instance: options.instance }),
        });
        if (aborted()) return;
        const address = await server.listen({ host: '127.0.0.1', port: ctx.config.web.port ?? 0 });
        if (aborted()) return;
        options.onListening?.(address);
        app = server;
        ctx.log.info({ port: listenerPort(address) }, 'web listening');
      } catch (err) {
        ctx.log.error({ err, port: ctx.config.web.port }, 'web listener failed');
      } finally {
        if (server !== undefined && app !== server) await server.close();
      }
    },
    async stop() {
      const server = app;
      app = undefined;
      await server?.close();
    },
  };
}
