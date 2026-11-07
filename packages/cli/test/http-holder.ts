import { createServer, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An HTTP server on a free loopback port that answers every request with these headers. */
export async function holder(headers: OutgoingHttpHeaders) {
  const server = createServer((_request, response) => {
    response.writeHead(200, headers).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
