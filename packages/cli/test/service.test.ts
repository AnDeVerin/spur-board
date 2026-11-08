import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ERRORS } from '@spur-board/contracts';
import { runCli, type CliIo } from '../src/cli.ts';
import { bindLoopback } from '../src/port.ts';
import { holder } from './http-holder.ts';
import {
  installService,
  renderUserUnit,
  restartService,
  servicePaths,
  statusService,
  uninstallService,
  type CommandResult,
  type CommandRunner,
  type ServiceOptions,
} from '../src/service.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function fakeRunner(
  active = false,
  ss = '',
): {
  calls: { command: string; args: string[] }[];
  run: CommandRunner;
} {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args] });
    let result: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
    if (args.includes('is-active')) {
      result = active
        ? { exitCode: 0, stdout: 'active\n', stderr: '' }
        : { exitCode: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (args.includes('is-enabled')) result = { exitCode: 1, stdout: 'disabled\n', stderr: '' };
    if (command === 'loginctl') result = { exitCode: 0, stdout: 'no\n', stderr: '' };
    if (command === 'ss') result = { exitCode: 0, stdout: ss, stderr: '' };
    return Promise.resolve(result);
  };
  return { calls, run };
}

async function fixture(
  active = false,
  ss = '',
): Promise<{
  root: string;
  options: ServiceOptions;
  paths: ReturnType<typeof servicePaths>;
  calls: { command: string; args: string[] }[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'board-service-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const nodePath = join(root, 'node binary');
  const daemonEntry = join(root, 'package with spaces', 'daemon.ts');
  const env = {
    BOARD_HOME: join(root, 'board config'),
    XDG_CONFIG_HOME: join(root, 'xdg config'),
  };
  await mkdir(home);
  await mkdir(join(root, 'package with spaces'));
  await mkdir(env.BOARD_HOME);
  await writeFile(nodePath, 'node', { mode: 0o700 });
  await writeFile(daemonEntry, 'daemon');
  await writeFile(join(env.BOARD_HOME, 'secrets.env'), 'BOARD_TOKEN=secret\n', { mode: 0o600 });
  const fake = fakeRunner(active, ss);
  const options: ServiceOptions = {
    home,
    env,
    nodePath,
    daemonEntry,
    username: 'operator',
    runner: fake.run,
    bind: () => Promise.resolve(null),
  };
  return { root, options, paths: servicePaths(options), calls: fake.calls };
}

const startFailure =
  'Job for spur-board.service failed because the control process exited with error code.';

function failingStartRunner(
  target: 'enable' | 'restart',
  activeBeforeFailure = false,
): { calls: { command: string; args: string[] }[]; run: CommandRunner } {
  const calls: { command: string; args: string[] }[] = [];
  let failed = false;
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args] });
    if (args.includes(target)) {
      failed = true;
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: `${startFailure}\n` });
    }
    if (args.includes('is-active')) {
      return Promise.resolve(
        !failed && activeBeforeFailure
          ? { exitCode: 0, stdout: 'active\n', stderr: '' }
          : { exitCode: 3, stdout: 'activating\n', stderr: '' },
      );
    }
    if (args.includes('is-enabled')) {
      return Promise.resolve({ exitCode: 0, stdout: 'enabled\n', stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
  return { calls, run };
}

async function runService(
  args: string[],
  options: ServiceOptions,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const output = { stdout: '', stderr: '' };
  const io: CliIo = {
    isTTY: false,
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
  };
  const exit = await runCli(args, { env: options.env ?? {}, io, setup: options });
  return { exit, ...output };
}

const systemctl = (...args: string[]) => ({ command: 'systemctl', args: ['--user', ...args] });

/** A schema-valid config.yaml, so install reads this port instead of the default. */
async function writeConfig(options: ServiceOptions, port: number): Promise<void> {
  const boardHome = options.env?.['BOARD_HOME'];
  if (boardHome === undefined) throw new Error('fixture has no BOARD_HOME');
  await writeFile(
    join(boardHome, 'config.yaml'),
    `projects:
  - id: board
    tracker:
      type: github-issues
      repo: example/board
      label: board
    repos: [example/board]
    operatorGithubLogin: operator
    spurProjects:
      - name: worker
        role: worker
operator:
  slack: U0000000000
digest:
  tz: UTC
http: { port: ${String(port)} }
`,
  );
}

describe('service', () => {
  it('dispatches lifecycle commands without daemon config through a fake runner', async () => {
    const { options, paths, calls } = await fixture();
    const output = { stdout: '', stderr: '' };
    const io: CliIo = {
      isTTY: false,
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    };
    const cli = (args: string[]) =>
      runCli(['service', ...args], {
        env: options.env ?? {},
        io,
        setup: options,
      });

    expect(await cli(['install'])).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ unitFile: paths.unitFile, changed: true });
    const unit = await readFile(paths.unitFile, 'utf8');
    expect(unit).toBe(renderUserUnit(paths));
    expect(unit).toContain(`Environment="BOARD_HOME=${dirname(paths.secretsFile)}"`);
    await rm(paths.daemonEntry);
    await rm(paths.secretsFile);
    output.stdout = '';
    expect(await cli(['status'])).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      unit: 'spur-board.service',
      active: 'inactive',
      enabled: 'disabled',
      lingering: false,
    });
    expect(await cli(['restart'])).toBe(0);
    expect(await cli(['uninstall'])).toBe(0);
    expect(output.stderr).toBe('');
    expect(calls.some((call) => call.command === 'loginctl')).toBe(true);
    expect(calls.every((call) => !call.args.includes('enable-linger'))).toBe(true);
    await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a missing daemon entry before CLI service install has side effects', async () => {
    const { options, paths, calls } = await fixture();
    await rm(paths.daemonEntry);
    const output = { stdout: '', stderr: '' };
    const io: CliIo = {
      isTTY: false,
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    };
    expect(
      await runCli(['service', 'install'], { env: options.env ?? {}, io, setup: options }),
    ).toBe(4);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('daemon entry is missing or unreadable');
    expect(output.stderr).toContain('error: config:');
    expect(output.stderr).toContain('side effects: none');
    expect(output.stderr).not.toContain('service_start_failed');
    expect(calls).toEqual([]);
    await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a failed enable --now as a service start failure with the unit applied', async () => {
    const { options, paths } = await fixture();
    const fake = failingStartRunner('enable');
    const result = await runService(['--json', 'service', 'install'], {
      ...options,
      runner: fake.run,
    });

    expect(result.exit).toBe(4);
    expect(result.stdout).toBe('');
    const { error } = JSON.parse(result.stderr) as {
      error: {
        code: string;
        message: string;
        hint: string;
        recovery: { sideEffects: string; action: string };
      };
    };
    expect(error.code).toBe('service_start_failed');
    expect(error.message).toBe(ERRORS.service_start_failed.message);
    expect(error.recovery.sideEffects).toBe('applied');
    expect(error.recovery.action).toContain('journalctl --user -u spur-board.service');
    expect(error.hint).toContain(paths.unitFile);
    expect(error.hint).toContain('enabled');
    expect(error.hint).toContain('activating');
    expect(error.hint).toContain(startFailure);
    expect(error.hint).toContain('journalctl --user -u spur-board.service -n 100');
    expect(await readFile(paths.unitFile, 'utf8')).toBe(renderUserUnit(paths));
    expect(fake.calls).toEqual([
      systemctl('daemon-reload'),
      systemctl('enable', '--now', 'spur-board.service'),
      systemctl('is-active', 'spur-board.service'),
      systemctl('is-enabled', 'spur-board.service'),
    ]);
  });

  it('prints a failed enable --now as applied in the human form', async () => {
    const { options } = await fixture();
    const fake = failingStartRunner('enable');
    const result = await runService(['service', 'install'], { ...options, runner: fake.run });

    expect(result.exit).toBe(4);
    expect(result.stderr).toContain('error: service_start_failed:');
    expect(result.stderr).toContain('side effects: applied');
    expect(result.stderr).not.toContain('error: config:');
    expect(result.stderr).not.toContain('side effects: none');
  });

  it('reports a failed restart after a unit change as a service start failure', async () => {
    const { options, paths } = await fixture();
    await mkdir(dirname(paths.unitFile), { recursive: true });
    await writeFile(paths.unitFile, 'old unit\n');
    const fake = failingStartRunner('restart', true);
    const result = await runService(['--json', 'service', 'install'], {
      ...options,
      runner: fake.run,
    });

    expect(result.exit).toBe(4);
    const { error } = JSON.parse(result.stderr) as {
      error: { code: string; hint: string; recovery: { sideEffects: string } };
    };
    expect(error.code).toBe('service_start_failed');
    expect(error.recovery.sideEffects).toBe('applied');
    expect(error.hint).toContain(paths.unitFile);
    expect(error.hint).toContain('activating');
    expect(error.hint).toContain('enabled');
    expect(fake.calls).toEqual([
      systemctl('daemon-reload'),
      systemctl('is-active', 'spur-board.service'),
      systemctl('enable', '--now', 'spur-board.service'),
      systemctl('restart', 'spur-board.service'),
      systemctl('is-active', 'spur-board.service'),
      systemctl('is-enabled', 'spur-board.service'),
    ]);
  });

  it('reports a failed board service restart as a service start failure', async () => {
    const { options, paths } = await fixture();
    await mkdir(dirname(paths.unitFile), { recursive: true });
    await writeFile(paths.unitFile, renderUserUnit(paths));
    const fake = failingStartRunner('restart');
    const result = await runService(['--json', 'service', 'restart'], {
      ...options,
      runner: fake.run,
    });

    expect(result.exit).toBe(4);
    const { error } = JSON.parse(result.stderr) as {
      error: { code: string; hint: string; recovery: { sideEffects: string } };
    };
    expect(error.code).toBe('service_start_failed');
    expect(error.recovery.sideEffects).toBe('applied');
    expect(error.hint).toContain(startFailure);
    expect(fake.calls).toEqual([
      systemctl('restart', 'spur-board.service'),
      systemctl('is-active', 'spur-board.service'),
      systemctl('is-enabled', 'spur-board.service'),
    ]);
  });

  it('keeps the start failure when the state read-back cannot run', async () => {
    const { options } = await fixture();
    const fake = failingStartRunner('enable');
    const runner: CommandRunner = (command, args) =>
      args.includes('is-active') || args.includes('is-enabled')
        ? Promise.reject(new Error('spawn systemctl EAGAIN'))
        : fake.run(command, args);
    const result = await runService(['--json', 'service', 'install'], { ...options, runner });

    expect(result.exit).toBe(4);
    const { error } = JSON.parse(result.stderr) as {
      error: { code: string; hint: string; recovery: { sideEffects: string } };
    };
    expect(error.code).toBe('service_start_failed');
    expect(error.recovery.sideEffects).toBe('applied');
    expect(error.hint).toContain('is unknown; the service is unknown');
    expect(error.hint).toContain(startFailure);
  });

  it('reports a restart without an installed unit as missing, with no side effects', async () => {
    const { options, paths, calls } = await fixture();
    const result = await runService(['service', 'restart'], options);

    expect(result.exit).toBe(4);
    expect(result.stderr).toContain('error: config:');
    expect(result.stderr).toContain(`Unit file ${paths.unitFile} is not installed`);
    expect(result.stderr).toContain('`board service install`');
    expect(result.stderr).toContain('side effects: none');
    expect(result.stderr).not.toContain('service_start_failed');
    expect(calls).toEqual([]);
  });

  it('renders an exact systemd user unit with absolute paths and stop timeout', () => {
    const unit = renderUserUnit({
      nodePath: '/home/user name/bin/node',
      daemonEntry: '/opt/spur board/daemon.ts',
      secretsFile: '/home/user name/.config/spur board/secrets.env',
      unitFile: '/home/user name/.config/systemd/user/spur-board.service',
      environment: ['BOARD_HOME=/home/user name/.config/spur board'],
    });
    expect(unit).not.toContain('network-online.target');
    expect(unit).toMatchInlineSnapshot(`
      "[Unit]
      Description=spur-board daemon

      [Service]
      ExecStart="/home/user name/bin/node" "/opt/spur board/daemon.ts"
      Environment="BOARD_HOME=/home/user name/.config/spur board"
      EnvironmentFile="/home/user name/.config/spur board/secrets.env"
      Type=notify
      NotifyAccess=all
      WatchdogSec=180000ms
      Restart=on-failure
      RestartSec=5s
      TimeoutStopSec=15s

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it('installs once, reloads only when the unit changes, and starts through the fake runner', async () => {
    const { options, paths, calls } = await fixture();
    expect(await installService(options)).toEqual({ unitFile: paths.unitFile, changed: true });
    expect(await readFile(paths.unitFile, 'utf8')).toBe(renderUserUnit(paths));
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'spur-board.service'] },
    ]);
    calls.length = 0;
    expect(await installService(options)).toEqual({ unitFile: paths.unitFile, changed: false });
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'spur-board.service'] },
    ]);
  });

  it('passes the chosen XDG config and data paths to the daemon', async () => {
    const { root, options } = await fixture();
    const configHome = join(root, 'alternate config');
    const dataHome = join(root, 'alternate data');
    const env = { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome };
    const custom = { ...options, env };
    const paths = servicePaths(custom);
    await mkdir(join(configHome, 'spur-board'), { recursive: true });
    await writeFile(paths.secretsFile, 'BOARD_TOKEN=secret\n', { mode: 0o600 });

    await installService(custom);
    const unit = await readFile(paths.unitFile, 'utf8');
    expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${configHome}"`);
    expect(unit).toContain(`Environment="XDG_DATA_HOME=${dataHome}"`);
    expect(unit).not.toContain('Environment="BOARD_HOME=');
  });

  it('resolves default unit and secrets paths under the harness root, not the real home', () => {
    // The harness points TMPDIR at <root>/tmp (packages/testkit/src/global-setup.ts).
    const root = `${dirname(tmpdir())}/`;
    expect(root).toMatch(/\/spur-board-test-[^/]+\/$/);
    const realHome = `${userInfo().homedir}/`;
    const paths = servicePaths();
    for (const path of [paths.unitFile, paths.secretsFile]) {
      expect(path.startsWith(root), path).toBe(true);
      expect(path.startsWith(realHome), path).toBe(false);
    }
  });

  it('restarts an already active service after changing its unit', async () => {
    const { options, paths, calls } = await fixture(true);
    await mkdir(dirname(paths.unitFile), { recursive: true });
    await writeFile(paths.unitFile, 'old unit\n');

    expect(await installService(options)).toEqual({ unitFile: paths.unitFile, changed: true });
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'is-active', 'spur-board.service'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'spur-board.service'] },
      { command: 'systemctl', args: ['--user', 'restart', 'spur-board.service'] },
    ]);
  });

  it('rejects missing, directory-valued, and unreadable daemon entries before side effects', async () => {
    for (const kind of ['missing', 'directory', 'unreadable'] as const) {
      const { options, paths, calls } = await fixture();
      if (kind === 'missing') await rm(paths.daemonEntry);
      if (kind === 'directory') {
        await rm(paths.daemonEntry);
        await mkdir(paths.daemonEntry);
      }
      if (kind === 'unreadable') await chmod(paths.daemonEntry, 0o000);
      await expect(installService(options)).rejects.toThrow(
        'daemon entry is missing or unreadable',
      );
      await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(calls).toEqual([]);
    }
  });

  it('rejects a readable but non-executable Node file before service changes', async () => {
    const { options, paths, calls } = await fixture();
    await chmod(paths.nodePath, 0o600);
    await expect(installService(options)).rejects.toThrow(
      'Node executable is missing, unreadable, or not executable',
    );
    await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual([]);
  });

  it('requires a mode 0600 secrets file before writing or starting', async () => {
    const { options, paths, calls } = await fixture();
    await chmod(paths.secretsFile, 0o620);
    await expect(installService(options)).rejects.toThrow('Secrets file must exist');
    await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual([]);
  });

  it('reports state and lingering, then restarts and uninstalls after install files disappear', async () => {
    const { options, paths, calls } = await fixture();
    await installService(options);
    calls.length = 0;
    await rm(paths.daemonEntry);
    await rm(paths.secretsFile);

    expect(await statusService(options)).toEqual({
      active: 'inactive',
      enabled: 'disabled',
      lingering: false,
    });
    await restartService(options);
    expect(await uninstallService(options)).toEqual({ changed: true });
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'is-active', 'spur-board.service'] },
      { command: 'systemctl', args: ['--user', 'is-enabled', 'spur-board.service'] },
      {
        command: 'loginctl',
        args: ['show-user', 'operator', '--property=Linger', '--value'],
      },
      { command: 'systemctl', args: ['--user', 'restart', 'spur-board.service'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'spur-board.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ]);
    expect(calls.every((call) => !call.args.includes('enable-linger'))).toBe(true);
    await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
    calls.length = 0;
    expect(await uninstallService(options)).toEqual({ changed: false });
    expect(calls).toEqual([]);
  });

  it('stops before enabling the unit when http.port is held', async () => {
    const server = await holder({});
    try {
      const ss = `LISTEN 0 511 127.0.0.1:${String(server.port)} 0.0.0.0:* users:(("spur-web",pid=4242,fd=21))\n`;
      const { options, paths, calls } = await fixture(false, ss);
      await writeConfig(options, server.port);
      const output = { stdout: '', stderr: '' };
      const io: CliIo = {
        isTTY: false,
        stdout: (text) => {
          output.stdout += text;
        },
        stderr: (text) => {
          output.stderr += text;
        },
      };
      expect(
        await runCli(['service', 'install'], {
          env: options.env ?? {},
          io,
          setup: { ...options, bind: bindLoopback },
        }),
      ).toBe(4);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain(`Port ${String(server.port)} (http.port)`);
      expect(output.stderr).toContain('spur-web (pid 4242)');
      expect(calls).toEqual([
        { command: 'ss', args: ['-ltnp', `sport = :${String(server.port)}`] },
      ]);
      await expect(stat(paths.unitFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await server.close();
    }
  });

  it('proceeds when a board daemon holds http.port', async () => {
    const server = await holder({ 'x-board-instance': randomUUID() });
    try {
      const { options, paths, calls } = await fixture();
      await writeConfig(options, server.port);
      expect(await installService({ ...options, bind: bindLoopback })).toEqual({
        unitFile: paths.unitFile,
        changed: true,
      });
      expect(calls).toEqual([
        { command: 'systemctl', args: ['--user', 'daemon-reload'] },
        { command: 'systemctl', args: ['--user', 'enable', '--now', 'spur-board.service'] },
      ]);
    } finally {
      await server.close();
    }
  });

  it('skips the probe for http.port 0', async () => {
    const { options, paths } = await fixture();
    await writeConfig(options, 0);
    const bind = () => Promise.reject(new Error('port 0 is never probed'));
    expect(await installService({ ...options, bind })).toEqual({
      unitFile: paths.unitFile,
      changed: true,
    });
  });
});
