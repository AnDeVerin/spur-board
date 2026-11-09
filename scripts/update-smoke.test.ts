import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseUnit, showProperties } from './update-smoke-systemctl.ts';
import {
  buildPackument,
  execStartLine,
  integrity,
  migrationName,
  patchManifest,
  standEnv,
  upstreamUrl,
} from './update-smoke.ts';

describe('update smoke registry', () => {
  it('forwards a path that starts with one slash to the npm host', () => {
    expect(upstreamUrl('/pkg')?.href).toBe('https://registry.npmjs.org/pkg');
    expect(upstreamUrl('/@scope%2fname')?.href).toBe('https://registry.npmjs.org/@scope%2fname');
  });

  it.each([
    '@evil.example/x',
    '//evil.example/x',
    'http://evil.example/x',
    '/\\\\evil.example/x',
    '/https://evil.example/x',
  ])('refuses the request-target %s', (path) => {
    expect(upstreamUrl(path)).toBeUndefined();
  });

  const manifest = (version: string) => ({
    name: 'spur-board',
    version,
    dependencies: { zod: '^4.0.0' },
    engines: { node: '^24.12.0 || ^26.0.0' },
    bin: { board: './dist/bin.mjs' },
    scripts: { build: 'tsdown' },
  });

  it('computes an sha512 integrity of the tarball bytes', () => {
    const bytes = Buffer.from('tarball');
    expect(integrity(bytes)).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  });

  it('lists the published versions with their dist and the last one as latest', () => {
    const packument = buildPackument('http://127.0.0.1:4873', [
      { manifest: manifest('1.0.0'), integrity: 'sha512-a' },
      { manifest: manifest('1.1.0'), integrity: 'sha512-b' },
    ]);
    expect(packument['dist-tags']).toEqual({ latest: '1.1.0' });
    expect(packument['versions']).toEqual({
      '1.0.0': {
        name: 'spur-board',
        version: '1.0.0',
        dependencies: { zod: '^4.0.0' },
        engines: { node: '^24.12.0 || ^26.0.0' },
        bin: { board: './dist/bin.mjs' },
        dist: {
          tarball: 'http://127.0.0.1:4873/spur-board/-/spur-board-1.0.0.tgz',
          integrity: 'sha512-a',
        },
      },
      '1.1.0': expect.objectContaining({
        version: '1.1.0',
        dist: {
          tarball: 'http://127.0.0.1:4873/spur-board/-/spur-board-1.1.0.tgz',
          integrity: 'sha512-b',
        },
      }) as unknown,
    });
  });

  it('has no latest before anything is published', () => {
    expect(buildPackument('http://127.0.0.1:1', [])['dist-tags']).toEqual({});
  });

  it('replaces only the manifest version', () => {
    const patched = JSON.parse(
      patchManifest(JSON.stringify(manifest('0.1.0')), '1.2.0'),
    ) as unknown;
    expect(patched).toEqual(manifest('1.2.0'));
  });

  it('names migrations with the 4-digit zero-padded number migrate accepts', () => {
    expect(migrationName(9, 'update_smoke')).toBe('0009_update_smoke.sql');
    expect(migrationName(10, 'update_smoke_two')).toBe('0010_update_smoke_two.sql');
    expect(migrationName(1234, 'x')).toMatch(/^(\d{4})_[a-z0-9_]+\.sql$/);
  });
});

describe('update smoke unit parsing', () => {
  const unit = [
    '[Service]',
    'ExecStart="/opt/node 24/bin/node" "/p/lib/node_modules/spur-board/dist/daemon.mjs"',
    'Environment="BOARD_HOME=/tmp/a \\"b\\" 100%%"',
    'Environment="XDG_DATA_HOME=/tmp/data"',
    'Type=notify',
    '',
  ].join('\n');

  it('reads ExecStart and Environment as renderUserUnit quotes them', () => {
    expect(parseUnit(unit)).toEqual({
      command: ['/opt/node 24/bin/node', '/p/lib/node_modules/spur-board/dist/daemon.mjs'],
      environment: { BOARD_HOME: '/tmp/a "b" 100%', XDG_DATA_HOME: '/tmp/data' },
    });
    expect(execStartLine(unit)).toBe(
      'ExecStart="/opt/node 24/bin/node" "/p/lib/node_modules/spur-board/dist/daemon.mjs"',
    );
  });

  it('answers show with the unit settings as systemd prints them', () => {
    expect(showProperties(unit).split('\n')).toEqual([
      'ExecStart={ path=/opt/node 24/bin/node ; argv[]=/opt/node 24/bin/node /p/lib/node_modules/spur-board/dist/daemon.mjs ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
      'Environment="BOARD_HOME=/tmp/a \\"b\\" 100%" XDG_DATA_HOME=/tmp/data',
      'EnvironmentFiles=',
      '',
    ]);
  });

  it('rejects a unit without ExecStart or with unquoted arguments', () => {
    expect(() => parseUnit('[Service]\nType=notify\n')).toThrow('no ExecStart');
    expect(() => parseUnit('ExecStart=/bin/node daemon.mjs\n')).toThrow('Unquoted');
  });
});

describe('update smoke environment', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/real',
    SPUR_SESSION: 'live',
    SPUR_CONFIG: '/home/real/.spur/config.yaml',
    BOARD_HOME: '/home/real/board',
    BOARD_DAEMON_URL: 'http://127.0.0.1:7000',
    GITHUB_TOKEN: 'secret',
    SLACK_BOT_TOKEN: 'secret',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
    NOTIFY_SOCKET: '/run/systemd/notify',
    XDG_RUNTIME_DIR: '/run/user/1',
    XDG_CONFIG_HOME: '/home/real/.config',
    NPM_CONFIG_PREFIX: '/home/real/.local',
    npm_config_globalconfig: '/home/real/.npmrc',
    npm_config_cache: '/home/real/.npm',
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    CODEX_HOME: '/home/real/.codex',
  };
  const env = standEnv('/tmp/stand', base, 'http://127.0.0.1:4873', '/opt/node/bin');

  it('puts every home, data dir and npm cache under the root', () => {
    expect(env).toMatchObject({
      HOME: '/tmp/stand/home',
      BOARD_HOME: '/tmp/stand/home/board',
      XDG_CONFIG_HOME: '/tmp/stand/home/.config',
      XDG_DATA_HOME: '/tmp/stand/home/.local/share',
      XDG_STATE_HOME: '/tmp/stand/home/.local/state',
      XDG_RUNTIME_DIR: '/tmp/stand/runtime',
      npm_config_cache: '/tmp/stand/npm-cache',
      npm_config_registry: 'http://127.0.0.1:4873',
      LANG: 'C.UTF-8',
    });
  });

  it('drops Spur, Board, credential, bus, proxy and live npm settings', () => {
    const names = Object.keys(env);
    expect(names.filter((name) => name.startsWith('SPUR_'))).toEqual([]);
    for (const name of [
      'BOARD_DAEMON_URL',
      'GITHUB_TOKEN',
      'SLACK_BOT_TOKEN',
      'DBUS_SESSION_BUS_ADDRESS',
      'NOTIFY_SOCKET',
      'NPM_CONFIG_PREFIX',
      'HTTPS_PROXY',
      'CODEX_HOME',
    ]) {
      expect(names).not.toContain(name);
    }
    expect(env['npm_config_globalconfig']).toBe('/tmp/stand/npmrc');
    expect(
      Object.entries(env)
        .filter(([name]) => name.toLowerCase().startsWith('npm_config_'))
        .every(
          ([, value]) =>
            value === 'false' ||
            value?.startsWith('/tmp/stand') ||
            value?.startsWith('http://127.0.0.1'),
        ),
    ).toBe(true);
  });

  it('puts the fake systemctl first and the installed board second on PATH', () => {
    expect(env['PATH']).toBe(
      '/tmp/stand/fake-bin:/tmp/stand/home/.local/bin:/opt/node/bin:/usr/bin',
    );
  });
});
