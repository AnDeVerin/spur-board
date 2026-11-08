import { createServer, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An HTTP server on a free loopback port that answers every request with this status and headers. */
export async function holder(headers: OutgoingHttpHeaders, status = 200) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.writeHead(status, headers).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
