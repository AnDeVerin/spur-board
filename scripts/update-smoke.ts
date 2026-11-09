// The update stand: `board update` and `board rollback` against a real global npm install, a
// loopback registry and a stateful fake `systemctl` (scripts/update-smoke-systemctl.ts).
//   node scripts/update-smoke.ts [tarball]
// Everything it writes, npm's cache included, stays under one temp root; it refuses to start
// unless `systemctl` on its PATH is the fake, and it stops only the daemon the fake started.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { packPackage } from './package.ts';
import { command } from './package-smoke.ts';

const NAME = 'spur-board';
const SERVICE = 'spur-board.service';
const fakeSystemctl = fileURLToPath(new URL('./update-smoke-systemctl.ts', import.meta.url));

// The names the testkit harness scrubs, plus npm's own config, XDG dirs and agent homes.
const SCRUB_PREFIXES = [
  'SPUR_',
  'BOARD_',
  'SLACK_',
  'JIRA_',
  'GBRAIN_',
  'ANTHROPIC_',
  'OPENAI_',
  'XDG_',
  'NPM_CONFIG_',
];
const SCRUB_EXACT = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'DBUS_SESSION_BUS_ADDRESS',
  'NOTIFY_SOCKET',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]);
const SCRUB_SUFFIXES = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'];

/** The stand's environment: every home, cache and config dir under `root`, the fake first. */
export function standEnv(
  root: string,
  base: NodeJS.ProcessEnv,
  registry: string,
  nodeDir: string = dirname(process.execPath),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (
      SCRUB_EXACT.has(upper) ||
      SCRUB_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
      SCRUB_SUFFIXES.some((suffix) => upper.endsWith(suffix))
    ) {
      continue;
    }
    env[name] = value;
  }
  const home = join(root, 'home');
  return {
    ...env,
    HOME: home,
    BOARD_HOME: join(home, 'board'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_registry: registry,
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(root, 'npmrc'),
    npm_config_update_notifier: 'false',
    PATH: [join(root, 'fake-bin'), join(home, '.local/bin'), nodeDir, base['PATH'] ?? ''].join(':'),
  };
}

/** A migration file name `migrate.ts` accepts: a 4-digit, zero-padded sequence number. */
export function migrationName(sequence: number, slug: string): string {
  return `${String(sequence).padStart(4, '0')}_${slug}.sql`;
}

/** The package.json text with only `version` replaced. */
export function patchManifest(text: string, version: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
}

export function integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export interface PublishedVersion {
  manifest: Record<string, unknown>;
  integrity: string;
}

const MANIFEST_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'engines',
  'bin',
  'os',
  'cpu',
];

/** The registry document for the versions published so far; the last one is `latest`. */
export function buildPackument(
  registry: string,
  published: readonly PublishedVersion[],
): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  for (const { manifest, integrity: hash } of published) {
    const version = manifest['version'];
    if (typeof version !== 'string') throw new Error('A published manifest has no version.');
    versions[version] = {
      name: NAME,
      version,
      ...Object.fromEntries(
        MANIFEST_FIELDS.filter((field) => field in manifest).map((field) => [
          field,
          manifest[field],
        ]),
      ),
      dist: { tarball: `${registry}/${NAME}/-/${NAME}-${version}.tgz`, integrity: hash },
    };
  }
  const latest = published.at(-1)?.manifest['version'];
  return {
    name: NAME,
    'dist-tags': typeof latest === 'string' ? { latest } : {},
    versions,
  };
}

/** The unit's `ExecStart=` line. */
export function execStartLine(unit: string): string | undefined {
  return unit.split('\n').find((line) => line.startsWith('ExecStart='));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`update smoke: ${message}`);
}

function run(binary: string, args: string[], cwd?: string): void {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

const NPM_ORIGIN = 'https://registry.npmjs.org';

/**
 * The npmjs URL for a request path, or undefined unless the path starts with exactly one `/` and
 * the resolved URL keeps the npm origin: any other request-target (`@host/x`, `//host/x`,
 * `/\\host/x`, an absolute URL) could move the host.
 */
export function upstreamUrl(path: string): URL | undefined {
  if (!path.startsWith('/') || path.startsWith('//')) return undefined;
  let target: URL;
  try {
    target = new URL(path.slice(1), `${NPM_ORIGIN}/`);
  } catch {
    return undefined;
  }
  return target.origin === NPM_ORIGIN ? target : undefined;
}

async function upstream(url: URL, accept: string | undefined): Promise<Response> {
  const attempt = () => fetch(url, { headers: accept === undefined ? {} : { accept } });
  try {
    const response = await attempt();
    if (response.status < 500) return response;
  } catch {
    // Retried once below.
  }
  return attempt();
}

interface Registry {
  url: string;
  server: Server;
  publish(version: string, tarball: string): void;
}

/** Serves `spur-board` from local tarballs and forwards every other path to npmjs. */
async function startRegistry(): Promise<Registry> {
  const published: PublishedVersion[] = [];
  const tarballs = new Map<string, Buffer>();
  let url = '';
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (request.method === 'GET' && path.split('?')[0] === `/${NAME}`) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(buildPackument(url, published)));
      return;
    }
    const tarball = tarballs.get(path);
    if (request.method === 'GET' && tarball !== undefined) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
      return;
    }
    if (path.startsWith(`/${NAME}/`) || request.method !== 'GET') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"Not found"}');
      return;
    }
    const target = upstreamUrl(path);
    if (target === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"Bad request path"}');
      return;
    }
    upstream(target, request.headers.accept).then(
      (answer) => {
        response.writeHead(answer.status, {
          'content-type': answer.headers.get('content-type') ?? 'application/octet-stream',
        });
        if (answer.body === null) response.end();
        else Readable.from(answer.body as AsyncIterable<Uint8Array>).pipe(response);
      },
      (error: unknown) => {
        response.writeHead(502).end(String(error));
      },
    );
  });
  const port = await listen(server);
  url = `http://127.0.0.1:${String(port)}`;
  return {
    url,
    server,
    publish(version, file) {
      const bytes = readFileSync(file);
      const extracted = mkdtempSync(join(dirname(file), 'manifest-'));
      run('tar', ['-xzf', file, '-C', extracted, 'package/package.json']);
      const manifest = JSON.parse(
        readFileSync(join(extracted, 'package/package.json'), 'utf8'),
      ) as Record<string, unknown>;
      rmSync(extracted, { recursive: true, force: true });
      check(manifest['version'] === version, `tarball ${file} is not version ${version}`);
      published.push({ manifest, integrity: integrity(bytes) });
      tarballs.set(`/${NAME}/-/${NAME}-${version}.tgz`, bytes);
    },
  };
}

/** The fake Spur API: an empty session list, session smoke-1, and the doctor send probe. */
async function startSpur(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && (request.url === '/sessions' || request.url === '/projects')) {
      json(200, []);
    } else if (request.method === 'GET' && request.url === '/sessions/smoke-1') {
      json(200, { id: 'smoke-1', project: 'smoke', status: 'running', state: 'working' });
    } else if (
      request.method === 'POST' &&
      request.url === '/sessions/spur-board-doctor-probe/send'
    ) {
      request.resume();
      json(404, { error: 'Session not found: spur-board-doctor-probe' });
    } else {
      json(404, { error: 'Not found' });
    }
  });
  return { server, port: await listen(server) };
}

function config(spurPort: number, httpPort: number): string {
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
    baseUrl: http://127.0.0.1:${String(spurPort)}
http:
  port: ${String(httpPort)}
`;
}

/** Builds V1, V2 (one more migration) and V3 (two more, and a daemon that cannot listen). */
function buildVariants(tarball: string, root: string): { files: Map<string, string>; n: number } {
  const work = join(root, 'pack');
  const base = join(work, 'base');
  mkdirSync(base, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', base]);
  const migrations = join(base, 'package/dist/migrations');
  const n = readdirSync(migrations).filter((name) => name.endsWith('.sql')).length;
  check(n > 0, 'the tarball has no migrations');
  const files = new Map<string, string>();
  const variants: { version: string; extra: [number, string][]; broken: boolean }[] = [
    { version: '1.0.0', extra: [], broken: false },
    { version: '1.1.0', extra: [[n + 1, 'update_smoke']], broken: false },
    {
      version: '1.2.0',
      extra: [
        [n + 1, 'update_smoke'],
        [n + 2, 'update_smoke_two'],
      ],
      broken: true,
    },
  ];
  for (const variant of variants) {
    const dir = join(work, variant.version);
    cpSync(base, dir, { recursive: true, verbatimSymlinks: true });
    const manifest = join(dir, 'package/package.json');
    writeFileSync(manifest, patchManifest(readFileSync(manifest, 'utf8'), variant.version));
    for (const [sequence, slug] of variant.extra) {
      writeFileSync(
        join(dir, 'package/dist/migrations', migrationName(sequence, slug)),
        `CREATE TABLE ${slug} (id INTEGER PRIMARY KEY);\n`,
      );
    }
    if (variant.broken) {
      const dist = join(dir, 'package/dist');
      renameSync(join(dist, 'daemon.mjs'), join(dist, 'daemon-real.mjs'));
      writeFileSync(
        join(dist, 'daemon.mjs'),
        `import net from 'node:net';
export * from './daemon-real.mjs';
if (import.meta.main) {
  net.Server.prototype.listen = function listen() {
    throw new Error('update smoke: V3 refuses to listen');
  };
  await (await import('./daemon-real.mjs')).main();
}
`,
      );
    }
    const file = join(root, 'registry', `${NAME}-${variant.version}.tgz`);
    mkdirSync(dirname(file), { recursive: true });
    run('tar', ['-czf', file, '-C', dir, 'package']);
    files.set(variant.version, file);
  }
  return { files, n };
}

interface HttpAnswer {
  status: number;
  instance: string | undefined;
  body: string;
}

function httpGet(port: number, path: string): Promise<HttpAnswer | undefined> {
  return new Promise((resolve) => {
    const request = get(
      { host: '127.0.0.1', port, path, agent: false, timeout: 5_000 },
      (response: IncomingMessage) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          const instance = response.headers['x-board-instance'];
          resolve({
            status: response.statusCode ?? 0,
            instance: typeof instance === 'string' ? instance : undefined,
            body,
          });
        });
      },
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => {
      resolve(undefined);
    });
  });
}

interface Stand {
  root: string;
  env: NodeJS.ProcessEnv;
  board: string;
  boardHome: string;
  port: number;
  systemd: string;
  unitFile: string;
}

type Result = Awaited<ReturnType<typeof command>>;

function boardRun(
  stand: Stand,
  args: string[],
  timeoutMs = 120_000,
  extra: NodeJS.ProcessEnv = {},
): Promise<Result> {
  return command(stand.board, args, { ...stand.env, ...extra }, timeoutMs);
}

function expectExit(result: Result, code: number, label: string): void {
  check(
    result.code === code,
    `${label} exited ${String(result.code)}, expected ${String(code)}:\n${result.stderr}\n${result.stdout}`,
  );
}

function parse(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`update smoke: ${label} did not print JSON: ${text}`);
  }
}

async function version(stand: Stand): Promise<string> {
  const result = await boardRun(stand, ['--version'], 15_000);
  expectExit(result, 0, 'board --version');
  return result.stdout.trim();
}

async function ready(stand: Stand): Promise<string> {
  const answer = await httpGet(stand.port, '/v1/schema');
  check(answer?.status === 200, `the daemon is not ready (${String(answer?.status)})`);
  check(answer.instance !== undefined, 'the daemon sent no x-board-instance');
  return answer.instance;
}

async function doctorBlocking(stand: Stand): Promise<{ blocking: Set<string>; pass: Set<string> }> {
  const result = await boardRun(stand, ['--json', 'doctor']);
  check(result.code === 0 || result.code === 1, `board doctor exited ${String(result.code)}`);
  const checks = parse(result.stdout, 'board doctor') as {
    id: string;
    status: string;
    blocking: boolean;
  }[];
  return {
    blocking: new Set(checks.filter((entry) => entry.blocking).map((entry) => entry.id)),
    pass: new Set(checks.filter((entry) => entry.status === 'pass').map((entry) => entry.id)),
  };
}

async function taskKeys(stand: Stand): Promise<string[]> {
  const result = await boardRun(stand, ['--json', 'status'], 60_000, SESSION);
  expectExit(result, 0, 'board status');
  const value = parse(result.stdout, 'board status') as { tasks?: { key: string }[] };
  check(Array.isArray(value.tasks), 'board status has no tasks list');
  return value.tasks.map((task) => task.key);
}

async function addTask(stand: Stand, number: number): Promise<void> {
  const result = await boardRun(
    stand,
    [
      '--json',
      'task',
      'add',
      `example-org/board#${String(number)}`,
      '--key',
      `smoke-${String(number)}`,
    ],
    60_000,
    SESSION,
  );
  expectExit(result, 0, `task add #${String(number)}`);
}

function stamps(stand: Stand): string[] {
  const home = stand.env['HOME'] ?? '';
  return ['.claude', '.codex'].flatMap((agent) =>
    ['spur-board', 'spur-board-setup'].map((skill) => {
      const stamp = JSON.parse(
        readFileSync(join(home, agent, 'skills', skill, '.spur-board-install.json'), 'utf8'),
      ) as { version?: string };
      return stamp.version ?? '';
    }),
  );
}

function updateState(stand: Stand): { status: string; dbBackup: string | null } {
  return JSON.parse(readFileSync(join(stand.boardHome, 'update/state.json'), 'utf8')) as {
    status: string;
    dbBackup: string | null;
  };
}

function partials(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.partial'),
  );
}

function errorOf(stderr: string): { code?: string; hint?: string } {
  const line = stderr
    .split('\n')
    .reverse()
    .find((text) => text.startsWith('{'));
  check(line !== undefined, `no JSON error on stderr: ${stderr}`);
  return (parse(line, 'the error') as { error: { code?: string; hint?: string } }).error;
}

function migrationBackups(stand: Stand, n: number): number {
  return readdirSync(stand.boardHome).filter(
    (name) => name.startsWith(`board.sqlite.v${String(n)}.`) && name.endsWith('.bak'),
  ).length;
}

// Only the calls that need a caller identity run as a Spur session.
const SESSION = { SPUR_SESSION: 'smoke-1' };

const log = (text: string) => process.stdout.write(`update smoke: ${text}\n`);

async function scenarioA(stand: Stand, registry: Registry, files: Map<string, string>) {
  registry.publish('1.0.0', files.get('1.0.0') ?? '');
  registry.publish('1.1.0', files.get('1.1.0') ?? '');
  const prefix = join(stand.root, 'home/.local');
  const install = await command(
    'npm',
    ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `${NAME}@1.0.0`],
    stand.env,
    600_000,
  );
  expectExit(install, 0, 'npm install -g spur-board@1.0.0');
  check((await version(stand)) === '1.0.0', 'the installed version is not 1.0.0');
  expectExit(await boardRun(stand, ['--json', 'service', 'install']), 0, 'service install');
  await ready(stand);
  expectExit(await boardRun(stand, ['--json', 'skills', 'install']), 0, 'skills install');
  await addTask(stand, 64);
  const before = await doctorBlocking(stand);
  const unitBefore = execStartLine(readFileSync(stand.unitFile, 'utf8'));
  const instanceBefore = await ready(stand);
  log(`V1 installed, blocking before: ${[...before.blocking].join(', ') || 'none'}`);

  const update = await boardRun(stand, ['--json', 'update'], 900_000);
  expectExit(update, 0, 'board update to 1.1.0');
  const result = parse(update.stdout, 'board update') as {
    to?: string;
    firstPoll?: string;
    operator?: string[];
    database?: { schemaChanged?: boolean };
  };
  check(result.to === '1.1.0', `update went to ${String(result.to)}`);
  check(result.database?.schemaChanged === true, 'update did not report the schema change');
  check(
    result.operator?.some((line) => line.includes('board mcp')) === true,
    'update printed no `board mcp` operator line',
  );
  check((await version(stand)) === '1.1.0', 'board --version is not 1.1.0 after the update');
  check(
    execStartLine(readFileSync(stand.unitFile, 'utf8')) === unitBefore,
    'the unit ExecStart changed',
  );
  check(existsSync(join(stand.boardHome, 'update/db/board.sqlite')), 'no database backup');
  check(partials(stand.boardHome).length === 0, 'a .partial file was left');
  check((await ready(stand)) !== instanceBefore, 'the daemon instance did not change');
  const health = await httpGet(stand.port, '/v1/health');
  check(
    health?.status === 200 &&
      (parse(health.body, '/v1/health') as { firstPollDone?: unknown }).firstPollDone === true,
    `/v1/health is not firstPollDone: ${String(health?.status)} ${health?.body ?? ''}`,
  );
  const after = await doctorBlocking(stand);
  const newly = [...after.blocking].filter((id) => !before.blocking.has(id));
  check(newly.length === 0, `doctor checks newly blocking: ${newly.join(', ')}`);
  for (const id of ['daemon.available', 'service.running']) {
    check(after.pass.has(id), `doctor ${id} does not pass`);
  }
  check((await taskKeys(stand)).includes('example-org/board#64'), 'task #64 is gone');
  check(
    stamps(stand).every((stamp) => stamp === '1.1.0'),
    'skill stamps are not 1.1.0',
  );
  check(updateState(stand).status === 'succeeded', 'state is not succeeded');
  log('scenario A (update 1.0.0 -> 1.1.0 with a migration) ok');
}

async function scenarioB(stand: Stand) {
  await addTask(stand, 65);
  const refused = await boardRun(stand, ['--json', 'rollback']);
  expectExit(refused, 2, 'board rollback without --yes');
  check((await version(stand)) === '1.1.0', 'rollback without --yes changed the version');
  const rollback = await boardRun(stand, ['--json', 'rollback', '--yes'], 600_000);
  expectExit(rollback, 0, 'board rollback --yes');
  const result = parse(rollback.stdout, 'board rollback') as { database?: string; to?: string };
  check(result.database === 'restored', `rollback database is ${String(result.database)}`);
  check(result.to === '1.0.0', `rollback went to ${String(result.to)}`);
  check((await version(stand)) === '1.0.0', 'board --version is not 1.0.0 after the rollback');
  await ready(stand);
  const keys = await taskKeys(stand);
  check(keys.includes('example-org/board#64'), 'task #64 is gone after the rollback');
  check(!keys.includes('example-org/board#65'), 'task #65 survived the database restore');
  check(
    stamps(stand).every((stamp) => stamp === '1.0.0'),
    'skill stamps are not 1.0.0',
  );
  log('scenario B (rollback --yes restores 1.0.0 and its database) ok');
}

async function scenarioC(stand: Stand, registry: Registry, files: Map<string, string>, n: number) {
  registry.publish('1.2.0', files.get('1.2.0') ?? '');
  const backups = migrationBackups(stand, n);
  const update = await boardRun(stand, ['--json', 'update'], 900_000);
  expectExit(update, 4, 'board update to the broken 1.2.0');
  const error = errorOf(update.stderr);
  check(error.code === 'update_rolled_back', `update failed with ${String(error.code)}`);
  check(error.hint?.includes('service install') === true, `hint: ${String(error.hint)}`);
  const daemonLog = readFileSync(join(stand.systemd, 'daemon.log'), 'utf8');
  check(daemonLog.includes('V3 refuses to listen'), 'V3 did not fail at listen');
  check(migrationBackups(stand, n) === backups + 1, 'V3 did not migrate the database');
  check((await version(stand)) === '1.0.0', 'board --version is not 1.0.0 after the rollback');
  await ready(stand);
  check((await taskKeys(stand)).includes('example-org/board#64'), 'task #64 is gone');
  check(updateState(stand).status === 'rolled-back', 'state is not rolled-back');
  log('scenario C (broken 1.2.0 migrates, fails to start and rolls back) ok');
}

function writeFakeSystemctl(stand: Stand): void {
  const bin = join(stand.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stand.systemd, { recursive: true });
  writeFileSync(
    join(bin, 'systemctl'),
    [
      '#!/bin/sh',
      `UPDATE_SMOKE_SYSTEMD=${shellQuote(stand.systemd)}`,
      `UPDATE_SMOKE_UNIT=${shellQuote(stand.unitFile)}`,
      `UPDATE_SMOKE_PORT=${String(stand.port)}`,
      'export UPDATE_SMOKE_SYSTEMD UPDATE_SMOKE_UNIT UPDATE_SMOKE_PORT',
      `exec ${shellQuote(process.execPath)} ${shellQuote(fakeSystemctl)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function requireFake(stand: Stand): void {
  const found = spawnSync('sh', ['-c', 'command -v systemctl'], {
    env: stand.env,
    encoding: 'utf8',
  });
  const expected = join(stand.root, 'fake-bin', 'systemctl');
  if (found.stdout.trim() !== expected) {
    throw new Error(
      `update smoke: systemctl resolves to ${found.stdout.trim() || 'nothing'}, not ${expected}; refusing to start.`,
    );
  }
}

function dumpLogs(stand: Stand): void {
  for (const name of ['calls.log', 'daemon.log']) {
    const file = join(stand.systemd, name);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-60);
    process.stderr.write(`--- ${name} (last ${String(lines.length)} lines)\n${lines.join('\n')}\n`);
  }
}

export async function smokeUpdate(tarball?: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spur-board-update-smoke-')));
  const registry = await startRegistry();
  const spur = await startSpur();
  const env = standEnv(root, process.env, registry.url);
  const home = env['HOME'] ?? '';
  const stand: Stand = {
    root,
    env,
    board: join(home, '.local/bin/board'),
    boardHome: env['BOARD_HOME'] ?? '',
    port: await freePort(),
    systemd: join(root, 'systemd'),
    unitFile: join(env['XDG_CONFIG_HOME'] ?? '', 'systemd/user', SERVICE),
  };
  try {
    for (const dir of ['runtime', 'tmp', 'npm-cache', 'home/board']) {
      mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    }
    writeFakeSystemctl(stand);
    requireFake(stand);
    writeFileSync(join(stand.boardHome, 'config.yaml'), config(spur.port, stand.port));
    writeFileSync(join(stand.boardHome, 'secrets.env'), 'BOARD_TOKEN=smoke\n', { mode: 0o600 });
    const packed = tarball ?? packPackage(join(root, 'packed'));
    const { files, n } = buildVariants(packed, root);
    log(`built 1.0.0, 1.1.0 and 1.2.0 from ${packed} (${String(n)} migrations)`);
    await scenarioA(stand, registry, files);
    await scenarioB(stand);
    await scenarioC(stand, registry, files, n);
  } catch (error) {
    dumpLogs(stand);
    throw error;
  } finally {
    if (existsSync(join(root, 'fake-bin', 'systemctl'))) {
      const stop = spawnSync(join(root, 'fake-bin', 'systemctl'), ['--user', 'stop', SERVICE], {
        env: stand.env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (stop.status !== 0)
        process.stderr.write(`update smoke: stopping the daemon failed: ${stop.stderr}\n`);
    }
    await close(registry.server);
    await close(spur.server);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokeUpdate(process.argv[2]);
