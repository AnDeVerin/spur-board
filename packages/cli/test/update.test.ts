import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import {
  renderUserUnit,
  servicePaths,
  type CommandResult,
  type ServicePaths,
} from '../src/service.ts';
import type { UpdatePorts, UpdateRunner } from '../src/update.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode: number, stderr: string): CommandResult => ({
  exitCode,
  stdout: '',
  stderr,
});

interface Check {
  id: string;
  status: string;
  blocking: boolean;
  fix: string | null;
}
const pass = (id: string): Check => ({ id, status: 'pass', blocking: false, fix: null });
const blocking = (id: string): Check => ({ id, status: 'fail', blocking: true, fix: `fix ${id}` });
const staleFix = 'Restart 1 session started before the last skill install: s1.';
const baseChecks: Check[] = [
  pass('daemon.available'),
  { id: 'sessions.stale', status: 'warning', blocking: false, fix: staleFix },
];
const doctorResult = (checks: Check[]): CommandResult => ({
  exitCode: checks.some((check) => check.blocking) ? 1 : 0,
  stdout: JSON.stringify(checks),
  stderr: '',
});

interface Behaviour {
  show: () => CommandResult;
  view: () => CommandResult;
  dryRun: () => CommandResult;
  install: () => CommandResult;
  doctor: (run: number) => CommandResult;
  stop: () => CommandResult;
  flock: () => CommandResult;
  copy: (args: string[]) => CommandResult;
  serviceInstall: (run: number) => CommandResult;
  skills: (run: number) => CommandResult;
}

interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link';
  mode: number;
  content: string;
}

/** Every entry under a dir: kind, permission bits, and file bytes or link target. */
function tree(root: string): Entry[] {
  const entries: Entry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const entry = { path: relative(root, path), mode: info.mode & 0o777 };
      if (info.isSymbolicLink())
        entries.push({ ...entry, kind: 'link', content: readlinkSync(path) });
      else if (info.isDirectory()) {
        entries.push({ ...entry, kind: 'dir', content: '' });
        walk(path);
      } else entries.push({ ...entry, kind: 'file', content: readFileSync(path, 'base64') });
    }
  };
  walk(root);
  return entries;
}

function label(command: string, args: readonly string[]): string {
  if (command === 'npm') {
    if (args[0] === 'view') return 'npm view';
    return args.includes('--dry-run') ? 'npm dry-run' : 'npm install';
  }
  if (command === 'systemctl') {
    if (args.includes('stop')) return 'stop';
    return args.includes('show') ? 'show' : `systemctl ${args.join(' ')}`;
  }
  if (command === 'flock') return 'flock';
  if (args[1] === 'copy-database') return 'copy-database';
  if (args.includes('doctor')) return 'doctor';
  if (args.includes('service')) return 'service install';
  if (args.includes('skills')) return 'skills install';
  return `${command} ${args.join(' ')}`;
}

/** `systemctl --user show` output for a loaded unit, in the format of systemd 249. */
function showOutput(
  paths: ServicePaths,
  environment = (paths.environment ?? []).join(' '),
): string {
  return [
    `ExecStart={ path=${paths.nodePath} ; argv[]=${paths.nodePath} ${paths.daemonEntry} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `Environment=${environment}`,
    'EnvironmentFiles=',
    '',
  ].join('\n');
}

async function stand() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-update-')));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const prefix = join(root, 'prefix');
  const packageRoot = join(prefix, 'lib', 'node_modules', 'spur-board');
  const boardHome = join(root, 'board');
  mkdirSync(home);
  mkdirSync(boardHome);
  mkdirSync(join(packageRoot, 'dist', 'migrations'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"spur-board","version":"1.0.0"}\n');
  writeFileSync(join(packageRoot, 'dist', 'bin.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(packageRoot, 'dist', 'daemon.mjs'), 'export {};\n');
  writeFileSync(join(packageRoot, 'dist', 'migrations', '0001_init.sql'), 'SELECT 1;\n');
  writeFileSync(join(packageRoot, 'dist', 'migrations', '0002_more.sql'), 'SELECT 2;\n');
  symlinkSync('bin.mjs', join(packageRoot, 'dist', 'board'));

  const daemon = {
    ready: true,
    instance: randomUUID(),
    health: 'done' as 'done' | 'pending' | 'missing',
  };
  const server = createServer((request, response) => {
    const headers = { 'content-type': 'application/json', 'x-board-instance': daemon.instance };
    if (request.url === '/v1/health' && daemon.health === 'missing') {
      response.writeHead(404, headers).end('{}');
    } else if (!daemon.ready) {
      response.writeHead(503, headers).end('{}');
    } else if (request.url === '/v1/health') {
      response
        .writeHead(200, headers)
        .end(JSON.stringify({ firstPollDone: daemon.health === 'done' }));
    } else response.writeHead(200, headers).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const port = (server.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv = {
    BOARD_HOME: boardHome,
    BOARD_DAEMON_URL: `http://127.0.0.1:${String(port)}`,
    PATH: '/usr/bin',
  };
  const unitPaths = servicePaths({
    env,
    home,
    nodePath: process.execPath,
    daemonEntry: join(packageRoot, 'dist', 'daemon.mjs'),
  });
  mkdirSync(dirname(unitPaths.unitFile), { recursive: true });
  writeFileSync(unitPaths.unitFile, renderUserUnit(unitPaths));

  const updateDir = join(boardHome, 'update');
  const stateFile = join(updateDir, 'state.json');
  const dbFile = join(boardHome, 'board.sqlite');
  const backup = join(updateDir, 'db', 'board-1.0.0.sqlite');
  const bin = join(packageRoot, 'dist', 'bin.mjs');
  const events: string[] = [];
  const calls: { label: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const counts = { doctor: 0, service: 0, skills: 0 };
  const backupDirs: { exists: boolean; directory: boolean; mode: number; state: string }[] = [];
  const clock = { t: Date.parse('2026-11-09T10:00:00.000Z') };

  const behaviour: Behaviour = {
    show: () => ok(showOutput(unitPaths)),
    view: () => ok('"1.1.0"\n'),
    dryRun: () => ok(),
    install: () => {
      writeFileSync(join(packageRoot, 'package.json'), '{"name":"spur-board","version":"1.1.0"}\n');
      return ok();
    },
    doctor: () => doctorResult(baseChecks),
    stop: () => {
      daemon.ready = false;
      return ok();
    },
    flock: () => ok(),
    copy: (args) => {
      const target = args[3] ?? '';
      if (dirname(target) === dirname(backup)) {
        const exists = existsSync(dirname(target));
        backupDirs.push({
          exists,
          directory: exists && statSync(dirname(target)).isDirectory(),
          mode: exists ? statSync(dirname(target)).mode & 0o777 : 0,
          state: existsSync(stateFile)
            ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { status: string }).status
            : 'none',
        });
      }
      if (!existsSync(dirname(target))) return fail(1, `no directory for ${target}\n`);
      writeFileSync(target, `copy of ${args[2] ?? ''}\n`);
      return ok();
    },
    serviceInstall: () => {
      daemon.instance = randomUUID();
      daemon.ready = true;
      return ok('{"unitFile":"unit","changed":false}\n');
    },
    skills: () => ok('[]\n'),
  };

  const respond = (name: string, args: readonly string[]): CommandResult => {
    switch (name) {
      case 'show':
        return behaviour.show();
      case 'npm view':
        return behaviour.view();
      case 'npm dry-run':
        return behaviour.dryRun();
      case 'npm install':
        return behaviour.install();
      case 'stop':
        return behaviour.stop();
      case 'flock':
        return behaviour.flock();
      case 'copy-database':
        return behaviour.copy([...args]);
      case 'doctor':
        return behaviour.doctor((counts.doctor += 1));
      case 'service install':
        return behaviour.serviceInstall((counts.service += 1));
      case 'skills install':
        return behaviour.skills((counts.skills += 1));
      default:
        return fail(127, `unexpected ${name}`);
    }
  };
  /** Awaited before each runner call answers, so a test can act while a run is in flight. */
  const hooks: { beforeCall?: (name: string) => Promise<void> } = {};
  const runner: UpdateRunner = async (command, args, childEnv) => {
    const name = label(command, args);
    calls.push({ label: name, args: [...args], env: childEnv });
    events.push(name);
    await hooks.beforeCall?.(name);
    return respond(name, args);
  };

  const ports: Partial<UpdatePorts> = {
    runner,
    packageRoot,
    stdinIsTTY: false,
    confirm: () => Promise.resolve(false),
    readyTimeoutMs: 5_000,
    firstPollTimeoutMs: 4_000,
    lockWaitMs: 2_000,
    doctorRecheckMs: 6_000,
    now: () => clock.t,
    sleep: async (ms) => {
      events.push(`sleep ${String(ms)}`);
      clock.t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };

  const run = async (args: string[], isTTY = false) => {
    const output = { stdout: '', stderr: '' };
    const exit = await runCli(args, {
      env,
      home,
      update: ports,
      io: {
        isTTY,
        stdout: (text) => {
          output.stdout += text;
        },
        stderr: (text) => {
          output.stderr += text;
        },
      },
    });
    return { exit, ...output };
  };

  const state = () =>
    JSON.parse(readFileSync(stateFile, 'utf8')) as {
      status: string;
      dbBackup: string | null;
      startedAt: string;
      reason: string | null;
    };

  return {
    root,
    home,
    prefix,
    packageRoot,
    env,
    unitPaths,
    updateDir,
    stateFile,
    dbFile,
    backup,
    bin,
    daemon,
    behaviour,
    calls,
    events,
    counts,
    backupDirs,
    hooks,
    ports,
    run,
    state,
    labels: () => calls.map((call) => call.label),
  };
}

type Stand = Awaited<ReturnType<typeof stand>>;

function errorOf(stderr: string): { code: string; hint: string } {
  const line = stderr
    .split('\n')
    .reverse()
    .find((text) => text.startsWith('{'));
  return (JSON.parse(line ?? '{}') as { error: { code: string; hint: string } }).error;
}

function addMigration(s: Stand) {
  writeFileSync(join(s.packageRoot, 'dist', 'migrations', '0003_new.sql'), 'SELECT 3;\n');
}

describe('board update', () => {
  it('U1: runs preflight, snapshot, stop, lock wait, backup, install and checks, in order', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
    expect(s.labels()).toEqual([
      'show',
      'npm view',
      'npm dry-run',
      'doctor',
      'stop',
      'flock',
      'copy-database',
      'npm install',
      'service install',
      'skills install',
      'doctor',
    ]);
    expect(s.calls[0]?.args).toEqual([
      '--user',
      'show',
      'spur-board.service',
      '--property=ExecStart,Environment,EnvironmentFiles',
    ]);
    expect(s.calls.find((call) => call.label === 'copy-database')?.args).toEqual([
      s.bin,
      'copy-database',
      s.dbFile,
      s.backup,
    ]);
    expect(s.backupDirs).toEqual([{ exists: true, directory: true, mode: 0o700, state: 'none' }]);
    const install = s.calls.find((call) => call.label === 'npm install');
    expect(install?.args).toEqual([
      'install',
      '-g',
      '--engine-strict',
      '--prefix',
      s.prefix,
      '--no-audit',
      '--no-fund',
      'spur-board@1.1.0',
    ]);
    expect(install?.env?.['PATH']).toBe(`${dirname(process.execPath)}:/usr/bin`);
    expect(s.calls.find((call) => call.label === 'doctor')?.args).toEqual([
      s.bin,
      '--json',
      'doctor',
    ]);
    expect(s.state()).toMatchObject({ status: 'succeeded', dbBackup: s.backup });
    expect(tree(join(s.updateDir, 'package-1.0.0'))).toEqual(original);
    expect(JSON.parse(result.stdout)).toEqual({
      from: '1.0.0',
      to: '1.1.0',
      changed: true,
      unitChanged: false,
      database: { backup: s.backup, schemaChanged: false },
      firstPoll: 'done',
      operator: [
        'Restart agent sessions that run `board mcp` so the MCP server loads the new catalog.',
        `Stop and wake these Spur sessions so they load the new skill: ${staleFix}`,
      ],
    });
    expect(result.stderr).toContain('update: stop\n');
  });

  it('U1b: accepts a doctor exit 1 with a check that blocks before and after', async () => {
    const s = await stand();
    s.behaviour.doctor = () => doctorResult([...baseChecks, blocking('github.credentials')]);
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
    expect(s.counts.doctor).toBe(2);
    expect(s.state().status).toBe('succeeded');
    expect(s.labels().filter((name) => name === 'stop')).toHaveLength(1);
  });

  it('U1c: reads a quoted Environment entry of the running service', async () => {
    const s = await stand();
    s.behaviour.show = () =>
      ok(showOutput(s.unitPaths, `"${s.unitPaths.environment?.[0] ?? ''}" "OTHER=a \\"b\\""`));
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
  });

  it('U2: prints changed false and runs only npm view when the target is installed', async () => {
    const s = await stand();
    s.behaviour.view = () => ok('"1.0.0"\n');
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ from: '1.0.0', to: '1.0.0', changed: false });
    expect(s.labels()).toEqual(['show', 'npm view']);
  });

  const refusals: [string, number, (s: Stand) => void, string?][] = [
    [
      'a non-global layout',
      4,
      (s) => {
        const other = join(s.root, 'checkout', 'cli');
        mkdirSync(other, { recursive: true });
        s.ports.packageRoot = other;
      },
      'not a global npm install',
    ],
    [
      'a missing unit',
      4,
      (s) => {
        rmSync(s.unitPaths.unitFile);
      },
      '`board service install`',
    ],
    [
      'a unit with another Node',
      4,
      (s) => {
        writeFileSync(
          s.unitPaths.unitFile,
          renderUserUnit({ ...s.unitPaths, nodePath: '/opt/other/node' }),
        );
      },
      'ExecStart="/opt/other/node"',
    ],
    [
      'a unit BOARD_HOME the shell does not have',
      4,
      (s) => {
        writeFileSync(
          s.unitPaths.unitFile,
          renderUserUnit({ ...s.unitPaths, environment: ['BOARD_HOME=/other'] }),
        );
        delete s.env['BOARD_HOME'];
      },
      'Environment="BOARD_HOME=/other"',
    ],
    [
      'a running service whose drop-in sets another BOARD_HOME',
      4,
      (s) => {
        s.behaviour.show = () =>
          ok(showOutput(s.unitPaths, `BOARD_HOME=${s.env['BOARD_HOME'] ?? ''} BOARD_HOME=/other`));
      },
      'running service has BOARD_HOME=/other but this shell gives BOARD_HOME=',
    ],
    [
      'a running service whose drop-in sets HOME',
      4,
      (s) => {
        s.behaviour.show = () =>
          ok(showOutput(s.unitPaths, `BOARD_HOME=${s.env['BOARD_HOME'] ?? ''} HOME=/elsewhere`));
      },
      'HOME=/elsewhere but this shell gives no HOME',
    ],
    [
      'a running service whose drop-in starts another Node',
      4,
      (s) => {
        s.behaviour.show = () => ok(showOutput({ ...s.unitPaths, nodePath: '/opt/other/node' }));
      },
      'ExecStart /opt/other/node',
    ],
    [
      'a running service with an EnvironmentFile',
      4,
      (s) => {
        s.behaviour.show = () =>
          ok(
            showOutput(s.unitPaths).replace(
              'EnvironmentFiles=',
              'EnvironmentFiles=/srv/board.env (ignore_errors=no)',
            ),
          );
      },
      'EnvironmentFiles=/srv/board.env',
    ],
    [
      'a failed systemctl show',
      4,
      (s) => {
        s.behaviour.show = () => fail(1, 'Failed to connect to bus\n');
      },
      'Failed to connect to bus',
    ],
    [
      'a daemon that is not ready',
      4,
      (s) => {
        s.daemon.ready = false;
      },
      'HTTP 503',
    ],
    [
      'an empty npm view',
      2,
      (s) => {
        s.behaviour.view = () => ok('');
      },
      'no published version',
    ],
    [
      'an older target',
      2,
      (s) => {
        s.behaviour.view = () => ok('"0.9.0"');
      },
      '`board rollback`',
    ],
    [
      'an EBADENGINE dry run',
      4,
      (s) => {
        s.behaviour.dryRun = () => fail(1, 'npm error code EBADENGINE\n');
      },
      'EBADENGINE',
    ],
    [
      'a pre-update doctor exit 2',
      4,
      (s) => {
        s.behaviour.doctor = () => fail(2, 'doctor crashed\n');
      },
      'doctor crashed',
    ],
  ];

  it.each(refusals)('U3: refuses %s before any change', async (_name, exit, arrange, hint) => {
    const s = await stand();
    arrange(s);
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(exit);
    expect(errorOf(result.stderr).hint).toContain(hint);
    expect(existsSync(s.stateFile)).toBe(false);
    expect(existsSync(s.updateDir) ? readdirSync(s.updateDir) : []).toEqual([]);
    expect(s.labels()).not.toContain('stop');
    expect(s.labels()).not.toContain('npm install');
  });

  it('U3: refuses while an earlier update is in progress, leaving its state', async () => {
    const s = await stand();
    mkdirSync(s.updateDir, { recursive: true });
    const earlier = {
      schema: 1,
      status: 'in-progress',
      from: '0.9.0',
      to: '1.0.0',
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: null,
      prefix: s.prefix,
      packageRoot: s.packageRoot,
      snapshot: join(s.updateDir, 'package-0.9.0'),
      dbFile: s.dbFile,
      dbBackup: null,
      reason: null,
    };
    writeFileSync(s.stateFile, JSON.stringify(earlier));
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    expect(errorOf(result.stderr).hint).toContain('`board rollback --yes`');
    expect(JSON.parse(readFileSync(s.stateFile, 'utf8'))).toEqual(earlier);
    expect(readdirSync(s.updateDir)).toEqual(['state.json']);
    expect(s.labels()).toEqual([]);
  });

  it('U3b: a failed snapshot writes no state and stops nothing', async () => {
    const s = await stand();
    writeFileSync(join(s.packageRoot, 'dist', 'unreadable.mjs'), '', { mode: 0o000 });
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    expect(errorOf(result.stderr)).toMatchObject({ code: 'config' });
    expect(errorOf(result.stderr).hint).toContain('Could not snapshot the package');
    expect(existsSync(s.stateFile)).toBe(false);
    expect(readdirSync(s.updateDir)).toEqual([]);
    expect(s.labels()).not.toContain('stop');
  });

  const triggers: [string, string, boolean, (s: Stand) => void][] = [
    [
      '(a) npm install fails',
      'npm install',
      false,
      (s) => {
        s.behaviour.install = () => fail(1, 'npm error network\n');
      },
    ],
    [
      "(a') npm install removes the package dir, then fails",
      'npm install',
      true,
      (s) => {
        s.behaviour.install = () => {
          rmSync(s.packageRoot, { recursive: true });
          return fail(1, 'npm error EACCES\n');
        };
      },
    ],
    [
      '(b) the new schema fails to start',
      'service install',
      true,
      (s) => {
        const install = s.behaviour.install;
        s.behaviour.install = () => {
          addMigration(s);
          return install();
        };
        const service = s.behaviour.serviceInstall;
        s.behaviour.serviceInstall = (run) =>
          run === 1
            ? fail(
                4,
                '{"error":{"code":"service_start_failed","hint":"Unit file is enabled; the service is failed."}}\n',
              )
            : service(run);
      },
    ],
    [
      "(b') the install removes the migrations",
      'service install',
      true,
      (s) => {
        const install = s.behaviour.install;
        s.behaviour.install = () => {
          rmSync(join(s.packageRoot, 'dist', 'migrations'), { recursive: true });
          return install();
        };
        const service = s.behaviour.serviceInstall;
        s.behaviour.serviceInstall = (run) => (run === 1 ? fail(4, 'start failed') : service(run));
      },
    ],
    [
      '(c) the instance does not change',
      'readiness',
      false,
      (s) => {
        const service = s.behaviour.serviceInstall;
        s.behaviour.serviceInstall = (run) => {
          if (run !== 1) return service(run);
          s.daemon.ready = true;
          return ok('{"changed":false}');
        };
      },
    ],
    [
      '(d) skills install fails',
      'skills install',
      false,
      (s) => {
        s.behaviour.skills = (run) => (run === 1 ? fail(4, 'skills failed') : ok('[]'));
      },
    ],
    [
      '(e) the doctor child crashes',
      'doctor',
      false,
      (s) => {
        s.behaviour.doctor = (run) => (run === 2 ? fail(2, 'crash') : doctorResult(baseChecks));
      },
    ],
    [
      '(f) a check blocks in both doctor runs',
      'newly blocking checks: x',
      false,
      (s) => {
        s.behaviour.doctor = (run) =>
          doctorResult(run === 1 ? baseChecks : [...baseChecks, blocking('x')]);
      },
    ],
  ];

  it.each(triggers)('U4: rolls back when %s', async (_name, step, restored, arrange) => {
    const s = await stand();
    const original = tree(s.packageRoot);
    arrange(s);
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('update_rolled_back');
    expect(error.hint).toContain(step);
    expect(error.hint).toContain(restored ? 'restored from the backup' : 'database was kept');
    expect(s.state().status).toBe('rolled-back');
    expect(tree(s.packageRoot)).toEqual(original);
    const labels = s.labels();
    const afterRollbackLock = labels.slice(labels.lastIndexOf('flock') + 1);
    expect(labels.lastIndexOf('flock')).toBeGreaterThan(labels.indexOf('npm install'));
    expect(afterRollbackLock).toEqual(
      restored
        ? ['copy-database', 'service install', 'skills install']
        : ['service install', 'skills install'],
    );
    if (restored) {
      expect(s.calls.at(-3)?.args).toEqual([s.bin, 'copy-database', s.backup, s.dbFile]);
    }
    expect(readdirSync(dirname(s.packageRoot))).toEqual(['spur-board']);
  });

  it('U4: a check that blocks in only one doctor run does not roll back', async () => {
    const s = await stand();
    const before = [...baseChecks, blocking('github.credentials')];
    s.behaviour.doctor = (run) => doctorResult(run === 2 ? [...before, blocking('x')] : before);
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
    expect(s.counts.doctor).toBe(3);
    const tail = s.events.filter((name) => name === 'doctor' || name === 'sleep 6000');
    expect(tail).toEqual(['doctor', 'doctor', 'sleep 6000', 'doctor']);
    expect(s.state().status).toBe('succeeded');
  });

  it('U5: a first poll that never completes rolls back', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    s.daemon.health = 'pending';
    s.ports.firstPollTimeoutMs = 2_000;
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('update_rolled_back');
    expect(error.hint).toContain('failed at first poll');
    expect(error.hint).toContain('within 2 s');
    expect(s.state()).toMatchObject({ status: 'rolled-back' });
    expect(s.state().reason).toMatch(/^first poll: /);
    expect(tree(s.packageRoot)).toEqual(original);
    expect(s.counts.doctor).toBe(1);
  });

  it('U5: a daemon without /v1/health reports the first poll as unsupported', async () => {
    const s = await stand();
    s.daemon.health = 'missing';
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { firstPoll: string }).firstPoll).toBe('unsupported');
  });

  it('U6: a failed package restore ends rollback-failed and stays recoverable', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    const snapshotManifest = join(s.updateDir, 'package-1.0.0', 'package.json');
    let manifestMode = 0;
    s.behaviour.install = () => {
      manifestMode = statSync(snapshotManifest).mode & 0o777;
      chmodSync(snapshotManifest, 0o000);
      return fail(1, 'npm error\n');
    };
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('rollback_failed');
    expect(error.hint).toContain('package restore');
    expect(s.state().status).toBe('rollback-failed');
    expect(tree(s.packageRoot)).toEqual(original);
    expect(readdirSync(dirname(s.packageRoot))).toEqual(['spur-board']);

    chmodSync(snapshotManifest, manifestMode);
    const again = await s.run(['--json', 'rollback', '--yes']);
    expect(again.exit, again.stderr).toBe(0);
    expect(s.state().status).toBe('rolled-back');
    expect(tree(s.packageRoot)).toEqual(original);
  });

  it('U6: a failed database restore after the package restore still restores it on retry', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    const install = s.behaviour.install;
    s.behaviour.install = () => {
      addMigration(s);
      return install();
    };
    const service = s.behaviour.serviceInstall;
    s.behaviour.serviceInstall = (run) => (run === 1 ? fail(4, 'start failed') : service(run));
    const copy = s.behaviour.copy;
    let restores = 0;
    s.behaviour.copy = (args) => {
      if (args[3] !== s.dbFile) return copy(args);
      restores += 1;
      return restores === 1 ? fail(1, 'disk full\n') : ok();
    };
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('rollback_failed');
    expect(error.hint).toContain('database restore');
    expect(s.state()).toMatchObject({ status: 'rollback-failed', restoreDatabase: true });
    expect(tree(s.packageRoot)).toEqual(original);

    const before = s.calls.length;
    const again = await s.run(['--json', 'rollback', '--yes']);
    expect(again.exit, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ database: 'restored' });
    const restoreCalls = s.calls.slice(before).filter((call) => call.label === 'copy-database');
    expect(restoreCalls.map((call) => call.args)).toEqual([
      [s.bin, 'copy-database', s.backup, s.dbFile],
    ]);
    expect(s.state().status).toBe('rolled-back');
    expect(tree(s.packageRoot)).toEqual(original);
  });

  const aborts: [string, string, (s: Stand) => void][] = [
    [
      '(a) the stop fails',
      'stop',
      (s) => {
        s.behaviour.stop = () => fail(1, 'Failed to stop\n');
      },
    ],
    [
      '(b) the lock stays held',
      'lock wait',
      (s) => {
        s.ports.lockWaitMs = 1_000;
        writeFileSync(join(dirname(s.dbFile), 'board.lock'), '4242\n');
        s.behaviour.flock = () => fail(75, '');
      },
    ],
    [
      '(c) the database backup fails',
      'database backup',
      (s) => {
        s.behaviour.copy = () => fail(75, 'Database lock held by PID 4242.\n');
      },
    ],
  ];

  it.each(aborts)('U7: aborts without changes when %s', async (_name, step, arrange) => {
    const s = await stand();
    const original = tree(s.packageRoot);
    arrange(s);
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('update_rolled_back');
    expect(error.hint).toContain(`stopped at ${step}`);
    expect(error.hint).toContain('were not changed');
    if (step === 'lock wait') expect(error.hint).toContain('4242');
    expect(existsSync(s.stateFile)).toBe(false);
    expect(readdirSync(s.updateDir).filter((name) => name !== 'db')).toEqual([]);
    expect(existsSync(s.backup)).toBe(false);
    expect(tree(s.packageRoot)).toEqual(original);
    const labels = s.labels();
    expect(labels).not.toContain('npm install');
    expect(labels.filter((name) => name === 'service install')).toHaveLength(1);
    expect(labels.indexOf('service install')).toBeGreaterThan(labels.indexOf('stop'));
    expect(s.calls.find((call) => call.label === 'service install')?.args).toEqual([
      s.bin,
      '--json',
      'service',
      'install',
    ]);

    s.behaviour.view = () => ok('"1.0.0"');
    const next = await s.run(['--json', 'update']);
    expect(next.exit, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ changed: false });
  });

  it('U7: a flock error other than a held lock aborts at once without blaming a holder', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    s.ports.lockWaitMs = 20_000;
    writeFileSync(join(dirname(s.dbFile), 'board.lock'), '4242\n');
    s.behaviour.flock = () => fail(1, 'flock: cannot open lock file: Permission denied\n');
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('update_rolled_back');
    expect(error.hint).toContain('stopped at lock wait');
    expect(error.hint).toContain('exit 1');
    expect(error.hint).toContain('cannot open lock file: Permission denied');
    expect(error.hint).not.toContain('held');
    expect(error.hint).not.toContain('4242');
    expect(s.labels().filter((name) => name === 'flock')).toHaveLength(1);
    expect(s.events).not.toContain('sleep 500');
    expect(existsSync(s.stateFile)).toBe(false);
    expect(readdirSync(s.updateDir).filter((name) => name !== 'db')).toEqual([]);
    expect(existsSync(s.backup)).toBe(false);
    expect(tree(s.packageRoot)).toEqual(original);
    expect(s.labels()).not.toContain('npm install');
  });
  it('U8: a second update or rollback during an update refuses and changes nothing', async () => {
    const s = await stand();
    const lock = join(s.updateDir, 'update.lock');
    type Run = Awaited<ReturnType<Stand['run']>>;
    const seen: { runs: Run[]; calls: number; lock: string } = { runs: [], calls: -1, lock: '' };
    let started = false;
    s.hooks.beforeCall = async (name) => {
      if (name !== 'doctor' || started) return;
      started = true;
      const calls = s.calls.length;
      seen.lock = readFileSync(lock, 'utf8');
      seen.runs.push(await s.run(['--json', 'update']));
      seen.runs.push(await s.run(['--json', 'rollback', '--yes']));
      seen.calls = s.calls.length - calls;
    };
    const first = await s.run(['--json', 'update']);

    expect(first.exit, first.stderr).toBe(0);
    expect(seen.lock).toBe(`${String(process.pid)}\n`);
    expect(seen.runs).toHaveLength(2);
    for (const second of seen.runs) {
      expect(second.exit).toBe(4);
      const error = errorOf(second.stderr);
      expect(error.code).toBe('config');
      expect(error.hint).toContain(`is running as PID ${String(process.pid)}`);
    }
    expect(seen.calls).toBe(0);
    expect(s.labels().filter((name) => name === 'stop')).toHaveLength(1);
    expect(s.state().status).toBe('succeeded');
    expect(existsSync(lock)).toBe(false);
  });

  it('U8: refuses while another process holds the update lock', async () => {
    const s = await stand();
    const lock = join(s.updateDir, 'update.lock');
    mkdirSync(s.updateDir, { recursive: true });
    writeFileSync(lock, '1\n');
    const result = await s.run(['--json', 'update']);

    expect(result.exit).toBe(4);
    expect(errorOf(result.stderr).hint).toContain('is running as PID 1');
    expect(errorOf(result.stderr).hint).toContain(lock);
    expect(readFileSync(lock, 'utf8')).toBe('1\n');
    expect(s.labels()).toEqual([]);
  });

  it('U8: takes over an update lock whose process no longer runs', async () => {
    const s = await stand();
    const lock = join(s.updateDir, 'update.lock');
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(s.updateDir, { recursive: true });
    writeFileSync(lock, `${String(gone)}\n`);
    const result = await s.run(['--json', 'update']);

    expect(result.exit, result.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('U9: an abort keeps the last successful update, so rollback still returns to it', async () => {
    const s = await stand();
    const original = tree(s.packageRoot);
    const install = s.behaviour.install;
    s.behaviour.install = () => {
      addMigration(s);
      return install();
    };
    const first = await s.run(['--json', 'update']);
    expect(first.exit, first.stderr).toBe(0);
    const stateBytes = readFileSync(s.stateFile);
    const installed = tree(s.packageRoot);

    s.behaviour.view = () => ok('"1.2.0"');
    const stop = s.behaviour.stop;
    s.behaviour.stop = () => fail(1, 'Failed to stop\n');
    const aborted = await s.run(['--json', 'update']);

    expect(aborted.exit).toBe(4);
    expect(errorOf(aborted.stderr).code).toBe('update_rolled_back');
    expect(readFileSync(s.stateFile)).toEqual(stateBytes);
    expect(readdirSync(s.updateDir).sort()).toEqual(['db', 'package-1.0.0', 'state.json']);
    expect(readdirSync(join(s.updateDir, 'db'))).toEqual(['board-1.0.0.sqlite']);
    expect(tree(join(s.updateDir, 'package-1.0.0'))).toEqual(original);
    expect(tree(s.packageRoot)).toEqual(installed);

    s.behaviour.stop = stop;
    const before = s.calls.length;
    const back = await s.run(['--json', 'rollback', '--yes']);
    expect(back.exit, back.stderr).toBe(0);
    expect(JSON.parse(back.stdout)).toMatchObject({
      from: '1.1.0',
      to: '1.0.0',
      database: 'restored',
    });
    const restores = s.calls.slice(before).filter((call) => call.label === 'copy-database');
    expect(restores.map((call) => call.args)).toEqual([
      [s.bin, 'copy-database', s.backup, s.dbFile],
    ]);
    expect(tree(s.packageRoot)).toEqual(original);
  });

  it('U9: a later successful update replaces the previous snapshot and backup', async () => {
    const s = await stand();
    expect((await s.run(['--json', 'update'])).exit).toBe(0);
    s.behaviour.view = () => ok('"1.2.0"');
    const second = await s.run(['--json', 'update']);

    expect(second.exit, second.stderr).toBe(0);
    const backup = join(s.updateDir, 'db', 'board-1.1.0.sqlite');
    expect(s.state()).toMatchObject({ status: 'succeeded', from: '1.1.0', dbBackup: backup });
    expect(readdirSync(s.updateDir).sort()).toEqual(['db', 'package-1.1.0', 'state.json']);
    expect(readdirSync(join(s.updateDir, 'db'))).toEqual(['board-1.1.0.sqlite']);
  });
});

describe('board rollback', () => {
  async function updated(schemaChange: boolean) {
    const s = await stand();
    const original = tree(s.packageRoot);
    if (schemaChange) {
      const install = s.behaviour.install;
      s.behaviour.install = () => {
        addMigration(s);
        return install();
      };
    }
    const result = await s.run(['--json', 'update']);
    expect(result.exit, result.stderr).toBe(0);
    const before = s.calls.length;
    return {
      s,
      original,
      after: () => s.labels().slice(before),
      callsAfter: () => s.calls.slice(before),
    };
  }

  it('R1: refuses without a recorded update, after a rollback, and without consent', async () => {
    const empty = await stand();
    const none = await empty.run(['--json', 'rollback', '--yes']);
    expect(none.exit).toBe(4);
    expect(errorOf(none.stderr).hint).toContain('No update to roll back');
    expect(empty.labels()).toEqual([]);

    const { s, after } = await updated(false);
    const unattended = await s.run(['--json', 'rollback']);
    expect(unattended.exit).toBe(2);
    expect(errorOf(unattended.stderr).hint).toContain('--yes');
    expect(after()).toEqual([]);

    s.ports.stdinIsTTY = true;
    s.ports.confirm = () => Promise.resolve(false);
    const declined = await s.run(['--json', 'rollback'], true);
    expect(declined.exit).toBe(0);
    expect(JSON.parse(declined.stdout)).toEqual({ from: '1.1.0', to: '1.0.0', rolledBack: false });
    expect(after()).toEqual([]);

    expect((await s.run(['--json', 'rollback', '--yes'])).exit).toBe(0);
    const twice = await s.run(['--json', 'rollback', '--yes']);
    expect(twice.exit).toBe(4);
    expect(errorOf(twice.stderr).hint).toContain('No update to roll back');
  });

  it('R2: restores the database when the schema changed', async () => {
    const { s, original, after, callsAfter } = await updated(true);
    const result = await s.run(['--json', 'rollback', '--yes']);

    expect(result.exit, result.stderr).toBe(0);
    expect(after()).toEqual([
      'stop',
      'flock',
      'copy-database',
      'service install',
      'skills install',
    ]);
    expect(callsAfter()[2]?.args).toEqual([s.bin, 'copy-database', s.backup, s.dbFile]);
    expect(tree(s.packageRoot)).toEqual(original);
    const output = JSON.parse(result.stdout) as { database: string; lost: string };
    expect(output).toMatchObject({ from: '1.1.0', to: '1.0.0', database: 'restored' });
    expect(output.lost).toBe(
      `Board changes and journal events recorded after ${s.state().startedAt}.`,
    );
    expect(s.state().status).toBe('rolled-back');
  });

  it('R2: keeps the database when the schema did not change', async () => {
    const { s, original, after } = await updated(false);
    const result = await s.run(['--json', 'rollback', '--yes']);

    expect(result.exit, result.stderr).toBe(0);
    expect(after()).toEqual(['stop', 'flock', 'service install', 'skills install']);
    expect(tree(s.packageRoot)).toEqual(original);
    const output = JSON.parse(result.stdout) as { database: string; lost: string };
    expect(output.database).toBe('kept');
    expect(output.lost).toMatch(/^Nothing/);
  });

  it('R3: states what is lost before asking and before any change', async () => {
    const { s, after } = await updated(true);
    let seen = { stderr: '', calls: -1 };
    s.ports.stdinIsTTY = true;
    const output = { stderr: '' };
    s.ports.confirm = () => {
      seen = { stderr: output.stderr, calls: after().length };
      return Promise.resolve(true);
    };
    const exit = await runCli(['--json', 'rollback'], {
      env: s.env,
      home: s.home,
      update: s.ports,
      io: {
        isTTY: true,
        stdout: () => {},
        stderr: (text) => {
          output.stderr += text;
        },
      },
    });

    expect(exit).toBe(0);
    expect(seen.calls).toBe(0);
    expect(seen.stderr).toContain('Lost: Board changes and journal events recorded after');
  });

  it('R4: a held lock changes nothing and restarts the current package', async () => {
    const { s, after } = await updated(true);
    const installed = tree(s.packageRoot);
    const stateBytes = readFileSync(s.stateFile);
    s.ports.lockWaitMs = 1_000;
    writeFileSync(join(dirname(s.dbFile), 'board.lock'), '4242\n');
    s.behaviour.flock = () => fail(75, '');
    const result = await s.run(['--json', 'rollback', '--yes']);

    expect(result.exit).toBe(4);
    const error = errorOf(result.stderr);
    expect(error.code).toBe('config');
    expect(error.hint).toContain('lock wait');
    expect(error.hint).toContain('4242');
    expect(readFileSync(s.stateFile)).toEqual(stateBytes);
    expect(tree(s.packageRoot)).toEqual(installed);
    expect(after().filter((name) => name !== 'flock')).toEqual(['stop', 'service install']);
  });
});
