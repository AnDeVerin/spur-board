import { SESSION_STATUSES } from '@spur-board/contracts';
import {
  createApiServer,
  listenApiServer,
  verifyOperatorToken,
  type LiveSession,
  type OperationRegistry,
  type Store,
} from '@spur-board/core';
import type { Module, ModuleContext } from './lifecycle.ts';

const SESSION_TIMEOUT_MS = 5_000;

/** Fetch one session after a snapshot miss; 404 is a confirmed unknown session. */
export async function lookupLiveSession(
  baseUrl: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<LiveSession | null> {
  const base = new URL(`${baseUrl.replace(/\/$/, '')}/`);
  const url = new URL(`sessions/${encodeURIComponent(id)}`, base);
  const response = await fetcher(url, { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Session lookup failed with HTTP ${String(response.status)}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid session detail response');
  }
  const record = body as Record<string, unknown>;
  if (
    record['id'] !== id ||
    typeof record['project'] !== 'string' ||
    record['project'].length === 0 ||
    typeof record['status'] !== 'string' ||
    !SESSION_STATUSES.some((status) => status === record['status'])
  ) {
    throw new Error('Invalid session detail response');
  }
  return { project: record['project'], status: record['status'] };
}

/** Start and close the API as a daemon module, with runtime ports from its context. */
export function createHttpModule(
  ctx: ModuleContext<Store>,
  options: { fetcher?: typeof fetch; registry?: OperationRegistry } = {},
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
        clock: ctx.clock,
        lookupSession: (id) =>
          ctx.logCall('spur.session.lookup', () =>
            lookupLiveSession(ctx.config.adapters.spur.baseUrl, id, options.fetcher),
          ),
        verifyToken: (token) => verifyOperatorToken(ctx.store, token),
        registry: options.registry ?? {},
        logRequest: ({ requestId, method, url, status, tokenName }) => {
          const path = new URL(url, 'http://127.0.0.1').pathname;
          ctx.log.info(
            { requestId, method, path, status, ...(tokenName === undefined ? {} : { tokenName }) },
            'http request',
          );
        },
      });
      try {
        if (aborted()) return;
        await listenApiServer(server, ctx.config.http.port);
        if (aborted()) return;
        app = server;
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
