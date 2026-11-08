import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { OPERATIONS } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.ts';
import { loadClientConfig } from '../src/config.ts';

const children: Server[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const server of children.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function fakeDaemon(
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

async function withClient<T>(
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

describe('board mcp', () => {
  it('uses the configured daemon without BOARD_DAEMON_URL', async () => {
    const daemon = await fakeDaemon((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          requestId: 'req-status',
          value: OPERATIONS[0].examples[0].output,
        }),
      );
    });
    const home = mkdtempSync(join(tmpdir(), 'mcp-address-'));
    homes.push(home);
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  - id: board\n    tracker: { type: github-issues, repo: example/board, label: board }\n    repos: [example/board]\n    operatorGithubLogin: operator\noperator: { slack: U0000000000 }\ndigest: { tz: UTC }\nhttp: { port: ${new URL(daemon.url).port} }\n`,
    );
    await withClient({ BOARD_HOME: home, BOARD_TOKEN: 'token' }, async (client) => {
      const result = await client.callTool({ name: 'status_get', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(OPERATIONS[0].examples[0].output);
      expect(daemon.requests).toHaveLength(1);
    });
  });
  it('lists one catalog tool with schemas, guidance and annotations per operation', async () => {
    await withClient({}, async (client) => {
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      expect(client.getServerVersion()?.version).toBe(manifest.version);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(OPERATIONS.map((op) => op.mcp.name));
      expect(tools).toMatchSnapshot();
      for (const [index, tool] of tools.entries()) {
        const op = OPERATIONS[index];
        if (!op) throw new Error('tool without catalog operation');
        expect(tool.description).toContain(op.mcp.whenToUse);
        expect(tool.description).toContain(op.mcp.whenNotToUse);
        if (op.kind === 'mutation') {
          expect(tool.description).toContain(`"idempotencyKey":"${op.mcp.name}-example-001"`);
          expect(tool.inputSchema.required ?? []).not.toContain('idempotencyKey');
        }
        expect(tool.annotations?.readOnlyHint).toBe(op.kind === 'query');
        expect(tool.annotations?.idempotentHint).toBe(op.kind === 'mutation');
        expect(tool.annotations?.destructiveHint, op.id).toBe(op.mcp.destructive);
        expect(tool.outputSchema).toBeDefined();
      }
      const status = tools.find((tool) => tool.name === 'status_get');
      expect(status?.inputSchema.properties?.['detail']).toMatchObject({ type: 'boolean' });
      expect(status?.inputSchema.required ?? []).not.toContain('detail');
      const commentAdd = tools.find((tool) => tool.name === 'comment_add');
      expect(commentAdd?.annotations?.destructiveHint).toBe(false);
      const unblock = tools.find((tool) => tool.name === 'block_unblock');
      expect(unblock?.inputSchema.type).toBe('object');
      const branches = unblock?.inputSchema.oneOf as Record<string, unknown>[] | undefined;
      expect(Array.isArray(branches)).toBe(true);
      for (const branch of branches ?? []) {
        expect(branch.additionalProperties).toBe(false);
        expect((branch.properties as Record<string, unknown>)['idempotencyKey']).toMatchObject({
          type: 'string',
          minLength: 1,
        });
      }
      if (!unblock) throw new Error('missing block_unblock');
      const validate = new AjvJsonSchemaValidator().getValidator(
        unblock.inputSchema as JsonSchemaType,
      );
      expect(
        validate({
          mode: 'done',
          block: 'B13',
          ref: 'example/web#9',
          idempotencyKey: 'unblock-PROJ-123',
        }).valid,
      ).toBe(true);
      expect(
        validate({
          mode: 'done',
          block: 'B13',
          ref: 'example/web#9',
          idempotencyKey: 'unblock-PROJ-123',
          extra: true,
        }).valid,
      ).toBe(false);
    });
  });

  it('advertises a required key and a valid example for every agent mutation', async () => {
    await withClient({ SPUR_SESSION: 'session-1' }, async (client) => {
      const { tools } = await client.listTools();
      for (const [index, tool] of tools.entries()) {
        const op = OPERATIONS[index];
        if (!op || op.kind !== 'mutation') continue;
        const schemas = Array.isArray(tool.inputSchema.oneOf)
          ? (tool.inputSchema.oneOf as Record<string, unknown>[])
          : [tool.inputSchema];
        for (const schema of schemas) {
          expect(schema.required).toContain('idempotencyKey');
        }
        const exampleLine = tool.description?.split('Example: ')[1]?.split('\n')[0];
        if (!exampleLine) throw new Error(`missing example for ${tool.name}`);
        const example = JSON.parse(exampleLine) as Record<string, unknown>;
        const validate = new AjvJsonSchemaValidator().getValidator(
          tool.inputSchema as JsonSchemaType,
        );
        expect(validate(example).valid).toBe(true);
        const withoutKey = { ...example };
        delete withoutKey['idempotencyKey'];
        expect(validate(withoutKey).valid).toBe(false);
      }
    });
  });

  it('reports missing identity only on a call', async () => {
    await withClient({}, async (client) => {
      expect((await client.listTools()).tools.length).toBe(OPERATIONS.length);
      const result = await client.callTool({ name: 'status_get', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'identity_missing' });
    });
  });

  it('uses session identity and rejects an agent mutation without a key before HTTP', async () => {
    const daemon = await fakeDaemon((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          requestId: 'req-1',
          value: OPERATIONS.find((op) => op.id === 'comment.add')?.examples[0].output,
        }),
      );
    });
    await withClient(
      { BOARD_DAEMON_URL: daemon.url, SPUR_SESSION: 'session-1', BOARD_TOKEN: 'operator-token' },
      async (client) => {
        const missing = await client.callTool({
          name: 'comment_add',
          arguments: { task: 'PROJ-123', text: 'Hello' },
        });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toMatchObject({ code: 'usage' });
        expect(daemon.requests).toHaveLength(0);
        const result = await client.callTool({
          name: 'comment_add',
          arguments: { task: 'PROJ-123', text: 'Hello', idempotencyKey: 'comment-PROJ-123-hello' },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(
          OPERATIONS.find((op) => op.id === 'comment.add')?.examples[0].output,
        );
        expect(daemon.requests[0]?.headers['x-board-session']).toBe('session-1');
        expect(daemon.requests[0]?.headers['authorization']).toBeUndefined();
        expect(daemon.requests[0]?.body.key).toBe('comment-PROJ-123-hello');
        expect(daemon.requests[0]?.body.input).toEqual({ task: 'PROJ-123', text: 'Hello' });
      },
    );
  });

  it('generates a key for an operator mutation and returns the sent key on timeout', async () => {
    const daemon = await fakeDaemon(() => {});
    await withClient(
      { BOARD_DAEMON_URL: daemon.url, BOARD_TOKEN: 'operator-token' },
      async (client) => {
        const result = await client.callTool({
          name: 'comment_add',
          arguments: { task: 'PROJ-123', text: 'Hello' },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: 'outcome_unknown' });
        const sentKey = daemon.requests[0]?.body.key;
        expect(sentKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.structuredContent).toMatchObject({ context: { idempotencyKey: sentKey } });
        expect(daemon.requests[0]?.headers['authorization']).toBe('Bearer operator-token');
      },
      20,
    );
  });

  it('returns structured usage for malformed input without an HTTP call', async () => {
    const daemon = await fakeDaemon(() => {});
    await withClient(
      { BOARD_DAEMON_URL: daemon.url, SPUR_SESSION: 'session-1' },
      async (client) => {
        const result = await client.callTool({
          name: 'block_unblock',
          arguments: { mode: 'done', block: 'B12', ref: 7, idempotencyKey: 'unblock-PROJ-123' },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: 'usage' });
        expect(daemon.requests).toHaveLength(0);
      },
    );
  });
});

it('keeps every board mcp stdout line a JSON-RPC message', async () => {
  const binary = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));
  const child = spawn(process.execPath, [binary, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BOARD_DAEMON_URL: '', BOARD_TOKEN: '', SPUR_SESSION: '' },
  });
  const lines: unknown[] = [];
  let pending = '';
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('MCP handshake timed out'));
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const message = JSON.parse(line) as Record<string, unknown>;
          expect(message.jsonrpc).toBe('2.0');
          lines.push(message);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve();
          }
          newline = pending.indexOf('\n');
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`MCP exited before handshake: ${String(code)}`));
    });
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    );
    await received;
    expect(lines).toHaveLength(2);
    const listed = lines[1] as { id: number; result: { tools: unknown } };
    expect(listed.id).toBe(2);
    expect(Array.isArray(listed.result.tools)).toBe(true);
    expect(pending).toBe('');
  } finally {
    child.kill();
  }
});
