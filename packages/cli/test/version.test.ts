import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ERRORS, OPERATIONS, renderHttpProblem } from '@spur-board/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { loadClientConfig } from '../src/config.ts';
import { createMcpServer } from '../src/mcp.ts';
import { clientCatalogVersion } from '../src/version.ts';

const servers: Server[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const otherVersion = 'f'.repeat(64);
const restartHint = "Restart your agent session so `board mcp` loads the daemon's catalog";

/** A daemon double that serves `/v1/schema` and catalog examples, and logs `method url`. */
async function fakeDaemon(initial: { version: string; instance?: string | undefined }) {
  const state = {
    instance: initial.instance,
    version: initial.version,
    schemaReady: true,
    unknownOps: false,
  };
  const log: string[] = [];
  let held: Promise<void> | undefined;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      void (async () => {
        const entry = `${request.method ?? ''} ${request.url ?? ''}`;
        log.push(entry);
        const instanceHeader: Record<string, string> =
          state.instance === undefined ? {} : { 'x-board-instance': state.instance };
        if (request.method === 'GET' && request.url === '/v1/schema') {
          if (held) await held;
          if (!state.schemaReady) {
            const problem = renderHttpProblem({ code: 'starting', requestId: 'req-starting' });
            response.writeHead(problem.status, {
              'content-type': 'application/problem+json',
              ...instanceHeader,
            });
            response.end(JSON.stringify(problem.body));
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json', ...instanceHeader });
          response.end(JSON.stringify({ version: state.version, operations: [] }));
          return;
        }
        const id = decodeURIComponent((request.url ?? '').replace('/v1/ops/', ''));
        const op = OPERATIONS.find((item) => item.id === id);
        if (request.method !== 'POST' || op === undefined || state.unknownOps) {
          const problem = renderHttpProblem({ code: 'version_mismatch', requestId: 'req-old' });
          response.writeHead(problem.status, {
            'content-type': 'application/problem+json',
            ...instanceHeader,
          });
          response.end(
            JSON.stringify({
              ...problem.body,
              hint: 'This daemon does not know the operation. Run `board service restart` to update the daemon, then retry.',
            }),
          );
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', ...instanceHeader });
        response.end(
          JSON.stringify({ ok: true, requestId: 'req-op', value: op.examples[0].output }),
        );
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake daemon has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    log,
    state,
    restart(version: string) {
      state.instance = randomUUID();
      state.version = version;
    },
    holdSchema(): () => void {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}

function capture() {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return {
    io,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function boardHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'cli-version-'));
  homes.push(home);
  return home;
}

async function cli(url: string, home: string, argv = ['status', '--json']) {
  const output = capture();
  const code = await runCli(argv, {
    env: { BOARD_HOME: home, BOARD_DAEMON_URL: url, BOARD_TOKEN: 'token' },
    io: output.io,
  });
  return { code, stdout: output.stdout, stderr: output.stderr };
}

function warnings(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('warning:'));
}

async function withMcp<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ BOARD_DAEMON_URL: url, BOARD_TOKEN: 'token' }, loadClientConfig);
  const client = new Client({ name: 'version-test', version: '1.0.0' });
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

const query = () => ({ name: 'status_get', arguments: {} });
const mutation = () => ({
  name: 'task_add',
  arguments: { task: 'PROJ-123', idempotencyKey: `task-add-${randomUUID()}` },
});
const statusPost = 'POST /v1/ops/status.get';
const schemaGet = 'GET /v1/schema';

function structured(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.structuredContent as {
    code: string;
    hint: string;
    context: { clientVersion?: string; serverVersion?: string };
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

describe('catalog version check', () => {
  it('matching versions: the second CLI call and the second MCP call send no schema request', async () => {
    const version = await clientCatalogVersion();
    const cliDaemon = await fakeDaemon({ version, instance: randomUUID() });
    const home = boardHome();
    for (let call = 0; call < 2; call += 1) {
      const result = await cli(cliDaemon.url, home);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(OPERATIONS[0].examples[0].output);
      expect(result.stderr).toBe('');
    }
    expect(cliDaemon.log).toEqual([statusPost, schemaGet, statusPost]);

    const mcpDaemon = await fakeDaemon({ version, instance: randomUUID() });
    await withMcp(mcpDaemon.url, async (client) => {
      for (let call = 0; call < 2; call += 1) {
        const result = await client.callTool(query());
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(OPERATIONS[0].examples[0].output);
      }
    });
    expect(mcpDaemon.log).toEqual([statusPost, schemaGet, statusPost]);
  });

  it('board mcp re-checks the catalog after a daemon restart and fails the detecting query with the restart-session hint', async () => {
    const version = await clientCatalogVersion();
    const daemon = await fakeDaemon({ version, instance: randomUUID() });
    const schemaRequests = () => daemon.log.filter((entry) => entry === schemaGet).length;
    await withMcp(daemon.url, async (client) => {
      expect((await client.callTool(query())).isError).not.toBe(true);
      expect(schemaRequests()).toBe(1);

      daemon.restart(version);
      expect((await client.callTool(query())).isError).not.toBe(true);
      expect(schemaRequests()).toBe(2);

      daemon.restart(otherVersion);
      const detecting = await client.callTool(query());
      expect(detecting.isError).toBe(true);
      expect(structured(detecting).code).toBe('version_mismatch');
      expect(schemaRequests()).toBe(3);
      expect(daemon.log.slice(-2)).toEqual([statusPost, schemaGet]);

      const before = daemon.log.length;
      const refused = await client.callTool(query());
      expect(refused.isError).toBe(true);
      expect(structured(refused).code).toBe('version_mismatch');
      expect(structured(refused).hint).toContain(restartHint);
      expect(text(refused)).toContain(restartHint);
      expect(structured(refused).context).toEqual({
        clientVersion: version,
        serverVersion: otherVersion,
      });
      expect(daemon.log.slice(before)).toEqual([schemaGet]);
    });
  });

  it('a board mcp mutation that detects a mismatch returns its result and the next call fails', async () => {
    const daemon = await fakeDaemon({ version: otherVersion, instance: randomUUID() });
    await withMcp(daemon.url, async (client) => {
      const applied = await client.callTool(mutation());
      expect(applied.isError).toBeUndefined();
      expect(applied.structuredContent).toEqual(
        OPERATIONS.find((op) => op.id === 'task.add')?.examples[0].output,
      );
      expect(daemon.log).toEqual(['POST /v1/ops/task.add', schemaGet]);

      const refused = await client.callTool(query());
      expect(refused.isError).toBe(true);
      expect(structured(refused).code).toBe('version_mismatch');
      expect(daemon.log).toEqual(['POST /v1/ops/task.add', schemaGet, schemaGet]);
    });
  });

  it('overlapping board mcp calls on a new instance share one schema check', async () => {
    const daemon = await fakeDaemon({
      version: await clientCatalogVersion(),
      instance: randomUUID(),
    });
    const release = daemon.holdSchema();
    await withMcp(daemon.url, async (client) => {
      const calls = Promise.all([client.callTool(query()), client.callTool(query())]);
      await vi.waitFor(
        () => {
          expect(daemon.log.filter((entry) => entry === statusPost)).toHaveLength(2);
        },
        { interval: 5 },
      );
      release();
      const results = await calls;
      for (const result of results) expect(result.isError).not.toBe(true);
    });
    expect(daemon.log.filter((entry) => entry === schemaGet)).toHaveLength(1);
  });

  it('board mcp keeps refusing while the probe fails and clears the mismatch once the daemon serves a matching catalog', async () => {
    const version = await clientCatalogVersion();
    const daemon = await fakeDaemon({ version, instance: randomUUID() });
    await withMcp(daemon.url, async (client) => {
      daemon.restart(otherVersion);
      const detecting = await client.callTool(query());
      expect(structured(detecting).code).toBe('version_mismatch');
      expect(daemon.log).toEqual([statusPost, schemaGet]);

      daemon.state.schemaReady = false;
      let before = daemon.log.length;
      const unavailable = await client.callTool(query());
      expect(unavailable.isError).toBe(true);
      expect(structured(unavailable).code).toBe('version_mismatch');
      expect(structured(unavailable).context.serverVersion).toBe(otherVersion);
      expect(daemon.log.slice(before)).toEqual([schemaGet]);

      daemon.restart(version);
      daemon.state.schemaReady = true;
      before = daemon.log.length;
      const recovered = await client.callTool(query());
      expect(recovered.isError).not.toBe(true);
      expect(daemon.log.slice(before)).toEqual([schemaGet, statusPost]);

      before = daemon.log.length;
      expect((await client.callTool(query())).isError).not.toBe(true);
      expect(daemon.log.slice(before)).toEqual([statusPost]);
    });
  });

  it('the CLI warns once per invocation on a mismatch and reuses the cached verdict', async () => {
    const daemon = await fakeDaemon({ version: otherVersion, instance: randomUUID() });
    const home = boardHome();
    for (let call = 0; call < 2; call += 1) {
      const result = await cli(daemon.url, home);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(OPERATIONS[0].examples[0].output);
      const lines = warnings(result.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('board service restart');
      expect(lines[0]).toContain(ERRORS.version_mismatch.hint);
    }
    expect(daemon.log.filter((entry) => entry === schemaGet)).toHaveLength(1);
    expect(existsSync(join(home, 'version-check.json'))).toBe(true);
  });

  it('the CLI reports version_mismatch with the board service restart hint for an operation the daemon does not know', async () => {
    const daemon = await fakeDaemon({ version: otherVersion, instance: randomUUID() });
    daemon.state.unknownOps = true;
    const result = await cli(daemon.url, boardHome());
    expect(result.code).toBe(3);
    expect(warnings(result.stderr)).toEqual([]);
    const error = (JSON.parse(result.stderr) as { error: { code: string; hint: string } }).error;
    expect(error.code).toBe('version_mismatch');
    expect(error.hint).toContain('board service restart');
    expect(daemon.log).toEqual([statusPost]);
  });

  it('skips the check when the instance header is absent or the schema is unavailable', async () => {
    const daemon = await fakeDaemon({ version: otherVersion });
    const home = boardHome();
    for (let call = 0; call < 2; call += 1) {
      const result = await cli(daemon.url, home);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    }
    expect(daemon.log).toEqual([statusPost, statusPost]);

    daemon.restart(otherVersion);
    daemon.state.schemaReady = false;
    daemon.log.length = 0;
    for (let call = 0; call < 2; call += 1) {
      const result = await cli(daemon.url, home);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(OPERATIONS[0].examples[0].output);
      expect(result.stderr).toBe('');
    }
    expect(daemon.log).toEqual([statusPost, schemaGet, statusPost, schemaGet]);
    expect(existsSync(join(home, 'version-check.json'))).toBe(false);

    daemon.log.length = 0;
    await withMcp(daemon.url, async (client) => {
      for (let call = 0; call < 2; call += 1) {
        const result = await client.callTool(query());
        expect(result.isError).not.toBe(true);
      }
    });
    expect(daemon.log).toEqual([statusPost, schemaGet, statusPost, schemaGet]);
  });
});
