import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';

const fakes: FakeSlackApi[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

async function start(): Promise<FakeSlackApi> {
  const fake = await startFakeSlackApi();
  fakes.push(fake);
  return fake;
}

function call(fake: FakeSlackApi, method: string, body = ''): Promise<unknown> {
  return fetch(`${fake.url}${method}`, { method: 'POST', body }).then((reply) => reply.json());
}

describe('startFakeSlackApi', () => {
  it('rejects when the port is taken', async () => {
    const holder = createServer();
    holder.listen(0, '127.0.0.1');
    await once(holder, 'listening');
    const { port } = holder.address() as AddressInfo;
    try {
      await expect(startFakeSlackApi({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      holder.close();
    }
  });

  it('survives a malformed Socket Mode frame', async () => {
    const fake = await start();
    const url = new URL(fake.url);
    const socket = connect(Number(url.port), '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const upgraded = once(socket, 'data');
    socket.write(
      [
        'GET /socket HTTP/1.1',
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
    await upgraded;
    const closed = once(socket, 'close');
    // Reserved bits set on a masked empty frame: the receiver refuses it.
    socket.write(Buffer.from([0xf1, 0x80, 0, 0, 0, 0]));
    await closed;
    expect(await call(fake, 'auth.test')).toMatchObject({ ok: true });
  });

  it('records an unknown method as a violation', async () => {
    const fake = await start();
    expect(await call(fake, 'auth.test')).toMatchObject({ ok: true });
    expect(await call(fake, 'no.such.method', 'a=1')).toEqual({
      ok: false,
      error: 'unknown_method',
    });
    expect(fake.violations()).toEqual([{ method: 'no.such.method', params: { a: '1' } }]);
  });

  it('answers conversations.info as a member channel', async () => {
    const fake = await start();
    expect(await call(fake, 'conversations.info', 'channel=C1')).toEqual({
      ok: true,
      channel: { id: 'C1', is_member: true },
    });
    expect(fake.violations()).toEqual([]);
  });
});
