import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERRORS, OPERATIONS, errorEnvelopeSchema, renderHttpProblem } from '@spur-board/contracts';
import { createProgram, exampleCommand, runCli, type CliIo } from '../src/cli.ts';
import { holder } from './http-holder.ts';

type Program = ReturnType<typeof createProgram>;

/** Resolves a `board …` span from error guidance against the registered command tree. */
function resolveGuidance(program: Program, span: string): string | undefined {
  let command = program;
  const chain = [program];
  let used = 0;
  const words = span.split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word.startsWith('--')) {
      const option = chain.flatMap((item) => item.options).find((item) => item.long === word);
      if (!option) return `unknown flag ${word}`;
      if (/[<[]/.test(option.flags) && words[index + 1]?.startsWith('<')) index += 1;
    } else if (/^<[^>]+>$/.test(word)) {
      if (used >= command.registeredArguments.length) return `no argument slot for ${word}`;
      used += 1;
    } else {
      const next = command.commands.find((item) => item.name() === word);
      if (!next) return `unknown command ${word}`;
      command = next;
      chain.push(next);
      used = 0;
    }
  }
  return undefined;
}

const servers: Server[] = [];
const dirs: string[] = [];
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** A folder holding a mode-600 token file in a private `.spur-board`, below a fresh home. */
function existingTokenFolder(prefix: string): {
  home: string;
  folder: string;
  file: string;
  secret: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  const home = join(root, 'home');
  const folder = join(home, 'project');
  mkdirSync(join(folder, '.spur-board'), { recursive: true, mode: 0o700 });
  const secret = 'existing-token-secret';
  const file = join(realpathSync(folder), '.spur-board', 'token');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return { home, folder, file, secret };
}

/** A fake daemon that records every request and answers with one fixed response. */
async function recordingDaemon(
  status: number,
  contentType: string,
  body: unknown,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
      });
      response.writeHead(status, { 'content-type': contentType });
      response.end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  return { url: `http://127.0.0.1:${String(address.port)}`, requests };
}

/** Runs `token create --name desk --into <folder>` against the daemon at `url`. */
async function createDeskToken(url: string, home: string, folder: string) {
  const output = capture();
  const code = await runCli(['token', 'create', '--name', 'desk', '--into', folder], {
    env: { BOARD_DAEMON_URL: url },
    home,
    io: output.io,
  });
  return { code, stdout: output.stdout, stderr: output.stderr };
}

describe('catalog commands', () => {
  it('creates a mode-600 file and registers only its hash without a credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-token-create-'));
    dirs.push(root);
    const home = join(root, 'home');
    const folder = join(home, 'project');
    mkdirSync(folder, { recursive: true });
    let received:
      { url: string; authorization: string | undefined; body: Record<string, string> } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          url: request.url ?? '',
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>,
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            requestId: 'request-1',
            value: { name: 'desk', status: 'pending', expiresAt: '2026-11-04T10:15:00.000Z' },
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP port');
    const output = capture();
    expect(
      await runCli(['token', 'create', '--name', 'desk', '--into', folder, '--json'], {
        env: { BOARD_DAEMON_URL: `http://127.0.0.1:${String(address.port)}` },
        home,
        io: output.io,
      }),
    ).toBe(0);
    const file = join(folder, '.spur-board', 'token');
    const secret = readFileSync(file, 'utf8').trim();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(received).toMatchObject({ url: '/v1/tokens/requests', body: { name: 'desk', folder } });
    expect(received?.authorization).toBeUndefined();
    expect(received?.body.hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(output.stdout).not.toContain(secret);
    expect(output.stdout).toContain('"status":"pending"');
    expect(output.stdout).toContain(
      `"requestHash":"${createHash('sha256').update(secret).digest('hex').slice(0, 10)}"`,
    );
  });

  it('rejects creation in home, including a symlink to home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-token-home-'));
    dirs.push(root);
    const home = join(root, 'home');
    const alias = join(root, 'alias');
    mkdirSync(home);
    symlinkSync(home, alias);
    for (const folder of [home, alias]) {
      const output = capture();
      expect(
        await runCli(['token', 'create', '--name', 'desk', '--into', folder], {
          env: { BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
          home,
          io: output.io,
        }),
      ).toBe(2);
    }
    expect(() => statSync(join(home, '.spur-board', 'token'))).toThrow();
  });

  it('rejects an existing shared or symlinked token directory before writing a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-token-directory-'));
    dirs.push(root);
    const home = join(root, 'home');
    const shared = join(home, 'shared');
    const linked = join(home, 'linked');
    const target = join(root, 'target');
    mkdirSync(shared, { recursive: true });
    mkdirSync(linked);
    mkdirSync(target);
    mkdirSync(join(shared, '.spur-board'), { mode: 0o755 });
    symlinkSync(target, join(linked, '.spur-board'));
    for (const folder of [shared, linked]) {
      const output = capture();
      expect(
        await runCli(['token', 'create', '--name', 'desk', '--into', folder], {
          env: { BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
          home,
          io: output.io,
        }),
      ).toBe(4);
      expect(() => statSync(join(folder, '.spur-board', 'token'))).toThrow();
    }
  });

  it('rejects a token directory owned by a different user', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-token-owner-'));
    dirs.push(root);
    const home = join(root, 'home');
    const folder = join(home, 'project');
    mkdirSync(join(folder, '.spur-board'), { recursive: true, mode: 0o700 });
    const owner = statSync(join(folder, '.spur-board')).uid;
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try {
      expect(
        await runCli(['token', 'create', '--name', 'desk', '--into', folder], {
          env: { BOARD_DAEMON_URL: 'http://127.0.0.1:4311' },
          home,
          io: capture().io,
        }),
      ).toBe(4);
      expect(() => statSync(join(folder, '.spur-board', 'token'))).toThrow();
    } finally {
      getuid.mockRestore();
    }
  });

  it('removes only the newly created file after a definite enrollment rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-token-rejected-'));
    dirs.push(root);
    const home = join(root, 'home');
    const folder = join(home, 'project');
    mkdirSync(folder, { recursive: true });
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(400, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ status: 400, code: 'usage', requestId: 'rejected' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP port');
    const output = capture();
    expect(
      await runCli(['token', 'create', '--name', 'desk', '--into', folder], {
        env: { BOARD_DAEMON_URL: `http://127.0.0.1:${String(address.port)}` },
        home,
        io: output.io,
      }),
    ).toBe(2);
    expect(() => statSync(join(folder, '.spur-board', 'token'))).toThrow();
  });

  it('refuses an existing token file when the daemon cannot report its state', async () => {
    const { home, folder, file } = existingTokenFolder('cli-token-older-');
    const before = readFileSync(file);
    const daemon = await recordingDaemon(404, 'application/problem+json', {
      status: 404,
      code: 'not_found',
      requestId: 'older',
    });
    const output = await createDeskToken(daemon.url, home, folder);
    expect(output.code).toBe(4);
    expect(readFileSync(file)).toEqual(before);
    expect(daemon.requests.map((request) => request.url)).toEqual(['/v1/tokens/status']);
    expect(output.stderr).toContain(file);
    expect(output.stderr).toContain('`board service restart`');
  });

  it('keeps an existing token file when the daemon is unreachable', async () => {
    const { home, folder, file } = existingTokenFolder('cli-token-offline-');
    const before = readFileSync(file);
    const closed = await holder({});
    await closed.close();
    const output = await createDeskToken(`http://127.0.0.1:${String(closed.port)}`, home, folder);
    expect(output.code).toBe(3);
    expect(readFileSync(file)).toEqual(before);
    expect(output.stderr).toContain('daemon_unavailable');
  });

  it('refuses a token file this daemon does not know and points at BOARD_DAEMON_URL', async () => {
    const { home, folder, file, secret } = existingTokenFolder('cli-token-unknown-');
    const before = readFileSync(file);
    const daemon = await recordingDaemon(200, 'application/json', {
      ok: true,
      requestId: 'status-1',
      value: { status: 'unknown' },
    });
    const output = await createDeskToken(daemon.url, home, folder);
    expect(output.code).toBe(4);
    expect(readFileSync(file)).toEqual(before);
    expect(daemon.requests.map((request) => request.url)).toEqual(['/v1/tokens/status']);
    expect(daemon.requests[0]?.authorization).toBeUndefined();
    expect(daemon.requests[0]?.body).toEqual({
      hash: createHash('sha256').update(secret).digest('hex'),
    });
    expect(output.stdout + output.stderr).not.toContain(secret);
    expect(output.stderr).toContain(file);
    expect(output.stderr).toContain('BOARD_DAEMON_URL');
    expect(output.stderr).toContain('or its request ended over 7 days ago and was deleted');
  });

  it('keeps a symlinked existing token without asking the daemon', async () => {
    const { home, folder, file: link } = existingTokenFolder('cli-token-symlink-');
    const target = join(home, 'elsewhere');
    writeFileSync(target, 'elsewhere-secret\n', { mode: 0o600 });
    rmSync(link);
    symlinkSync(target, link);
    const daemon = await recordingDaemon(200, 'application/json', {
      ok: true,
      requestId: 'status-1',
      value: { status: 'expired' },
    });
    expect((await createDeskToken(daemon.url, home, folder)).code).toBe(4);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('elsewhere-secret\n');
    expect(daemon.requests).toEqual([]);
  });

  it('refuses a folder whose token lock another run holds, without asking the daemon', async () => {
    const { home, folder, file } = existingTokenFolder('cli-token-locked-');
    const lock = join(dirname(file), 'token.lock');
    writeFileSync(lock, 'held\n', { mode: 0o600 });
    const before = readFileSync(file);
    const daemon = await recordingDaemon(200, 'application/json', {
      ok: true,
      requestId: 'status-1',
      value: { status: 'expired' },
    });
    const output = await createDeskToken(daemon.url, home, folder);
    expect(output.code).toBe(4);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(lock, 'utf8')).toBe('held\n');
    expect(daemon.requests).toEqual([]);
    expect(output.stderr).toContain(lock);
    expect(output.stderr).toContain('`board token create`');
  });

  it('removes the folder lock after a success, a refusal and a failed enrollment', async () => {
    const enrolled = await recordingDaemon(200, 'application/json', {
      ok: true,
      requestId: 'request-1',
      value: { name: 'desk', status: 'pending', expiresAt: '2026-11-04T10:15:00.000Z' },
    });
    const approved = await recordingDaemon(200, 'application/json', {
      ok: true,
      requestId: 'status-1',
      value: { status: 'approved' },
    });
    const rejected = await recordingDaemon(400, 'application/problem+json', {
      status: 400,
      code: 'usage',
      requestId: 'rejected',
    });
    for (const [daemon, withToken, code] of [
      [enrolled, false, 0],
      [approved, true, 4],
      [rejected, false, 2],
    ] as const) {
      const { home, folder, file } = existingTokenFolder('cli-token-unlock-');
      if (!withToken) rmSync(file);
      expect((await createDeskToken(daemon.url, home, folder)).code).toBe(code);
      expect(existsSync(join(dirname(file), 'token.lock'))).toBe(false);
    }
  });

  it('uses generated list and revoke commands for named tokens', async () => {
    const calls: { id: string; input: unknown }[] = [];
    const url = await fakeServer((id, input) => {
      calls.push({ id, input });
      const op = OPERATIONS.find((entry) => entry.id === id);
      if (!op) throw new Error('Missing operation');
      return op.examples[0].output;
    });
    const output = capture();
    expect(await runCli(['token', 'list'], { env: env(url), io: output.io })).toBe(0);
    expect(await runCli(['token', 'revoke', 'desk'], { env: env(url), io: output.io })).toBe(0);
    expect(calls).toEqual([
      { id: 'token.list', input: {} },
      { id: 'token.revoke', input: { name: 'desk' } },
    ]);
  });

  it('names only registered commands, arguments and flags in error guidance', () => {
    const program = createProgram({ env: {}, io: capture().io });
    const spans = new Set<string>();
    for (const entry of Object.values(ERRORS)) {
      const texts = [entry.message, entry.hint, ...Object.values(entry.recovery)];
      for (const text of texts) {
        if (typeof text !== 'string') continue;
        for (const match of text.matchAll(/`board ([^`]+)`/g)) spans.add(match[1] ?? '');
      }
    }
    for (const span of spans)
      expect(resolveGuidance(program, span), `board ${span}`).toBeUndefined();
    for (const span of ['service status', 'service restart', 'service install', 'task <KEY>'])
      expect(spans).toContain(span);
    expect(resolveGuidance(program, 'service start')).toBe('unknown command start');
    expect(resolveGuidance(program, 'status --bogus')).toBe('unknown flag --bogus');
    expect(resolveGuidance(program, 'status <EXTRA>')).toBe('no argument slot for <EXTRA>');
  });

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
      for (const option of command.options)
        expect(option.description, `${op.id} ${option.flags}`).not.toBe('');
    }
  });

  it('lists board mcp in help and prints its usage without starting the server', async () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const root = capture();
    expect(await runCli(['--help'], { env: {}, io: root.io })).toBe(0);
    expect(root.stdout).toMatch(/^\s+mcp\s+Start the MCP server/m);
    expect(flat(root.stdout)).toContain(
      ' mcp Start the MCP server for an agent on standard input and output.',
    );

    const helpMcp = capture();
    expect(await runCli(['help', 'mcp'], { env: {}, io: helpMcp.io })).toBe(0);
    expect(helpMcp.stdout.startsWith('Usage: board mcp')).toBe(true);

    const child = spawn(process.execPath, [binary, 'mcp', '--help'], {
      env: { ...process.env, SPUR_SESSION: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([
        new Promise<number | null>((resolve) => child.once('close', resolve)),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout');
          }, 10_000);
        }),
      ]);
      expect(exit).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
    expect(stdout.startsWith('Usage: board mcp')).toBe(true);
    for (const text of [
      'SPUR_SESSION',
      'BOARD_TOKEN',
      '.spur-board/token',
      'claude mcp add spur-board -- board mcp',
      'codex mcp add spur-board -- board mcp',
    ])
      expect(flat(stdout)).toContain(text);
    expect(stdout.split('\n').filter((line) => line.startsWith('{"jsonrpc"'))).toEqual([]);
    expect(stderr).toBe('');

    const flag = capture();
    expect(await runCli(['mcp', '--json'], { env: {}, io: flag.io })).toBe(2);
    expect(flat(flag.stderr)).toContain('Run `board mcp` with no other arguments');

    const extra = capture();
    expect(await runCli(['mcp', 'extra'], { env: {}, io: extra.io })).toBe(2);
    expect(extra.stderr).toContain("too many arguments for 'mcp'");
  }, 15_000);

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
      ['columns', 'describe', '--project', 'demo'],
      ['columns', 'describe'],
      ['config', 'get', '--project', 'demo'],
      ['config', 'get'],
      ['status', '--project', 'demo'],
      ['status'],
      ['status', '--detail'],
      ['task', 'history', 'PROJ-123'],
      ['inbox', 'ack', 'C3@2', 'C4@1', '--key', 'ack-1'],
      ['inbox', 'ack', 'B13', '--key', 'ack-block'],
      ['inbox', 'ack', 'T4', '--key', 'ack-turn'],
      ['inbox', 'ack', 'N18-1', '--key', 'ack-ring'],
      ['block', 'PROJ-123', '--type', 'dependency', '--reason', 'Waiting', '--key', 'block-1'],
      ['unblock', 'B12', '--withdraw', 'No longer needed', '--key', 'unblock-1'],
      ['escalate', 'B12', '--note', 'Owner is away', '--key', 'escalate-1'],
      ['answer', 'B12', 'Target v2.', '--note', 'Checked the release plan.', '--key', 'answer-1'],
      ['submit', 'T4', '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4', '--key', 'submit-1'],
      [
        'submit',
        'T4',
        '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4',
        '--basis',
        'carried',
        '--from',
        'a'.repeat(40),
        '--reason',
        'Same work',
        '--key',
        'submit-2',
      ],
      ['submit', 'T4', '--reason', 'Wrap-up', '--key', 'submit-3'],
      ['return', 'T4', 'Handle the empty list', '--key', 'return-1'],
      ['return', 'T4', 'Handle the empty list', '--findings', '3', '--key', 'return-2'],
      ['task', 'PROJ-123', '--why'],
      ['task', 'PROJ-123', '--detail'],
      ['move', 'PROJ-123', 'dev', '--correct', '--reason', 'Wrong PR', '--key', 'move-1'],
      ['move', 'PROJ-123', 'ready-for-dev', '--reason', '  Ready\nnow  ', '--key', 'manual-1'],
      ['move', 'PROJ-123', 'todo', '--manual', '--reason', 'Ready', '--key', 'manual-2'],
      ['project', 'ask', 'web', 'Restart?', '--to', 'operator', '--key', 'ask-1'],
    ];
    for (const command of commands) {
      const output = capture();
      expect(await runCli(command, { env: env(url), io: output.io }), command.join(' ')).toBe(0);
    }
    expect(calls).toEqual([
      { id: 'columns.describe', input: { project: 'demo' } },
      { id: 'columns.describe', input: {} },
      { id: 'config.get', input: { project: 'demo' } },
      { id: 'config.get', input: {} },
      { id: 'status.get', input: { project: 'demo' } },
      { id: 'status.get', input: {} },
      { id: 'status.get', input: { detail: true } },
      { id: 'task.history', input: { task: 'PROJ-123' } },
      {
        id: 'inbox.ack',
        input: {
          entries: [
            { id: 'C3', revision: 2 },
            { id: 'C4', revision: 1 },
          ],
        },
      },
      { id: 'inbox.ack', input: { entries: [{ id: 'B13' }] } },
      { id: 'inbox.ack', input: { entries: [{ id: 'T4' }] } },
      { id: 'inbox.ack', input: { entries: [{ id: 'N18-1' }] } },
      { id: 'block.create', input: { task: 'PROJ-123', type: 'dependency', reason: 'Waiting' } },
      {
        id: 'block.unblock',
        input: { block: 'B12', mode: 'withdraw', answer: 'No longer needed' },
      },
      { id: 'block.escalate', input: { block: 'B12', note: 'Owner is away' } },
      {
        id: 'block.answer',
        input: { block: 'B12', text: 'Target v2.', note: 'Checked the release plan.' },
      },
      { id: 'task.submit', input: { turn: 'T4', sha: '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4' } },
      {
        id: 'task.submit',
        input: {
          turn: 'T4',
          sha: '9f2c4e1b7a3d5c8e0f1a2b3c4d5e6f708192a3b4',
          basis: 'carried',
          from: 'a'.repeat(40),
          reason: 'Same work',
        },
      },
      { id: 'task.submit', input: { turn: 'T4', reason: 'Wrap-up' } },
      { id: 'task.return', input: { turn: 'T4', reason: 'Handle the empty list' } },
      {
        id: 'task.return',
        input: { turn: 'T4', reason: 'Handle the empty list', findings: 3 },
      },
      { id: 'task.get', input: { task: 'PROJ-123', why: true } },
      { id: 'task.get', input: { task: 'PROJ-123', detail: true } },
      {
        id: 'task.move',
        input: { mode: 'correct', task: 'PROJ-123', column: 'dev', reason: 'Wrong PR' },
      },
      {
        id: 'task.move',
        input: {
          mode: 'manual',
          task: 'PROJ-123',
          column: 'ready-for-dev',
          reason: '  Ready\nnow  ',
        },
      },
      {
        id: 'task.move',
        input: { mode: 'manual', task: 'PROJ-123', column: 'todo', reason: 'Ready' },
      },
      { id: 'project.ask', input: { project: 'web', text: 'Restart?', to: 'operator' } },
    ]);
  });

  it.each(
    [[], ['--key', ''], ['--key', '   '], ['--manual', '--correct', '--key', 'move-1']].map(
      (extra) => ({ extra }),
    ),
  )('refuses manual key/mode misuse locally: $extra', async ({ extra }) => {
    const output = capture();
    let sent = false;
    const code = await runCli(['move', 'PROJ-123', 'todo', '--reason', 'Ready.', ...extra], {
      io: output.io,
      env: {},
      sendOperation: () => {
        sent = true;
        throw new Error('Unexpected send');
      },
    });
    expect(code).toBe(2);
    expect(sent).toBe(false);
  });

  it.each([
    { extra: ['--key', 'order-1'] },
    { extra: ['--top', '--bottom', '--key', 'order-1'] },
    { extra: ['--before', 'PROJ-120', '--top', '--key', 'order-1'] },
    { extra: ['--top'] },
    { extra: ['--before', 'PROJ-120', '--key', '  '] },
  ])('refuses order placement and key misuse locally: $extra', async ({ extra }) => {
    const output = capture();
    let sent = false;
    const code = await runCli(['order', 'PROJ-123', ...extra], {
      io: output.io,
      env: {},
      sendOperation: () => {
        sent = true;
        throw new Error('Unexpected send');
      },
    });
    expect(code).toBe(2);
    expect(sent).toBe(false);
  });

  it('sends one order placement per flag with its anchor and prints position and neighbours', async () => {
    const order = OPERATIONS.find((op) => op.id === 'task.order');
    if (!order) throw new Error('Missing order operation.');
    const calls: { id: string; input: unknown; key: string | undefined }[] = [];
    const url = await fakeServer((id, input, key) => {
      calls.push({ id, input, key });
      return order.examples[0].output;
    });
    for (const flags of [
      ['--before', 'PROJ-120'],
      ['--after', 'PROJ-120'],
      ['--top'],
      ['--bottom'],
    ]) {
      const output = capture();
      expect(
        await runCli(['order', 'PROJ-123', ...flags, '--key', 'order-1', '--json'], {
          env: env(url),
          io: output.io,
        }),
      ).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual(order.examples[0].output);
    }
    expect(calls).toEqual([
      {
        id: 'task.order',
        input: { mode: 'before', task: 'PROJ-123', anchor: 'PROJ-120' },
        key: 'order-1',
      },
      {
        id: 'task.order',
        input: { mode: 'after', task: 'PROJ-123', anchor: 'PROJ-120' },
        key: 'order-1',
      },
      { id: 'task.order', input: { mode: 'top', task: 'PROJ-123' }, key: 'order-1' },
      { id: 'task.order', input: { mode: 'bottom', task: 'PROJ-123' }, key: 'order-1' },
    ]);
  });

  it('prints position on every board status --json row', async () => {
    const status = OPERATIONS.find((op) => op.id === 'status.get');
    if (!status) throw new Error('Missing status operation.');
    const url = await fakeServer(() => status.examples[0].output);
    const output = capture();
    expect(await runCli(['status', '--json'], { env: env(url), io: output.io })).toBe(0);
    const tasks = (JSON.parse(output.stdout) as { tasks: { position?: number }[] }).tasks;
    expect(tasks.map((task) => task.position)).toEqual([1]);
  });

  it.each(['submit_basis_invalid', 'submit_source_not_tested'] as const)(
    'reports %s with guidance and refuses malformed basis locally',
    async (code) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(409, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify(renderHttpProblem({ code, requestId: 'req-basis' }).body));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP port');
      const url = `http://127.0.0.1:${String(address.port)}`;
      const output = capture();
      expect(
        await runCli(
          [
            'submit',
            'T4',
            'b'.repeat(40),
            '--basis',
            'carried',
            '--from',
            'a'.repeat(40),
            '--reason',
            'Same work',
            '--key',
            'basis-1',
          ],
          { env: env(url), io: output.io },
        ),
      ).toBe(1);
      expect(output.stderr).toContain(code);
      expect(output.stderr).toContain(ERRORS[code].hint);
      expect(
        await runCli(['submit', 'T4', 'b'.repeat(40), '--basis', 'unknown', '--key', 'basis-2'], {
          env: env(url),
          io: capture().io,
        }),
      ).toBe(2);
      expect(requests).toBe(1);
    },
  );

  it('prints an ack with already handled entries as a success', async () => {
    const response = { acked: ['B13'], alreadyHandled: ['B13'] };
    const url = await fakeServer(() => response);
    const output = capture();
    expect(
      await runCli(['inbox', 'ack', 'B13', '--key', 'k', '--json'], {
        env: env(url),
        io: output.io,
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(response);
  });

  it('maps link and unlink target flags, reason, and idempotency keys', async () => {
    const calls: { id: string; input: unknown; key: string | undefined }[] = [];
    const url = await fakeServer((id, input, key) => {
      calls.push({ id, input, key });
      const operation = OPERATIONS.find((entry) => entry.id === id);
      if (operation === undefined) throw new Error(`No operation ${id}`);
      return operation.examples[0].output;
    });
    for (const [command, flag, value, key] of [
      ['link', '--pr', 'https://github.com/o/r/pull/7', 'link-pr'],
      ['link', '--session', 'worker-1', 'link-session'],
      ['link', '--ticket', 'o/r#10', 'link-ticket'],
      ['unlink', '--ticket', 'o/r#10', 'unlink-ticket'],
    ] as const) {
      const output = capture();
      expect(
        await runCli([command, 'o/r#9', flag, value, '--reason', 'Correction.', '--key', key], {
          env: env(url),
          io: output.io,
        }),
      ).toBe(0);
    }
    expect(calls).toEqual([
      {
        id: 'link.add',
        input: {
          task: 'o/r#9',
          mode: 'pr',
          pr: 'https://github.com/o/r/pull/7',
          reason: 'Correction.',
        },
        key: 'link-pr',
      },
      {
        id: 'link.add',
        input: { task: 'o/r#9', mode: 'session', session: 'worker-1', reason: 'Correction.' },
        key: 'link-session',
      },
      {
        id: 'link.add',
        input: { task: 'o/r#9', mode: 'ticket', ticket: 'o/r#10', reason: 'Correction.' },
        key: 'link-ticket',
      },
      {
        id: 'link.remove',
        input: { task: 'o/r#9', mode: 'ticket', ticket: 'o/r#10', reason: 'Correction.' },
        key: 'unlink-ticket',
      },
    ]);
    for (const args of [
      ['link', 'o/r#9', '--pr', 'https://github.com/o/r/pull/7'],
      [
        'link',
        'o/r#9',
        '--pr',
        'https://github.com/o/r/pull/7',
        '--session',
        'worker-1',
        '--reason',
        'Wrong.',
      ],
      ['unlink', 'o/r#9', '--reason', 'Wrong.'],
    ]) {
      const output = capture();
      expect(await runCli(args, { env: env(url), io: output.io })).toBe(2);
    }
    expect(calls).toHaveLength(4);
  });

  it('accepts --done with and without a reference', async () => {
    const calls: unknown[] = [];
    const unblock = OPERATIONS.find((op) => op.id === 'block.unblock');
    if (!unblock) throw new Error('Missing unblock operation.');
    const url = await fakeServer((_id, input) => {
      calls.push(input);
      return unblock.examples[0].output;
    });
    for (const args of [
      ['unblock', 'B12', '--done'],
      ['unblock', 'B12', '--done', 'PROJ-124'],
    ]) {
      const output = capture();
      expect(await runCli(args, { env: env(url), io: output.io })).toBe(0);
    }
    expect(calls).toEqual([
      { block: 'B12', mode: 'done' },
      { block: 'B12', mode: 'done', ref: 'PROJ-124' },
    ]);
  });

  it('rejects malformed inbox revisions and a missing --withdraw answer', async () => {
    const output = capture();
    for (const args of [
      ['inbox', 'ack', 'C3'],
      ['inbox', 'ack', 'C3@0'],
      ['inbox', 'ack', 'C3@1.5'],
      ['unblock', 'B12', '--withdraw'],
    ]) {
      expect(await runCli(args, { env: {}, io: output.io }), args.join(' ')).toBe(2);
    }
  });

  it('sends every mutation example with explicit keys where required and generated keys otherwise', async () => {
    const calls: { id: string; input: unknown; key: string | undefined }[] = [];
    const url = await fakeServer((id, input, key) => {
      calls.push({ id, input, key });
      return OPERATIONS.find((op) => op.id === id)?.examples[0].output;
    });
    const identities: NodeJS.ProcessEnv[] = [
      { BOARD_DAEMON_URL: url, SPUR_SESSION: 'test-session' },
      { BOARD_DAEMON_URL: url, BOARD_TOKEN: 'token' },
    ];
    const mutations = OPERATIONS.filter((op) => op.kind === 'mutation');
    expect(mutations.length).toBeGreaterThan(0);
    for (const op of mutations) {
      const example = op.examples[0].input as Record<string, unknown>;
      const words = (exampleCommand(op, example).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(
        (word) => (word.startsWith('"') ? (JSON.parse(word) as string) : word),
      );
      const args = [
        ...words.slice(1),
        ...(op.explicitKeyModes?.includes(String(example['mode']))
          ? ['--key', `${op.mcp.name}-example-001`]
          : []),
        '--json',
      ];
      for (const identity of identities) {
        calls.length = 0;
        const output = capture();
        const label = `${args.join(' ')} as ${identity['SPUR_SESSION'] ? 'agent' : 'operator'}`;
        expect(await runCli(args, { env: identity, io: output.io }), label).toBe(0);
        expect(calls, label).toHaveLength(1);
        const call = calls[0];
        if (!call) throw new Error(`Expected a request for ${label}.`);
        expect(call.id, label).toBe(op.id);
        expect(call.input, label).toEqual(example);
        if (op.explicitKeyModes?.includes(String(example['mode'])))
          expect(call.key, label).toBe(`${op.mcp.name}-example-001`);
        else expect(call.key, label).toMatch(/^[0-9a-f-]{36}$/);
        expect(output.stderr, label).toContain(`key: ${call.key ?? ''}`);
      }
    }
  });

  it('names the failing flag or argument in CLI usage hints', async () => {
    for (const [args, flags] of [
      [
        ['unblock', 'B12', '--done', '--reason', 'x'],
        ['--done', '--reason'],
      ],
      [['unblock', 'B12'], ['--done']],
      [['ask', 'PROJ-123', 'Q?', '--key', ''], ['--key']],
      [['answer', 'X12', 't'], ['block']],
    ] as const) {
      const output = capture();
      expect(await runCli([...args, '--json'], { env: {}, io: output.io }), args.join(' ')).toBe(2);
      const { error } = errorEnvelopeSchema.parse(JSON.parse(output.stderr));
      expect(error.code).toBe('usage');
      expect(error.hint, args.join(' ')).not.toBe(ERRORS.usage.hint);
      for (const flag of flags) expect(error.hint, args.join(' ')).toContain(flag);
    }
  });

  it('shows the generated revision and mode-value syntax in help', async () => {
    const move = capture();
    expect(await runCli(['move', '--help'], { env: {}, io: move.io })).toBe(0);
    expect(move.stdout).toMatch(
      /--reason <value>\s+Literal reason for manual placement or correction/,
    );
    const ack = capture();
    expect(await runCli(['inbox', 'ack', '--help'], { env: {}, io: ack.io })).toBe(0);
    expect(ack.stdout).toContain('board inbox ack C3@1');
    expect(ack.stdout).not.toContain('[object Object]');

    const unblock = capture();
    expect(await runCli(['unblock', '--help'], { env: {}, io: unblock.io })).toBe(0);
    expect(unblock.stdout).toContain('--done [ref]');
    expect(unblock.stdout).toContain('--withdraw <answer>');
    expect(unblock.stdout).toMatch(/--done \[ref\]\s+What resolved the block/);
    expect(unblock.stdout).toMatch(/--reason <reason>\s+Why the block no longer applies/);
    expect(unblock.stdout).toMatch(/--withdraw <answer>\s+Why it is withdrawn/);
    expect(unblock.stdout).toMatch(/--key <key>\s+Idempotency key for this action/);
    expect(unblock.stdout).toMatch(/--json\s+Print JSON output or a JSON error/);

    const wait = capture();
    expect(await runCli(['wait', '--help'], { env: {}, io: wait.io })).toBe(0);
    expect(wait.stdout).toContain('board wait T4 --end');
    expect(wait.stdout).toMatch(/--end\s+Operator only/);
    expect(wait.stdout).not.toContain('--end <value>');

    const submit = capture();
    expect(await runCli(['submit', '--help'], { env: {}, io: submit.io })).toBe(0);
    expect(submit.stdout).toMatch(/Usage: board submit \[options\] <turn> \[sha\]/);
    expect(submit.stdout).toContain('board submit T5 --reason');

    for (const command of ['link', 'unlink']) {
      const help = capture();
      expect(await runCli([command, '--help'], { env: {}, io: help.io })).toBe(0);
      expect(help.stdout, command).toMatch(/--pr <pr>\s+Pull request URL/);
      expect(help.stdout, command).toMatch(/--session <session>\s+Spur session ID/);
      expect(help.stdout, command).toMatch(/--ticket <ticket>\s+Task key/);
    }
  });

  it.each([
    [false, []],
    [true, ['--json']],
    [true, []],
  ] as const)('retains active and handled inbox URLs, TTY %s flags %s', async (tty, flags) => {
    const entry = {
      id: 'I1',
      project: '_board',
      kind: 'board_observation',
      severity: 'failure',
      text: 'Run failed',
      at: '2026-11-04T08:00:00.000Z',
      task: null,
      url: 'https://example.test/run',
    };
    const value = {
      items: [entry],
      handled: [{ ...entry, id: 'I2', handledAt: entry.at, url: 'http://example.test/handled' }],
    };
    const url = await fakeServer(() => value);
    const output = capture(tty);
    expect(await runCli(['inbox', 'operator', ...flags], { env: env(url), io: output.io })).toBe(0);
    expect(output.stdout).toContain(entry.url);
    expect(output.stdout).toContain(value.handled[0]?.url);
    if (!tty || flags.length) expect(JSON.parse(output.stdout)).toEqual(value);
  });

  it('renders readable column policy and preserves structured IDs while escaping terminal controls', async () => {
    const operation = OPERATIONS.find((operation) => operation.id === 'columns.describe');
    if (!operation) throw new Error('missing columns operation');
    const example = operation.examples[0].output;
    const value = {
      ...example,
      projects: example.projects.map((project) => ({
        ...project,
        columns: project.columns.map((column) => ({ ...column, name: 'To Do\u001b[2J' })),
      })),
    };
    const url = await fakeServer(() => value);
    for (const [tty, args] of [
      [true, []],
      [true, ['--json']],
      [false, []],
    ] as const) {
      const output = capture(tty);
      expect(
        await runCli(['columns', 'describe', '--project', 'web', ...args], {
          env: env(url),
          io: output.io,
        }),
      ).toBe(0);
      expect(output.stderr).toBe('');
      if (tty && args.length === 0) {
        expect(output.stdout).toContain('Work has started');
        expect(output.stdout).toContain('No executor turn opens');
        expect(output.stdout).not.toContain('\u001b');
      } else expect(JSON.parse(output.stdout)).toEqual(value);
    }
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

  it('prints the shadow column and whether it differs in board status human output', async () => {
    const status = OPERATIONS.find((op) => op.id === 'status.get');
    if (!status) throw new Error('Missing status operation.');
    const example = status.examples[0].output;
    const url = await fakeServer(() => ({
      ...example,
      tasks: example.tasks.map((task) => ({
        ...task,
        column: 'todo',
        shadowColumn: 'review',
        shadowDiffers: true,
      })),
    }));
    const output = capture(true);
    expect(await runCli(['status'], { env: env(url), io: output.io })).toBe(0);
    expect(output.stdout).toContain(
      '    column: todo\n    membership: active\n    columnEnteredAt: 2026-01-05T09:30:00.000Z\n    position: 1\n    shadowColumn: review\n    shadowDiffers: true\n',
    );
  });

  it('prints board status in human format without shadow fields when the row has none', async () => {
    const status = OPERATIONS.find((op) => op.id === 'status.get');
    if (!status) throw new Error('Missing status operation.');
    const url = await fakeServer(() => status.examples[0].output);
    const output = capture(true);
    expect(await runCli(['status'], { env: env(url), io: output.io })).toBe(0);
    expect(output.stdout).toMatchInlineSnapshot(`
      "items:

      warmingUp: true
      spurUnavailable: null
      hostLoad: null
      host:
        sampledAt: 2026-01-05T09:30:00.000Z
        cpuPercent: 12.5
        memory:
          totalBytes: 17179869184
          availableBytes: 8589934592
          usedPercent: 50
        disk:
          mount: /
          totalBytes: 107374182400
          availableBytes: 64424509440
          usedPercent: 40
        volumes:
          - mount: /
            totalBytes: 107374182400
            availableBytes: 64424509440
            usedPercent: 40
          - mount: /home
            totalBytes: 536870912000
            availableBytes: 375809638400
            usedPercent: 30
      services:
        - service: daemon
          state: healthy
          since: 2026-01-05T08:00:00.000Z
          lastGoodAt: 2026-01-05T09:30:00.000Z
          reason: null
      transport:

      sources:

      tasks:
        - key: PROJ-123
          project: web
          column: dev
          membership: active
          columnEnteredAt: 2026-01-05T09:30:00.000Z
          position: 1
          state: ticket not observed
          prCount: 0
          sessionCount: 0
          openBlocks: 0
          blocks:

          turn: null
          prSummary: null
          links:
            ticket: null
            prs:

            sessions:

      columnGroups:
        - id: todo
          columns:
            - todo
            - triage
            - ready-for-dev
      projectBlocks:
        - project: web
          openBlocks: 0
      unlinkedPrs:

      unlinkedSessions:

      hiddenUnlinkedPrs: 0
      hiddenUnlinkedSessions: 0
      bindings:
        columns:
          - project: web
            column: review
            orchestrator: web-review
            source: project
        operators:
          - project: web
            operator: hq
            source: board-wide
        defaultAddressee:
          spurProject: hq
          source: board-wide
      daemon:
        version: 0.4.0
        startedAt: 2026-01-05T08:00:00.000Z
        lastDispatchAt: 2026-01-05T09:30:00.000Z
      "
    `);
  });

  it.each(['2026-11-04T08:00:00.000Z', null])(
    'retains column entry %s in detailed human and JSON status',
    async (columnEnteredAt) => {
      const status = OPERATIONS.find((op) => op.id === 'status.get');
      if (!status) throw new Error('Missing status operation.');
      const value = {
        ...status.examples[0].output,
        tasks: status.examples[0].output.tasks.map((task) => ({ ...task, columnEnteredAt })),
      };
      const url = await fakeServer(() => value);
      for (const flags of [[], ['--json']]) {
        const output = capture(true);
        expect(
          await runCli(['status', '--detail', ...flags], { env: env(url), io: output.io }),
        ).toBe(0);
        if (flags.length) expect(JSON.parse(output.stdout)).toEqual(value);
        else expect(output.stdout).toContain(`columnEnteredAt: ${String(columnEnteredAt)}`);
      }
    },
  );

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

  it('escapes server-controlled values and object keys in human output', async () => {
    const task = OPERATIONS.find((op) => op.id === 'task.get');
    const schema = OPERATIONS.find((op) => op.id === 'schema.get');
    if (!task || !schema) throw new Error('Missing catalog operations.');
    const taskSample = task.examples[0].output as {
      blocks: { reason: string }[];
    };
    const firstBlock = taskSample.blocks[0];
    if (!firstBlock) throw new Error('Missing sample block.');
    const taskUrl = await fakeServer(() => ({
      ...taskSample,
      blocks: [
        { ...firstBlock, reason: 'blocked\u001b]8;;https://example.invalid\u0007now\u000dnext' },
      ],
    }));
    const taskOutput = capture(true);
    expect(await runCli(['task', 'PROJ-123'], { env: env(taskUrl), io: taskOutput.io })).toBe(0);
    expect(taskOutput.stdout).toContain(
      'reason: blocked\\u001b]8;;https://example.invalid\\u0007now\\u000dnext',
    );
    expect(taskOutput.stdout).not.toMatch(/[\u001b\u0007\u000d]/u);

    const schemaSample = schema.examples[0].output as {
      operations: { inputSchema: Record<string, unknown> }[];
    };
    const firstOperation = schemaSample.operations[0];
    if (!firstOperation) throw new Error('Missing sample operation.');
    const hostileKey = 'field\u001b[31m';
    const schemaUrl = await fakeServer(() => ({
      ...schemaSample,
      operations: [{ ...firstOperation, inputSchema: { [hostileKey]: 'value\u009b31m' } }],
    }));
    const schemaOutput = capture(true);
    expect(await runCli(['schema'], { env: env(schemaUrl), io: schemaOutput.io })).toBe(0);
    expect(schemaOutput.stdout).toContain('field\\u001b[31m: value\\u009b31m');
    expect(schemaOutput.stdout).not.toMatch(/[\u001b\u009b]/u);

    const jsonOutput = capture();
    expect(await runCli(['schema', '--json'], { env: env(schemaUrl), io: jsonOutput.io })).toBe(0);
    const json = JSON.parse(jsonOutput.stdout) as {
      operations: { inputSchema: Record<string, unknown> }[];
    };
    expect(json.operations[0]?.inputSchema[hostileKey]).toBe('value\u009b31m');
  });

  describe('task --why view', () => {
    const task = OPERATIONS.find((op) => op.id === 'task.get');
    if (!task) throw new Error('Missing task operation.');
    const example = task.examples[1]?.output;
    if (!example) throw new Error('Missing the why example.');
    const disabled = [
      'triage',
      'ready-for-dev',
      'product-review',
      'external-review',
      'qa',
      'ready-to-merge',
    ];
    const columnLines = (stdout: string) =>
      [...stdout.matchAll(/^\s*(?:- )?column: (\S+)$/gm)].map((match) => match[1]);
    /** Runs `board <args>` against a server answering `value`; counts its calls. */
    async function run(args: string[], isTTY: boolean, value: unknown = example) {
      let calls = 0;
      const url = await fakeServer(() => {
        calls += 1;
        return value;
      });
      const output = capture(isTTY);
      const code = await runCli(args, { env: env(url), io: output.io });
      return { code, calls, stdout: output.stdout, stderr: output.stderr };
    }

    it('leads with what the task waits for and leaves out disabled columns on a terminal', async () => {
      const { code, stdout } = await run(['task', 'PROJ-123', '--why'], true);
      expect(code).toBe(0);
      expect(stdout.startsWith('waits for: Review turn T4 (orchestrator:review)\n')).toBe(true);
      expect(columnLines(stdout)).toContain('done');
      for (const column of disabled) expect(columnLines(stdout)).not.toContain(column);
    });

    it('lists every column with --all', async () => {
      const { code, stdout } = await run(['task', 'PROJ-123', '--why', '--all'], true);
      expect(code).toBe(0);
      expect(stdout.startsWith('waits for: ')).toBe(true);
      for (const column of disabled) expect(columnLines(stdout)).toContain(column);
    });

    it('keeps every column in JSON, with or without --all', async () => {
      for (const args of [
        ['task', 'PROJ-123', '--why'],
        ['task', 'PROJ-123', '--why', '--json', '--all'],
      ]) {
        const { code, stdout } = await run(args, args.includes('--json'));
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual(example);
      }
    });

    it('refuses --all without --why before calling the daemon', async () => {
      const { code, calls, stderr } = await run(['task', 'PROJ-123', '--all'], true);
      expect(code).toBe(2);
      expect(calls).toBe(0);
      expect(stderr).toContain('--all needs --why.');
    });

    it('prints the plain view without --why', async () => {
      const { code, stdout } = await run(['task', 'PROJ-123'], true, {
        ...example,
        why: undefined,
      });
      expect(code).toBe(0);
      expect(stdout.startsWith('waits for:')).toBe(false);
      expect(stdout.startsWith('task:')).toBe(true);
      const full = await run(['task', 'PROJ-123'], true);
      expect(columnLines(full.stdout)).toContain('triage');
    });

    it('refuses an older daemon why without waitsFor in the strict output parse', async () => {
      const why = Object.fromEntries(
        Object.entries(example.why ?? {}).filter(([key]) => key !== 'waitsFor'),
      );
      const { code, stdout } = await run(['task', 'PROJ-123', '--why'], true, { ...example, why });
      expect(code).toBe(5);
      expect(stdout).toBe('');
    });

    it('describes a board whose enabled columns are those of examples/minimal', () => {
      const config = readFileSync(
        fileURLToPath(new URL('../../../examples/minimal/config.yaml', import.meta.url)),
        'utf8',
      );
      const minimal = [...config.matchAll(/^ {6}- id: (\S+)$/gm)].map((match) => match[1]);
      expect(minimal).toEqual(['todo', 'dev', 'review', 'done']);
      expect(example.why?.gates.filter((gate) => gate.enabled).map((gate) => gate.column)).toEqual(
        minimal,
      );
    });
  });
});
