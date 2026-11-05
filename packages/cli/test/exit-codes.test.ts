import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTP_PORT,
  OPERATIONS,
  errorEnvelopeSchema,
  renderHttpProblem,
} from '@spur-board/contracts';
import { runCli, type CliIo } from '../src/cli.ts';
import type { ClientConfig } from '../src/config.ts';

const servers: Server[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }),
  );
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function fakeServer(respond: RequestListener): Promise<{ url: string; server: Server }> {
  const server = createServer(respond);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port.');
  return { url: `http://127.0.0.1:${String(address.port)}`, server };
}

function boardHome(config?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'cli-address-'));
  homes.push(home);
  if (config !== undefined) writeFileSync(join(home, 'config.yaml'), config);
  return home;
}

function statusResponse(
  request: Parameters<RequestListener>[0],
  response: Parameters<RequestListener>[1],
) {
  expect(request.url).toBe('/v1/ops/status.get');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: true,
      requestId: 'req-status',
      value: OPERATIONS[0].examples[0].output,
    }),
  );
}

function capture(tty = false) {
  let stdout = '';
  let stderr = '';
  const events: string[] = [];
  const io: CliIo = {
    isTTY: tty,
    stdout(text) {
      stdout += text;
      events.push('stdout');
    },
    stderr(text) {
      stderr += text;
      if (text.startsWith('key: ')) events.push('key-written');
    },
  };
  return {
    io,
    events,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function env(url: string, agent = false): NodeJS.ProcessEnv {
  return {
    BOARD_DAEMON_URL: url,
    ...(agent
      ? { SPUR_SESSION: 'test-session', BOARD_TOKEN: 'must-not-send' }
      : { BOARD_TOKEN: 'token' }),
  };
}

function config(url: string, responseTimeoutMs = 30): ClientConfig {
  return {
    address: new URL(url),
    session: 'test-session',
    token: undefined,
    connectTimeoutMs: 100,
    responseTimeoutMs,
  };
}

const ask = OPERATIONS.find((op) => op.id === 'block.ask');
if (!ask) throw new Error('Catalog has no ask operation.');

describe('CLI exit classes and mutation keys', () => {
  it('reaches the configured daemon without BOARD_DAEMON_URL', async () => {
    const { url } = await fakeServer(statusResponse);
    const port = new URL(url).port;
    const home = boardHome(
      `projects:\n  - id: board\n    tracker: { type: github-issues, repo: example/board, label: board }\n    repos: [example/board]\n    operatorGithubLogin: operator\noperator: { slack: U0000000000 }\ndigest: { tz: UTC }\nhttp: { port: ${port} }\n`,
    );
    const output = capture();
    expect(
      await runCli(['status', '--json'], {
        env: { BOARD_HOME: home, BOARD_TOKEN: 'token' },
        io: output.io,
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(OPERATIONS[0].examples[0].output);
  });

  it('dispatches status to the default daemon address when config is missing', async () => {
    const home = boardHome();
    const addresses: string[] = [];
    const output = capture();
    expect(
      await runCli(['status', '--json'], {
        env: { BOARD_HOME: home, BOARD_TOKEN: 'token' },
        io: output.io,
        sendOperation(op, input, key, config) {
          expect(op.id).toBe('status.get');
          expect(input).toEqual({});
          expect(key).toBeUndefined();
          addresses.push(config.address.href);
          return Promise.resolve(OPERATIONS[0].examples[0].output);
        },
      }),
    ).toBe(0);
    expect(addresses).toEqual([`http://127.0.0.1:${String(DEFAULT_HTTP_PORT)}/`]);
    expect(JSON.parse(output.stdout)).toEqual(OPERATIONS[0].examples[0].output);
  });
  it('returns 3 when a connection is refused before dispatch', async () => {
    const { url, server } = await fakeServer(() => {});
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    servers.splice(servers.indexOf(server), 1);
    const output = capture();
    const code = await runCli(['status', '--json'], { env: env(url), io: output.io });
    expect(code).toBe(3);
    expect(output.stdout).toBe('');
    expect(errorEnvelopeSchema.parse(JSON.parse(output.stderr)).error.code).toBe(
      'daemon_unavailable',
    );
  });

  it('returns 5 after a sent request times out and keeps its key in JSON', async () => {
    let received = false;
    const { url } = await fakeServer((request) => {
      request.on('data', () => {
        received = true;
      });
      request.resume();
    });
    const key = 'ask-retry-1';
    const timed = capture();
    expect(
      await runCli(['ask', 'PROJ-123', 'Question?', '--key', key, '--json'], {
        env: env(url, true),
        io: timed.io,
        clientConfig: config(url),
      }),
    ).toBe(5);
    expect(received).toBe(true);
    expect(timed.stderr).toContain(`key: ${key}`);
    const timedError = timed.stderr.trim().split('\n').at(-1);
    if (!timedError) throw new Error('Expected a JSON timeout error.');
    expect(errorEnvelopeSchema.parse(JSON.parse(timedError)).error.hint).toContain(
      `retry with --key ${key}`,
    );

    const { url: dropUrl } = await fakeServer((request) => {
      request.resume();
      request.on('end', () => request.socket.destroy());
    });
    const output = capture();
    const code = await runCli(['ask', 'PROJ-123', 'Question?', '--key', key, '--json'], {
      env: env(dropUrl, true),
      io: output.io,
    });
    expect(code).toBe(5);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain(`key: ${key}`);
    const errorLine = output.stderr.trim().split('\n').at(-1);
    if (!errorLine) throw new Error('Expected a JSON error line.');
    const json = errorEnvelopeSchema.parse(JSON.parse(errorLine));
    expect(json.error.code).toBe('outcome_unknown');
    expect(json.error.hint).toContain(`retry with --key ${key}`);
  });

  it('accepts only the explicit startup marker as not applied', async () => {
    const { url } = await fakeServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(
        JSON.stringify({
          type: 'about:blank',
          title: 'Daemon starting',
          status: 503,
          code: 'starting',
          requestId: 'req-starting',
        }),
      );
    });
    const output = capture();
    expect(await runCli(['status', '--json'], { env: env(url), io: output.io })).toBe(3);
    expect(errorEnvelopeSchema.parse(JSON.parse(output.stderr)).error.code).toBe(
      'daemon_unavailable',
    );

    const { url: otherUrl } = await fakeServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(
        JSON.stringify({
          type: 'about:blank',
          status: 503,
          code: 'unknown',
          requestId: 'req-other',
        }),
      );
    });
    const other = capture();
    expect(await runCli(['status', '--json'], { env: env(otherUrl), io: other.io })).toBe(5);
    expect(errorEnvelopeSchema.parse(JSON.parse(other.stderr)).error.code).toBe('outcome_unknown');

    const { url: failureUrl } = await fakeServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ type: 'about:blank', status: 500, requestId: 'req-failure' }));
    });
    const failure = capture();
    expect(await runCli(['status', '--json'], { env: env(failureUrl), io: failure.io })).toBe(5);
  });

  it('maps catalog problem bodies to their exits and strict CLI errors', async () => {
    for (const code of ['identity_unavailable', 'forbidden', 'usage'] as const) {
      const problem = renderHttpProblem({ code, requestId: `req-${code}` });
      const { url } = await fakeServer((_request, response) => {
        response.writeHead(problem.status, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify(problem.body));
      });
      const output = capture();
      const exit = await runCli(['status', '--json'], { env: env(url), io: output.io });
      expect(exit).toBe(code === 'identity_unavailable' ? 3 : code === 'usage' ? 2 : 1);
      const rendered = errorEnvelopeSchema.parse(JSON.parse(output.stderr));
      expect(rendered.requestId).toBe(`req-${code}`);
      expect(rendered.error.code).toBe(code);
      expect(output.stdout).toBe('');
    }
  });

  it('shows operation-specific forbidden and PR conflict hints from the daemon', async () => {
    for (const [code, hint] of [
      ['forbidden', 'Allowed role: operator.'],
      ['link_conflict', 'o/r#7 is already the open PR for this task.'],
    ] as const) {
      const problem = renderHttpProblem({ code, requestId: `req-${code}` });
      const { url } = await fakeServer((_request, response) => {
        response.writeHead(problem.status, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ ...problem.body, hint }));
      });
      const args = [
        'link',
        'o/r#9',
        '--pr',
        'https://github.com/o/r/pull/8',
        '--reason',
        'Manual correction.',
      ];
      const human = capture();
      expect(await runCli(args, { env: env(url), io: human.io })).toBe(1);
      expect(human.stderr).toContain(`fix: ${hint}`);
      const json = capture();
      expect(await runCli([...args, '--json'], { env: env(url), io: json.io })).toBe(1);
      const errorLine = json.stderr.trim().split('\n').at(-1);
      if (!errorLine) throw new Error('Expected a JSON error line.');
      expect(errorEnvelopeSchema.parse(JSON.parse(errorLine)).error.hint).toBe(hint);
    }
  });

  it('escapes a server request ID only in human error output', async () => {
    const requestId = 'req\u001b[31m\u0007\u000dnext';
    const problem = renderHttpProblem({ code: 'forbidden', requestId });
    const { url } = await fakeServer((_request, response) => {
      response.writeHead(problem.status, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify(problem.body));
    });
    const human = capture();
    expect(await runCli(['status'], { env: env(url), io: human.io })).toBe(1);
    expect(human.stderr).toContain('requestId: req\\u001b[31m\\u0007\\u000dnext');
    expect(human.stderr).not.toMatch(/[\u001b\u0007\u000d]/u);

    const json = capture();
    expect(await runCli(['status', '--json'], { env: env(url), io: json.io })).toBe(1);
    expect(errorEnvelopeSchema.parse(JSON.parse(json.stderr)).requestId).toBe(requestId);
  });

  it('returns 4 for missing token or invalid explicit daemon address', async () => {
    const token = capture();
    expect(
      await runCli(['status', '--json'], {
        env: { BOARD_DAEMON_URL: 'http://127.0.0.1:1' },
        io: token.io,
      }),
    ).toBe(4);
    expect(
      errorEnvelopeSchema.parse(JSON.parse(token.stderr)).error.context.environmentVariable,
    ).toBe('BOARD_TOKEN');
    for (const rawAddress of ['ftp://example.com', '']) {
      const address = capture();
      expect(
        await runCli(['status', '--json'], {
          env: { BOARD_DAEMON_URL: rawAddress, BOARD_TOKEN: 'token' },
          io: address.io,
        }),
      ).toBe(4);
      expect(
        errorEnvelopeSchema.parse(JSON.parse(address.stderr)).error.context.environmentVariable,
      ).toBe('BOARD_DAEMON_URL');
    }
  });

  it('explains how to reach a daemon configured with a runtime-assigned port', async () => {
    const home = boardHome(
      `projects:\n  - id: board\n    tracker: { type: github-issues, repo: example/board, label: board }\n    repos: [example/board]\n    operatorGithubLogin: operator\noperator: { slack: U0000000000 }\ndigest: { tz: UTC }\nhttp: { port: 0 }\n`,
    );
    const output = capture();
    expect(
      await runCli(['status', '--json'], {
        env: { BOARD_HOME: home, BOARD_TOKEN: 'token' },
        io: output.io,
      }),
    ).toBe(4);
    expect(errorEnvelopeSchema.parse(JSON.parse(output.stderr)).error.hint).toContain(
      'Set BOARD_DAEMON_URL',
    );
  });

  it('rejects a missing agent key without sending and announces supplied and generated keys first', async () => {
    let requests = 0;
    const events: string[] = [];
    const received: {
      key: string;
      session: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const { url } = await fakeServer((request, response) => {
      requests += 1;
      events.push('request-started');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { key: string };
        received.push({
          key: body.key,
          session: request.headers['x-board-session'] as string | undefined,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: true, requestId: 'req-ok', value: ask.examples[0].output }),
        );
      });
    });
    const missing = capture();
    expect(
      await runCli(['ask', 'PROJ-123', 'Question?', '--json'], {
        env: env(url, true),
        io: missing.io,
      }),
    ).toBe(2);
    expect(requests).toBe(0);

    const agent = capture();
    const agentStderr = agent.io.stderr;
    agent.io.stderr = (text) => {
      events.push('key-written');
      agentStderr(text);
    };
    expect(
      await runCli(['ask', 'PROJ-123', 'Question?', '--key', 'ask-1', '--json'], {
        env: env(url, true),
        io: agent.io,
      }),
    ).toBe(0);
    expect(events.slice(0, 2)).toEqual(['key-written', 'request-started']);
    events.length = 0;

    const operator = capture();
    const operatorStderr = operator.io.stderr;
    operator.io.stderr = (text) => {
      events.push('key-written');
      operatorStderr(text);
    };
    expect(
      await runCli(['ask', 'PROJ-123', 'Question?', '--json'], { env: env(url), io: operator.io }),
    ).toBe(0);
    expect(events.slice(0, 2)).toEqual(['key-written', 'request-started']);
    expect(requests).toBe(2);
    expect(received[0]).toEqual({
      key: 'ask-1',
      session: 'test-session',
      authorization: undefined,
    });
    expect(received[1]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(received[1]?.authorization).toBe('Bearer token');
    const operatorRequest = received[1];
    if (!operatorRequest) throw new Error('Expected operator request.');
    expect(operator.stderr).toContain(`key: ${operatorRequest.key}`);
  });

  it('rejects control characters in a supplied key before announcing or sending it', async () => {
    let requests = 0;
    const { url } = await fakeServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ok: true, requestId: 'req-ok', value: ask.examples[0].output }),
      );
    });
    for (const key of ['ask\u001b[31m', 'ask\nnext', 'ask\u007f', 'ask\u009b31m']) {
      for (const agent of [true, false]) {
        const output = capture();
        expect(
          await runCli(['ask', 'PROJ-123', 'Question?', '--key', key, '--json'], {
            env: env(url, agent),
            io: output.io,
          }),
        ).toBe(2);
        expect(output.stdout).toBe('');
        expect(output.stderr.startsWith('{')).toBe(true);
        expect(errorEnvelopeSchema.parse(JSON.parse(output.stderr)).error.code).toBe('usage');
      }
    }
    expect(requests).toBe(0);
  });
});
