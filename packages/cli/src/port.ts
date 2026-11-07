import { createServer } from 'node:net';
import { escapeTerminalControls } from './terminal.ts';

/** A private copy of the client's check: client.ts is the published entry, so it exports nothing new. */
const instanceHeader = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PortProbe {
  bind(port: number): Promise<string | null>;
  fetcher: typeof fetch;
  listeners(port: number): Promise<string>;
}

/** Bind 127.0.0.1:port as the daemon would and close at once; returns the error code, or null when free. */
export function bindLoopback(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'unknown error');
    });
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => {
        resolve(null);
      });
    });
  });
}

async function isBoardDaemon(port: number, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(new URL(`http://127.0.0.1:${String(port)}/v1/schema`), {
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    const value = response.headers.get('x-board-instance');
    return value !== null && instanceHeader.test(value);
  } catch {
    return false;
  }
}

function holderOf(ssOutput: string): string {
  const match = /users:\(\("([^"]*)",pid=(\d+)/.exec(ssOutput);
  if (match?.[1] === undefined || match[2] === undefined) {
    return 'a process not visible to this user';
  }
  return `${escapeTerminalControls(match[1])} (pid ${match[2]})`;
}

/** The fix when the daemon could not listen on http.port, or null when it is free or held by a board daemon. */
export async function checkHttpPort(port: number, probe: PortProbe): Promise<string | null> {
  const code = await probe.bind(port);
  if (code === null) return null;
  const label = `Port ${String(port)} (http.port)`;
  if (code !== 'EADDRINUSE') {
    return `${label} cannot be bound on 127.0.0.1 (${escapeTerminalControls(code)}). Set http.port in config.yaml to a free unprivileged port.`;
  }
  if (await isBoardDaemon(port, probe.fetcher)) return null;
  const holder = holderOf(await probe.listeners(port));
  return `${label} is held by ${holder}. Stop that process or set http.port in config.yaml to a free port, then start the service again.`;
}
