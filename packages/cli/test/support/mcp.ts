import { createServer, type Server, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach } from 'vitest';
import { loadClientConfig } from '../../src/config.ts';
import { createMcpServer } from '../../src/mcp.ts';

/** Fake daemons of the current test, closed after it. */
const children: Server[] = [];

afterEach(() => {
  for (const server of children.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

export async function fakeDaemon(
  respond: (
    request: { headers: Record<string, unknown>; body: Record<string, unknown> },
    response: ServerResponse,
  ) => void,
) {
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const value = {
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      };
      requests.push(value);
      respond(value, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  children.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake daemon has no port');
  return { url: `http://127.0.0.1:${String(address.port)}`, requests };
}

export async function withClient<T>(
  env: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const server = createMcpServer(env, (value) => {
    const config = loadClientConfig(value);
    return { ...config, responseTimeoutMs: timeoutMs ?? config.responseTimeoutMs };
  });
  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
