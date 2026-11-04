import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function fakeRunner(): {
  calls: { command: string; args: string[] }[];
  run: CommandRunner;
} {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args] });
    let result: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
    if (args.includes('is-active')) result = { exitCode: 3, stdout: 'inactive\n', stderr: '' };
    if (args.includes('is-enabled')) result = { exitCode: 1, stdout: 'disabled\n', stderr: '' };
    if (command === 'loginctl') result = { exitCode: 0, stdout: 'no\n', stderr: '' };
    return Promise.resolve(result);
  };
  return { calls, run };
}

async function fixture(): Promise<{
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
  await writeFile(nodePath, 'node');
  await writeFile(daemonEntry, 'daemon');
  await writeFile(join(env.BOARD_HOME, 'secrets.env'), 'BOARD_TOKEN=secret\n', { mode: 0o600 });
  const fake = fakeRunner();
  const options: ServiceOptions = {
    home,
    env,
    nodePath,
    daemonEntry,
    username: 'operator',
    runner: fake.run,
  };
  return { options, paths: servicePaths(options), calls: fake.calls };
}

describe('service', () => {
  it('renders an exact systemd user unit with absolute paths and stop timeout', () => {
    expect(
      renderUserUnit({
        nodePath: '/home/user name/bin/node',
        daemonEntry: '/opt/spur board/daemon.ts',
        secretsFile: '/home/user name/.config/spur board/secrets.env',
        unitFile: '/home/user name/.config/systemd/user/spur-board.service',
      }),
    ).toMatchInlineSnapshot(`
      "[Unit]
      Description=spur-board daemon
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart="/home/user name/bin/node" "/opt/spur board/daemon.ts"
      EnvironmentFile="/home/user name/.config/spur board/secrets.env"
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
});
