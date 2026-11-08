import { get } from 'node:http';
import { createServer } from 'node:net';
import { escapeTerminalControls } from './terminal.ts';

/** A private copy of the client's check: client.ts is the published entry, so it exports nothing new. */
const instanceHeader = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PortProbe {
  bind(port: number): Promise<string | null>;
  run(command: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
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

/**
 * Ask the holder for its board instance header over node:http, the client's transport. fetch would
 * refuse ports on its bad-port list (6000, 6667, ...) that the config allows, and would follow a
 * redirect to a daemon on another port; node:http does neither. The deadline is absolute: a socket
 * timeout would reset on every byte a trickling holder sends.
 */
function isBoardDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/schema',
        agent: false,
        signal: AbortSignal.timeout(2_000),
      },
      (response) => {
        const value = response.headers['x-board-instance'];
        response.destroy();
        resolve(typeof value === 'string' && instanceHeader.test(value));
      },
    );
    request.once('error', () => {
      resolve(false);
    });
  });
}

async function holderOf(port: number, probe: PortProbe): Promise<string> {
  let listed = '';
  try {
    const result = await probe.run('ss', ['-ltnp', `sport = :${String(port)}`]);
    if (result.exitCode === 0) listed = result.stdout;
  } catch {
    // Without ss the holder stays unnamed.
  }
  const match = /users:\(\("([^"]*)",pid=(\d+)/.exec(listed);
  if (match?.[1] === undefined || match[2] === undefined) {
    return 'a process not visible to this user';
  }
  return `${escapeTerminalControls(match[1])} (pid ${match[2]})`;
}

/** The fix when the daemon could not listen on http.port, or null when it is 0, free or held by a board daemon. */
export async function checkHttpPort(port: number, probe: PortProbe): Promise<string | null> {
  if (port === 0) return null;
  const code = await probe.bind(port);
  if (code === null) return null;
  const label = `Port ${String(port)} (http.port)`;
  if (code !== 'EADDRINUSE') {
    return `${label} cannot be bound on 127.0.0.1 (${escapeTerminalControls(code)}). Set http.port in config.yaml to a free unprivileged port.`;
  }
  if (await isBoardDaemon(port)) return null;
  const holder = await holderOf(port, probe);
  return `${label} is held by ${holder}. Stop that process or set http.port in config.yaml to a free port, then start the service again.`;
}
