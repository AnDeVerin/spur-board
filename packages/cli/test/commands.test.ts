import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@spur-board/contracts';
import { createProgram, runCli, type CliIo } from '../src/cli.ts';

const servers: Server[] = [];
const binary = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));

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
});

async function fakeServer(
  onRequest: (id: string, input: unknown, key: string | undefined) => unknown,
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: unknown; key?: string };
      const id = decodeURIComponent(request.url?.split('/').at(-1) ?? '');
      const value = onRequest(id, body.input, body.key);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, requestId: 'req-ok', value }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port.');
  return `http://127.0.0.1:${String(address.port)}`;
}

function capture(isTTY = false) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    isTTY,
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

function env(url: string): NodeJS.ProcessEnv {
  return { BOARD_DAEMON_URL: url, BOARD_TOKEN: 'token' };
}

describe('catalog commands', () => {
  it('registers every catalog path and shows each catalog example in help', async () => {
    const program = createProgram({ env: {}, io: capture().io });
    for (const op of OPERATIONS) {
      let command = program;
      for (const segment of op.cli.command.split(' ')) {
        const next = command.commands.find((item) => item.name() === segment);
        expect(next, `${op.id} command segment ${segment}`).toBeDefined();
        if (!next) throw new Error(`Missing command ${op.id}`);
        command = next;
      }
      const output = capture();
      expect(
        await runCli([...op.cli.command.split(' '), '--help'], { env: {}, io: output.io }),
      ).toBe(0);
      for (const example of op.examples) expect(output.stdout).toContain(example.summary);
      expect(output.stdout).toContain('Examples:');
    }
  });

  it('prints only the schema-valid result and invokes schema.get through HTTP', async () => {
    const schema = OPERATIONS.find((op) => op.id === 'schema.get');
    if (!schema) throw new Error('Missing schema operation.');
    const calls: { id: string; input: unknown; key: string | undefined }[] = [];
    const url = await fakeServer((id, input, key) => {
      calls.push({ id, input, key });
      return schema.examples[0].output;
    });
    const output = capture();
    expect(await runCli(['schema', '--json'], { env: env(url), io: output.io })).toBe(0);
    expect(schema.output.parse(JSON.parse(output.stdout))).toEqual(schema.examples[0].output);
    expect(output.stdout).not.toContain('requestId');
    expect(output.stderr).toBe('');
    expect(calls).toEqual([{ id: 'schema.get', input: {}, key: undefined }]);
  });

  it('maps positional, array, ordinary option, and union-mode inputs without defaults', async () => {
    const calls: { id: string; input: unknown }[] = [];
    const url = await fakeServer((id, input) => {
      calls.push({ id, input });
      const op = OPERATIONS.find((item) => item.id === id);
      if (!op) throw new Error(`No operation ${id}`);
      return op.examples[0].output;
    });
    const commands = [
      ['status', '--project', 'demo'],
      ['task', 'history', 'PROJ-123'],
      ['inbox', 'ack', 'C3', '--key', 'ack-1'],
      ['block', 'PROJ-123', '--type', 'dependency', '--reason', 'Waiting', '--key', 'block-1'],
      ['unblock', 'B12', '--withdraw', '--key', 'unblock-1'],
    ];
    for (const command of commands) {
      const output = capture();
      expect(await runCli(command, { env: env(url), io: output.io }), command.join(' ')).toBe(0);
    }
    expect(calls).toEqual([
      { id: 'status.get', input: { project: 'demo' } },
      { id: 'task.history', input: { task: 'PROJ-123' } },
      { id: 'inbox.ack', input: { ids: ['C3'] } },
      { id: 'block.create', input: { task: 'PROJ-123', type: 'dependency', reason: 'Waiting' } },
      { id: 'block.unblock', input: { block: 'B12', mode: 'withdraw' } },
    ]);
  });

  it('quotes untrusted comments in human output', async () => {
    const task = OPERATIONS.find((op) => op.id === 'task.get');
    if (!task) throw new Error('Missing task operation.');
    const url = await fakeServer(() => task.examples[0].output);
    const output = capture(true);
    expect(await runCli(['task', 'PROJ-123'], { env: env(url), io: output.io })).toBe(0);
    expect(output.stdout).toContain('> Target v2.');
    expect(output.stdout).not.toContain('requestId');
  });

  it('does not treat a positional --version as the top-level version flag', async () => {
    const comment = OPERATIONS.find((op) => op.id === 'comment.add');
    if (!comment) throw new Error('Missing comment operation.');
    let received: { id: string; input: unknown; key: string | undefined } | undefined;
    const url = await fakeServer((id, input, key) => {
      received = { id, input, key };
      return comment.examples[0].output;
    });
    const child = spawn(
      process.execPath,
      [binary, 'comment', 'PROJ-123', '--key', 'comment-version', '--', '--version'],
      {
        env: { ...process.env, BOARD_DAEMON_URL: url, BOARD_TOKEN: 'token', SPUR_SESSION: '' },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    const exit = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(exit).toBe(0);
    expect(received).toEqual({
      id: 'comment.add',
      input: { task: 'PROJ-123', text: '--version' },
      key: 'comment-version',
    });
    expect(comment.output.parse(JSON.parse(stdout))).toEqual(comment.examples[0].output);
    expect(stderr).toContain('key: comment-version');
  });

  it('renders terminal controls in untrusted comments as visible text', async () => {
    const task = OPERATIONS.find((op) => op.id === 'task.get');
    if (!task) throw new Error('Missing task operation.');
    const sample = task.examples[0].output as {
      task: unknown;
      blocks: unknown;
      comments: { id: string; author: string; at: string; text: string; untrusted: true }[];
    };
    const firstComment = sample.comments[0];
    if (!firstComment) throw new Error('Missing sample comment.');
    const hostileText =
      'safe\u001b[31mred\u001b[0m\n\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u009b31m';
    const url = await fakeServer(() => ({
      ...sample,
      comments: [{ ...firstComment, text: hostileText }],
    }));
    const output = capture(true);
    expect(await runCli(['task', 'PROJ-123'], { env: env(url), io: output.io })).toBe(0);
    expect(output.stdout).toContain('> safe\\u001b[31mred\\u001b[0m');
    expect(output.stdout).toContain('> \\u001b]8;;https://example.invalid\\u0007link');
    expect(output.stdout).toContain('\\u009b31m');
    expect(output.stdout).not.toMatch(/[\u001b\u0007\u009b]/u);
  });
});
