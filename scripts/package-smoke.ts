import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPackage } from './package.ts';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function command(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export function installPackage(packageRef: string, prefix: string): string {
  mkdirSync(prefix, { recursive: true });
  const result = spawnSync(
    'npm',
    ['install', '--prefix', prefix, packageRef, '--no-audit', '--no-fund'],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0)
    throw new Error(`Tarball install failed: ${result.stderr || result.stdout}`);
  return join(prefix, 'node_modules/.bin/board');
}

async function fakeSessionApi(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/sessions/smoke-1') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'smoke-1', project: 'smoke', status: 'running' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('Fake session API did not bind.');
  return { server, port: address.port };
}

function config(port: number): string {
  return `projects:
  - id: board
    tracker:
      type: github-issues
      repo: example-org/board
      label: board
    repos: [example-org/board]
    operatorGithubLogin: octocat
    spurProjects:
      - name: smoke
        role: worker
operator:
  slack: U0000000000
digest:
  tz: UTC
adapters:
  spur:
    baseUrl: http://127.0.0.1:${String(port)}
http:
  port: 0
`;
}

function startDaemon(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      fail('Timed out waiting for packed daemon HTTP listener.');
    }, 15_000);
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(new Error(`${message} ${stderr}`));
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record['msg'] === 'http listening' && typeof record['port'] === 'number') {
            settled = true;
            clearTimeout(timer);
            resolve({ child, port: record['port'] });
            return;
          }
        } catch {
          // A non-JSON line cannot announce the assigned port.
        }
        index = buffer.indexOf('\n');
      }
    });
    child.once('error', (error) => {
      fail(`Packed daemon failed to start: ${error.message}`);
    });
    child.once('exit', (code) => {
      fail(`Packed daemon exited before listening (${String(code)}).`);
    });
  });
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function verifyVersion(result: CommandResult, expected: string): void {
  if (result.code !== 0 || result.stdout.trim() !== expected || result.stderr !== '') {
    throw new Error(`Packed board --version failed: ${result.stderr || result.stdout}`);
  }
}

export function verifySchema(result: CommandResult): void {
  if (result.code !== 0) throw new Error(`Packed board schema failed: ${result.stderr}`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('Packed board schema did not print JSON.');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.version) ||
    !('operations' in value) ||
    !Array.isArray(value.operations) ||
    !value.operations.some(
      (entry: unknown) =>
        entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === 'schema.get',
    )
  ) {
    throw new Error('Packed board schema returned an invalid catalog.');
  }
}

interface SmokeContext {
  binary: string;
  expectedVersion: string;
  env: NodeJS.ProcessEnv;
  daemon?: ChildProcess;
  port?: number;
}

export const smokeSteps: readonly { name: string; run(ctx: SmokeContext): Promise<void> }[] = [
  {
    name: 'version',
    async run(ctx) {
      verifyVersion(await command(ctx.binary, ['--version'], ctx.env), ctx.expectedVersion);
    },
  },
  {
    name: 'daemon',
    async run(ctx) {
      const started = await startDaemon(ctx.binary, ctx.env);
      ctx.daemon = started.child;
      ctx.port = started.port;
    },
  },
  {
    name: 'schema',
    async run(ctx) {
      if (ctx.port === undefined) throw new Error('Packed daemon has no HTTP port.');
      verifySchema(
        await command(ctx.binary, ['schema', '--json'], {
          ...ctx.env,
          BOARD_DAEMON_URL: `http://127.0.0.1:${String(ctx.port)}`,
        }),
      );
    },
  },
];

export async function runSmokeSteps(
  ctx: SmokeContext,
  steps: readonly { name: string; run(ctx: SmokeContext): Promise<void> }[] = smokeSteps,
): Promise<void> {
  for (const step of steps) {
    await step.run(ctx);
    process.stdout.write(`package smoke: ${step.name} ok\n`);
  }
}

export async function smokeInstalled(
  binary: string,
  home: string,
  expectedVersion: string,
): Promise<void> {
  mkdirSync(home, { recursive: true });
  const fake = await fakeSessionApi();
  const ctx: SmokeContext = {
    binary,
    expectedVersion,
    env: { ...process.env, HOME: home, BOARD_HOME: home, SPUR_SESSION: 'smoke-1' },
  };
  writeFileSync(join(home, 'config.yaml'), config(fake.port));
  try {
    await runSmokeSteps(ctx);
  } finally {
    if (ctx.daemon !== undefined) await stopDaemon(ctx.daemon);
    await new Promise<void>((resolve, reject) =>
      fake.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

export async function smokePackage(tarball?: string): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'spur-board-package-smoke-'));
  try {
    const packed = tarball ?? packPackage(temporary);
    const prefix = join(temporary, 'install');
    const binary = installPackage(packed, prefix);
    const manifest = JSON.parse(
      readFileSync(join(prefix, 'node_modules/spur-board/package.json'), 'utf8'),
    ) as { version: string };
    await smokeInstalled(binary, join(temporary, 'home'), manifest.version);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokePackage(process.argv[2]);
