import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '../packages/contracts/src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const PACKAGE_SMOKE_SCRIPT = 'scripts/package-smoke-mcp.ts';
const PACKAGE_COMMAND_TIMEOUT_MS = 120_000;

function command(args: string[], cwd: string): string {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    timeout: PACKAGE_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args[0] ?? ''} failed (exit ${String(result.status)}): ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function handshake(binary: string, expectedVersion: string): Promise<number> {
  const child = spawn(binary, ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BOARD_DAEMON_URL: '', BOARD_TOKEN: '', SPUR_SESSION: '' },
  });
  const messages: Record<string, unknown>[] = [];
  let pending = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const response = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`installed MCP handshake timed out: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.jsonrpc !== '2.0') throw new Error('non-JSON-RPC stdout frame');
          messages.push(message);
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
      reject(new Error(`installed MCP exited early (${String(code)}): ${stderr}`));
    });
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'package-smoke', version: '1.0.0' },
        },
      }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    );
    await response;
    if (messages.length !== 2 || pending !== '') throw new Error('unexpected installed MCP stdout');
    const initialized = messages[0] as { result?: { serverInfo?: { version?: unknown } } };
    if (initialized.result?.serverInfo?.version !== expectedVersion) {
      throw new Error('installed MCP server version differs from package version');
    }
    const listed = messages[1] as { result?: { tools?: unknown } };
    if (!Array.isArray(listed.result?.tools)) {
      throw new Error('installed MCP did not list tools');
    }
    const names = listed.result.tools.map((tool: { name?: unknown }) => tool.name);
    const expected = OPERATIONS.map((op) => op.mcp.name);
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`installed MCP tools differ from catalog: ${JSON.stringify(names)}`);
    }
    return names.length;
  } finally {
    child.kill();
  }
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'board-mcp-package-'));
  try {
    const store = command(['store', 'path'], root);
    command(['--filter', 'spur-board', 'pack', '--pack-destination', temp], root);
    const packed = readdirSync(temp).find((name) => name.endsWith('.tgz'));
    if (!packed) throw new Error('pnpm pack produced no tarball');
    const tarball = join(temp, packed);
    const install = join(temp, 'installed');
    mkdirSync(install);
    writeFileSync(
      join(install, 'package.json'),
      JSON.stringify({ name: 'mcp-package-smoke', private: true }),
    );
    command(
      ['add', '--prefer-offline', '--ignore-scripts', '--store-dir', store, tarball],
      install,
    );
    const manifest = JSON.parse(
      readFileSync(join(install, 'node_modules/spur-board/package.json'), 'utf8'),
    ) as {
      version: string;
      bin?: { board?: string };
      dependencies?: Record<string, string>;
    };
    if (manifest.bin?.board !== './dist/bin.mjs')
      throw new Error('packed bin does not point to dist');
    if (
      Object.values(manifest.dependencies ?? {}).some((version) => version.startsWith('workspace:'))
    ) {
      throw new Error('packed runtime dependency still uses workspace protocol');
    }
    const count = await handshake(join(install, 'node_modules/.bin/board'), manifest.version);
    process.stdout.write(`package smoke: installed board mcp listed ${String(count)} tools\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
