import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packPackage } from './package.ts';
import { handshake } from './package-smoke-mcp.ts';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function command(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.once('close', (code) => {
      clearTimers();
      if (timedOut) reject(new Error(`Packed command timed out: ${binary} ${args.join(' ')}`));
      else resolve({ code, stdout, stderr });
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
  home: string;
  packageRoot: string;
  daemon?: ChildProcess;
  port?: number;
}

interface SmokeStep {
  name: string;
  baseline?: true;
  run(ctx: SmokeContext): Promise<void>;
}

export const smokeSteps: readonly SmokeStep[] = [
  {
    name: 'version',
    baseline: true,
    async run(ctx) {
      verifyVersion(await command(ctx.binary, ['--version'], ctx.env), ctx.expectedVersion);
    },
  },
  {
    name: 'daemon',
    baseline: true,
    async run(ctx) {
      const started = await startDaemon(ctx.binary, ctx.env);
      ctx.daemon = started.child;
      ctx.port = started.port;
    },
  },
  {
    name: 'schema',
    baseline: true,
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
  {
    name: 'mcp',
    baseline: true,
    async run(ctx) {
      await handshake(ctx.binary, ctx.expectedVersion);
    },
  },
  {
    name: 'service unit',
    async run(ctx) {
      const fakeBin = join(ctx.home, 'fake-bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(ctx.home, 'secrets.env'), 'BOARD_TOKEN=smoke\n', { mode: 0o600 });
      const result = await command(ctx.binary, ['service', 'install'], {
        ...ctx.env,
        PATH: `${fakeBin}:${ctx.env['PATH'] ?? ''}`,
      });
      if (result.code !== 0) throw new Error(`Packed service install failed: ${result.stderr}`);
      const daemonEntry = join(ctx.packageRoot, 'dist/daemon.mjs');
      if (!existsSync(daemonEntry)) throw new Error('Packed daemon entry is missing.');
      const unit = readFileSync(join(ctx.home, '.config/systemd/user/spur-board.service'), 'utf8');
      if (!unit.includes(`ExecStart="${process.execPath}" "${daemonEntry}"\n`)) {
        throw new Error('Packed service unit does not start the installed daemon entry.');
      }
    },
  },
  {
    name: 'skills install',
    async run(ctx) {
      const skills = [
        { source: 'spur-board', installed: 'spur-board' },
        { source: 'setup', installed: 'spur-board-setup' },
      ];
      const present = skills.map(({ source }) =>
        existsSync(join(ctx.packageRoot, 'skills', source, 'SKILL.md')),
      );
      if (present.every((value) => !value)) {
        // Product skills have separate issues; exercise the packed installer with temporary assets.
        for (const { source } of skills) {
          const directory = join(ctx.packageRoot, 'skills', source);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'SKILL.md'), '# Packed smoke fixture\n');
        }
      } else if (present.some((value) => !value)) {
        throw new Error('Packed product skills are incomplete.');
      }
      const result = await command(ctx.binary, ['skills', 'install'], ctx.env);
      if (result.code !== 0) throw new Error(`Packed skills install failed: ${result.stderr}`);
      const installed: unknown = JSON.parse(result.stdout) as unknown;
      if (
        !Array.isArray(installed) ||
        installed.length !== 4 ||
        !installed.every(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === 'object' &&
            'changed' in entry &&
            entry.changed === true,
        )
      ) {
        throw new Error('Packed skills install did not report four new skills.');
      }
      for (const agent of ['.claude', '.codex']) {
        for (const { source, installed: name } of skills) {
          const destination = join(ctx.home, agent, 'skills', name);
          if (
            readFileSync(join(destination, 'SKILL.md'), 'utf8') !==
            readFileSync(join(ctx.packageRoot, 'skills', source, 'SKILL.md'), 'utf8')
          ) {
            throw new Error(`Packed skill ${name} differs after installation.`);
          }
          const stamp = JSON.parse(
            readFileSync(join(destination, '.spur-board-install.json'), 'utf8'),
          ) as { version?: string };
          if (stamp.version !== ctx.expectedVersion) {
            throw new Error(`Packed skill ${name} has the wrong version stamp.`);
          }
        }
      }
    },
  },
];

export async function runSmokeSteps(
  ctx: SmokeContext,
  steps: readonly SmokeStep[] = smokeSteps,
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
  baselineOnly = false,
): Promise<void> {
  mkdirSync(home, { recursive: true });
  const fake = await fakeSessionApi();
  const ctx: SmokeContext = {
    binary,
    expectedVersion,
    home,
    packageRoot: dirname(dirname(realpathSync(binary))),
    env: {
      ...process.env,
      HOME: home,
      BOARD_HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      SPUR_SESSION: 'smoke-1',
    },
  };
  writeFileSync(join(home, 'config.yaml'), config(fake.port));
  try {
    await runSmokeSteps(
      ctx,
      baselineOnly ? smokeSteps.filter((step) => step.baseline) : smokeSteps,
    );
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
