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

// The names the testkit harness scrubs, plus the CI runner's tokens and npm's own config.
const SCRUB_PREFIXES = [
  'ACTIONS_',
  'GITHUB_',
  'NPM_CONFIG_',
  'SPUR_',
  'BOARD_',
  'SLACK_',
  'JIRA_',
  'GBRAIN_',
  'ANTHROPIC_',
  'OPENAI_',
];
const SCRUB_SUFFIXES = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'];

/** `base` without credential-shaped names, so installed packages cannot read runner tokens. */
export function credentialFreeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (
      SCRUB_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
      SCRUB_SUFFIXES.some((suffix) => upper.endsWith(suffix))
    ) {
      continue;
    }
    env[name] = value;
  }
  return env;
}

export function installPackage(packageRef: string, prefix: string): string {
  mkdirSync(prefix, { recursive: true });
  const result = spawnSync(
    'npm',
    ['install', '--prefix', prefix, packageRef, '--no-audit', '--no-fund'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: credentialFreeEnv(process.env),
    },
  );
  if (result.status !== 0)
    throw new Error(`Tarball install failed: ${result.stderr || result.stdout}`);
  return join(prefix, 'node_modules/.bin/board');
}

/** The version of `spur-board` installed under `prefix`. */
export function installedVersion(prefix: string): string {
  const manifest = JSON.parse(
    readFileSync(join(prefix, 'node_modules/spur-board/package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
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
        role: operator
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

/** Verify every command page linked by the packed product skill. */
export function productSkillReferences(packageRoot: string): string[] {
  const product = join(packageRoot, 'skills/spur-board/SKILL.md');
  if (!existsSync(product)) throw new Error('Packed product skill spur-board is missing.');
  const source = readFileSync(product, 'utf8');
  const references = [
    ...new Set(
      [...source.matchAll(/\]\((references\/[a-z0-9-]+\.md)#board-[a-z0-9-]+\)/g)].map(
        (match) => match[1] ?? '',
      ),
    ),
  ];
  if (references.length === 0) throw new Error('Packed product skill has no command references.');
  for (const reference of references) {
    if (!existsSync(join(packageRoot, 'skills/spur-board', reference))) {
      throw new Error(`Packed product skill is missing ${reference}.`);
    }
  }
  return references;
}

/** Verify both skills exist in the packed package before installation. */
export function prepareSkillsForSmoke(packageRoot: string): void {
  productSkillReferences(packageRoot);
  const setup = join(packageRoot, 'skills/setup/SKILL.md');
  if (!existsSync(setup)) throw new Error('Packed setup skill spur-board-setup is missing.');
  const source = readFileSync(setup, 'utf8');
  const references = new Set(
    [...source.matchAll(/\]\((references\/[a-z0-9-]+\.md)\)/g)].map((match) => match[1]),
  );
  for (const reference of references) {
    if (reference !== undefined && !existsSync(join(packageRoot, 'skills/setup', reference))) {
      throw new Error(`Packed setup skill is missing ${reference}.`);
    }
  }
}

interface SmokeContext {
  binary: string;
  expectedVersion: string;
  env: NodeJS.ProcessEnv;
  home: string;
  packageRoot: string;
  /** The previous release in an upgrade smoke: skip checks bound to the current catalog. */
  baselineOnly?: boolean;
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
    name: 'status',
    async run(ctx) {
      if (ctx.port === undefined) throw new Error('Packed daemon has no HTTP port.');
      const env = {
        ...ctx.env,
        BOARD_DAEMON_URL: `http://127.0.0.1:${String(ctx.port)}`,
      };
      const added = await command(
        ctx.binary,
        ['task', 'add', 'example-org/board#64', '--key', 'smoke-task-64', '--json'],
        env,
      );
      if (added.code !== 0) throw new Error(`Packed task add failed: ${added.stderr}`);
      const result = await command(ctx.binary, ['status', '--json'], env);
      if (result.code !== 0) throw new Error(`Packed board status failed: ${result.stderr}`);
      const value: unknown = JSON.parse(result.stdout) as unknown;
      if (
        value === null ||
        typeof value !== 'object' ||
        !('tasks' in value) ||
        !Array.isArray(value.tasks) ||
        !value.tasks.some(
          (task: unknown) =>
            task !== null &&
            typeof task === 'object' &&
            'key' in task &&
            task.key === 'example-org/board#64' &&
            'project' in task &&
            task.project === 'board' &&
            'membership' in task &&
            task.membership === 'active',
        ) ||
        !('sources' in value) ||
        !Array.isArray(value.sources) ||
        value.sources.length === 0
      ) {
        throw new Error('Packed board status did not include the created task and sources.');
      }
      for (const output of [added.stderr, result.stderr]) {
        if (output.split('\n').some((line) => line.startsWith('warning:'))) {
          throw new Error(`Packed CLI warned about the packed daemon: ${output}`);
        }
      }
      if (!existsSync(join(ctx.home, 'version-check.json'))) {
        throw new Error('Packed CLI did not record its catalog check in version-check.json.');
      }
    },
  },
  {
    name: 'mcp',
    baseline: true,
    async run(ctx) {
      await handshake(
        ctx.binary,
        ctx.expectedVersion,
        ctx.baselineOnly !== true,
        credentialFreeEnv(process.env),
      );
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
      prepareSkillsForSmoke(ctx.packageRoot);
      const references = productSkillReferences(ctx.packageRoot);
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
          if (source === 'spur-board') {
            for (const reference of references) {
              if (
                readFileSync(join(destination, reference), 'utf8') !==
                readFileSync(join(ctx.packageRoot, 'skills', source, reference), 'utf8')
              ) {
                throw new Error(`Packed skill reference ${reference} differs after installation.`);
              }
            }
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
  let ctx: SmokeContext | undefined;
  try {
    ctx = {
      binary,
      expectedVersion,
      home,
      packageRoot: dirname(dirname(realpathSync(binary))),
      baselineOnly,
      env: {
        ...credentialFreeEnv(process.env),
        HOME: home,
        BOARD_HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        XDG_STATE_HOME: join(home, '.local/state'),
        CODEX_HOME: '',
        SPUR_SESSION: 'smoke-1',
      },
    };
    writeFileSync(join(home, 'config.yaml'), config(fake.port));
    await runSmokeSteps(
      ctx,
      baselineOnly ? smokeSteps.filter((step) => step.baseline) : smokeSteps,
    );
  } finally {
    if (ctx?.daemon !== undefined) await stopDaemon(ctx.daemon);
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
    await smokeInstalled(binary, join(temporary, 'home'), installedVersion(prefix));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokePackage(process.argv[2]);
