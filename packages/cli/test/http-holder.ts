import { createServer, type OutgoingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';

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

/** A listener that starts an HTTP response and then sends one header line every 200 ms, forever. */
export async function trickler() {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.write('HTTP/1.1 200 OK\r\n');
    const timer = setInterval(() => socket.write('x-trickle: 1\r\n'), 200);
    timers.add(timer);
    socket.once('close', () => {
      clearInterval(timer);
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearInterval(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
