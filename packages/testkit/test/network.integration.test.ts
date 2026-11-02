import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

function errorOf(request: http.ClientRequest | net.Socket): Promise<unknown> {
  return new Promise((resolve) => {
    request.on('error', resolve);
    request.on(request instanceof net.Socket ? 'connect' : 'response', () => {
      resolve(null);
    });
  });
}

describe('network guard', () => {
  it('blocks fetch to a remote host', async () => {
    const error: unknown = await fetch('http://example.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ cause: { code: 'ERR_TEST_NETWORK_BLOCKED' } });
  });

  it('blocks http.get to a remote host', async () => {
    expect(await errorOf(http.get('http://example.com/'))).toMatchObject({
      code: 'ERR_TEST_NETWORK_BLOCKED',
    });
  });

  it('blocks https.get to a remote host', async () => {
    expect(await errorOf(https.get('https://example.com/'))).toMatchObject({
      code: 'ERR_TEST_NETWORK_BLOCKED',
    });
  });

  it('blocks net.connect to a remote address', async () => {
    expect(await errorOf(net.connect(80, '192.0.2.1'))).toMatchObject({
      code: 'ERR_TEST_NETWORK_BLOCKED',
    });
  });

  it('blocks net.connect with an empty path to a remote host', async () => {
    expect(await errorOf(net.connect({ host: 'example.com', port: 80, path: '' }))).toMatchObject({
      code: 'ERR_TEST_NETWORK_BLOCKED',
    });
  });

  // 192.0.2.1 is TEST-NET-1: never routed. Node passes a custom lookup's error through
  // as is and connects when it is falsy, so `undefined` must count as success too.
  function remoteLookup(error: null | undefined): net.LookupFunction {
    return (_hostname, options, callback) => {
      const done = callback as (error: null | undefined, ...result: unknown[]) => void;
      if (options.all) done(error, [{ address: '192.0.2.1', family: 4 }]);
      else done(error, '192.0.2.1', 4);
    };
  }

  it.each([
    { autoSelectFamily: false, error: null },
    { autoSelectFamily: true, error: null },
    { autoSelectFamily: false, error: undefined },
    { autoSelectFamily: true, error: undefined },
  ])(
    'blocks localhost that resolves to a remote address (autoSelectFamily $autoSelectFamily, lookup error $error)',
    async ({ autoSelectFamily, error }) => {
      const socket = net.connect({
        host: 'localhost',
        port: 80,
        lookup: remoteLookup(error),
        autoSelectFamily,
      });
      expect(await errorOf(socket)).toMatchObject({ code: 'ERR_TEST_NETWORK_BLOCKED' });
    },
  );

  it('blocks http.get to localhost that resolves to a remote address', async () => {
    const request = http.get({ host: 'localhost', port: 80, lookup: remoteLookup(null) });
    expect(await errorOf(request)).toMatchObject({ code: 'ERR_TEST_NETWORK_BLOCKED' });
  });

  it('allows fetch to 127.0.0.1 and localhost', async () => {
    const server = http.createServer((_request, response) => {
      response.end('ok');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe('ok');
      expect(await (await fetch(`http://localhost:${String(port)}/`)).text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
