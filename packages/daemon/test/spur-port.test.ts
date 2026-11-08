import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpurRejectedError } from '@spur-board/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpurPort } from '../src/spur-port.ts';

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function fakeSpur(
  reply: (res: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      reply(res);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(port)}`, requests };
}

function json(status: number, value: unknown): (res: ServerResponse) => void {
  return (res) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  };
}

describe('spur send port', () => {
  it('posts the message to the encoded session path and resolves on 200', async () => {
    const spur = await fakeSpur(json(200, { id: 'sess/1' }));
    await createSpurPort({ baseUrl: spur.baseUrl }).send('sess/1', 'ping');
    expect(spur.requests).toEqual([
      {
        method: 'POST',
        url: '/sessions/sess%2F1/send',
        contentType: 'application/json',
        body: '{"message":"ping"}',
      },
    ]);
  });

  it('keeps a path prefix in the base URL', async () => {
    const spur = await fakeSpur(json(200, {}));
    await createSpurPort({ baseUrl: `${spur.baseUrl}/spur/` }).send('worker-1', 'ping');
    expect(spur.requests.map((request) => request.url)).toEqual(['/spur/sessions/worker-1/send']);
  });

  it('rejects a 404 with the status and the Spur error', async () => {
    const spur = await fakeSpur(json(404, { error: 'Session not found: x' }));
    const sent = createSpurPort({ baseUrl: spur.baseUrl }).send('x', 'ping');
    await expect(sent).rejects.toThrow('Spur send failed with HTTP 404: Session not found: x');
  });

  it.each([400, 403, 404, 410, 422])(
    'rejects a permanent HTTP %i as SpurRejectedError',
    async (status) => {
      const spur = await fakeSpur(json(status, { error: 'x' }));
      const sent = createSpurPort({ baseUrl: spur.baseUrl }).send('x', 'ping');
      await expect(sent).rejects.toBeInstanceOf(SpurRejectedError);
      await expect(sent).rejects.toThrow(`Spur send failed with HTTP ${String(status)}: x`);
    },
  );

  it.each([408, 409, 425, 429, 500, 503])(
    'keeps a retryable HTTP %i as a plain error',
    async (status) => {
      const spur = await fakeSpur(json(status, { error: 'x' }));
      const sent = createSpurPort({ baseUrl: spur.baseUrl }).send('x', 'ping');
      await expect(sent).rejects.not.toBeInstanceOf(SpurRejectedError);
      await expect(sent).rejects.toThrow(`Spur send failed with HTTP ${String(status)}: x`);
    },
  );

  it('rejects a non-JSON error with the status only', async () => {
    const spur = await fakeSpur((res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const sent = createSpurPort({ baseUrl: spur.baseUrl }).send('x', 'ping');
    await expect(sent).rejects.toThrow(/^Spur send failed with HTTP 500$/);
  });

  it('cuts a long Spur error to 200 characters', async () => {
    const spur = await fakeSpur(json(400, { error: 'x'.repeat(300) }));
    const error = await createSpurPort({ baseUrl: spur.baseUrl })
      .send('x', 'ping')
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('HTTP 400');
    expect(message).toContain('x'.repeat(200));
    expect(message).not.toContain('x'.repeat(201));
  });

  it('rejects when the Spur API is unreachable', async () => {
    const spur = await fakeSpur(json(200, {}));
    const closed = servers.pop();
    await new Promise((resolve) => closed?.close(resolve));
    const sent = createSpurPort({ baseUrl: spur.baseUrl }).send('x', 'ping');
    await expect(sent).rejects.toThrow('Spur API unreachable');
  });

  it('rejects a send that gets no answer within its deadline', async () => {
    const spur = await fakeSpur(() => undefined);
    const started = Date.now();
    const sent = createSpurPort({ baseUrl: spur.baseUrl, timeoutMs: 200 }).send('x', 'held');
    await expect(sent).rejects.toThrow('Spur send timed out');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
