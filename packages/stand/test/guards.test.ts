import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proxyRefusal, refusal } from '../src/guards.ts';
import { liveConfigDir, writeLiveConfig } from './live-config.ts';

let base: string;
let root: string;
let osHome: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stand-guards-'));
  root = join(base, 'tmp');
  osHome = join(base, 'home');
  // Private, so the umask cannot make the root group-writable.
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(osHome);
  writeLiveConfig(liveConfigDir(osHome));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('refusal', () => {
  it('allows a clean start', () => {
    expect(refusal({ root, port: 0, env: {}, osHome })).toBeUndefined();
  });

  it('refuses live_home when BOARD_HOME is the root', () => {
    expect(refusal({ root, port: 0, env: { BOARD_HOME: root }, osHome })?.reason).toBe('live_home');
  });

  it('refuses live_home when BOARD_HOME holds the root', () => {
    expect(refusal({ root, port: 0, env: { BOARD_HOME: base }, osHome })?.reason).toBe('live_home');
  });

  it('refuses live_home for a root inside the XDG data dir', () => {
    const data = join(base, 'data');
    const inside = join(data, 'spur-board', 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(refusal({ root: inside, port: 0, env: { XDG_DATA_HOME: data }, osHome })?.reason).toBe(
      'live_home',
    );
  });

  it('refuses live_home for a root inside the default config dir', () => {
    const inside = join(osHome, '.config', 'spur-board', 'tmp');
    mkdirSync(inside, { recursive: true });
    expect(refusal({ root: inside, port: 0, env: {}, osHome })?.reason).toBe('live_home');
  });

  it.each([
    ['777', 0o777],
    ['775', 0o775],
    ['757', 0o757],
  ])('refuses unsafe_root for a root with mode %s and no sticky bit', (_name, mode) => {
    chmodSync(root, mode);
    expect(refusal({ root, port: 0, env: {}, osHome })?.reason).toBe('unsafe_root');
  });

  it.each([
    ['1777', 0o1777],
    ['755', 0o755],
    ['700', 0o700],
  ])('allows a root with mode %s', (_name, mode) => {
    chmodSync(root, mode);
    expect(refusal({ root, port: 0, env: {}, osHome })).toBeUndefined();
  });

  it.each([
    ['777', 0o777, 'unsafe_root'],
    ['775', 0o775, 'unsafe_root'],
    ['1777', 0o1777, undefined],
    ['755', 0o755, undefined],
  ])('checks an ancestor of the root: mode %s gives %s', (_name, mode, reason) => {
    const shared = join(base, 'shared');
    const own = join(shared, 'own-tmp');
    mkdirSync(own, { recursive: true });
    chmodSync(own, 0o700);
    chmodSync(shared, mode);
    expect(refusal({ root: own, port: 0, env: {}, osHome })?.reason).toBe(reason);
  });

  it('refuses unsafe_root for a root that does not exist', () => {
    expect(refusal({ root: join(base, 'missing'), port: 0, env: {}, osHome })?.reason).toBe(
      'unsafe_root',
    );
  });

  it('refuses live_port for 4777', () => {
    expect(refusal({ root, port: 4777, env: {}, osHome })?.reason).toBe('live_port');
  });

  it.each([4779, 4800, 1, 65_535])('refuses port_range for %i', (port) => {
    expect(refusal({ root, port, env: {}, osHome })?.reason).toBe('port_range');
  });

  it.each([0, 4780, 4799])('allows port %i', (port) => {
    expect(refusal({ root, port, env: {}, osHome })).toBeUndefined();
  });

  it.each([
    ['port 4785', 4785, { port: 4785 }],
    ['port 4786', 4786, { port: 4786 }],
    ['web port 4785', 4785, { port: 0, webPort: 4785 }],
    ['web port 4786', 4786, { port: 4781, webPort: 4786 }],
  ])('refuses live_port for %s', (_name, live, ports) => {
    writeLiveConfig(liveConfigDir(osHome), {
      httpPort: 4785,
      web: { port: 4786, publicOrigin: 'https://{port}.local.example' },
    });
    const result = refusal({ root, ...ports, env: {}, osHome });
    expect(result?.reason).toBe('live_port');
    expect(result?.message).toContain(`Port ${String(live)} is the live board's`);
  });

  it('refuses port_range, not live_port, for 4777 when the live board listens on 4785', () => {
    writeLiveConfig(liveConfigDir(osHome), { httpPort: 4785 });
    expect(refusal({ root, port: 4777, env: {}, osHome })?.reason).toBe('port_range');
  });

  it.each([
    [
      'missing',
      (dir: string) => {
        rmSync(join(dir, 'config.yaml'));
      },
    ],
    [
      'a directory',
      (dir: string) => {
        rmSync(join(dir, 'config.yaml'));
        mkdirSync(join(dir, 'config.yaml'));
      },
    ],
    [
      'bad YAML',
      (dir: string) => {
        writeFileSync(join(dir, 'config.yaml'), 'projects: [\n');
      },
    ],
    [
      'schema-invalid',
      (dir: string) => {
        writeFileSync(join(dir, 'config.yaml'), 'http: { port: -1 }\n');
      },
    ],
  ])('refuses live_config when the live config is %s', (_name, spoil) => {
    const dir = liveConfigDir(osHome);
    spoil(dir);
    const result = refusal({ root, port: 0, env: {}, osHome });
    expect(result?.reason).toBe('live_config');
    expect(result?.message).toContain(join(dir, 'config.yaml'));
  });

  it('refuses live_config when BOARD_HOME holds no config', () => {
    const empty = join(base, 'empty-live');
    mkdirSync(empty);
    const result = refusal({ root, port: 0, env: { BOARD_HOME: empty }, osHome });
    expect(result?.reason).toBe('live_config');
    expect(result?.message).toContain(join(empty, 'config.yaml'));
  });

  it('takes the stand range from the live stand.portRange', () => {
    writeLiveConfig(liveConfigDir(osHome), {
      portRange: { min: 5000, max: 5009 },
      web: { port: 4778, publicOrigin: 'https://{port}.local.example' },
    });
    const port4780 = refusal({ root, port: 4780, env: {}, osHome });
    expect(port4780?.reason).toBe('port_range');
    expect(port4780?.message).toContain('5000 to 5009');
    expect(refusal({ root, port: 5000, env: {}, osHome })).toBeUndefined();
    expect(refusal({ root, port: 0, webPort: 4780, env: {}, osHome })?.reason).toBe('port_range');
    expect(refusal({ root, port: 0, webPort: 5001, env: {}, osHome })).toBeUndefined();
  });

  it('refuses port_range, not port_clash, for web port 0 with API port 0', () => {
    writeLiveConfig(liveConfigDir(osHome), {
      web: { port: 4778, publicOrigin: 'https://{port}.local.example' },
    });
    expect(refusal({ root, port: 0, webPort: 0, env: {}, osHome })?.reason).toBe('port_range');
  });

  it('refuses port_clash for equal API and web ports', () => {
    writeLiveConfig(liveConfigDir(osHome), {
      web: { port: 4778, publicOrigin: 'https://{port}.local.example' },
    });
    expect(refusal({ root, port: 4781, webPort: 4781, env: {}, osHome })?.reason).toBe(
      'port_clash',
    );
  });

  it.each([
    ['no web section', undefined, 'it has none'],
    [
      'a fixed origin',
      { port: 4778, publicOrigin: 'https://board.local.example' },
      'it has a fixed origin',
    ],
  ])('refuses web_origin for a web port when the live config has %s', (_name, web, has) => {
    writeLiveConfig(liveConfigDir(osHome), web === undefined ? {} : { web });
    const result = refusal({ root, port: 0, webPort: 4781, env: {}, osHome });
    expect(result?.reason).toBe('web_origin');
    expect(result?.message).toContain('needs web.publicOrigin with {port}');
    expect(result?.message).toContain(has);
  });

  it('allows a web port when the live publicOrigin has {port}', () => {
    writeLiveConfig(liveConfigDir(osHome), {
      web: { port: 4778, publicOrigin: 'https://{port}.local.example' },
    });
    expect(refusal({ root, port: 0, webPort: 4781, env: {}, osHome })).toBeUndefined();
  });

  it('refuses web_origin when the live publicOrigin gives the web port no valid origin', () => {
    // 4778 fills to port 47780, a valid live origin; 6554 fills to 65540, past 65535.
    writeLiveConfig(liveConfigDir(osHome), {
      portRange: { min: 6550, max: 6560 },
      web: { port: 4778, publicOrigin: 'http://127.0.0.1:{port}0' },
    });
    const result = refusal({ root, port: 0, webPort: 6554, env: {}, osHome });
    expect(result?.reason).toBe('web_origin');
    expect(result?.message).toContain('gives web port 6554 no valid origin');
  });

  it.each([
    'SLACK_BOT_TOKEN',
    'JIRA_API_TOKEN',
    'JIRA_CONFIG_FILE',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'BOARD_TOKEN',
    'SPUR_API_TOKEN',
    'SPUR_WEBHOOK_SECRET',
  ])('refuses external_secrets for %s and names it without its value', (name) => {
    const result = refusal({ root, port: 0, env: { [name]: 'real-value-123' }, osHome });
    expect(result?.reason).toBe('external_secrets');
    expect(result?.message).toContain(`-u ${name}`);
    expect(result?.message).not.toContain('real-value-123');
  });

  it('allows empty credentials and Spur or board names that hold no secret', () => {
    expect(
      refusal({
        root,
        port: 0,
        env: {
          GITHUB_TOKEN: '',
          BOARD_TOKEN: '',
          SPUR_SESSION: 's',
          SPUR_PROJECT: 'p',
          SPUR_CONFIG: '/c',
          BOARD_DAEMON_URL: 'http://127.0.0.1:1',
        },
        osHome,
      }),
    ).toBeUndefined();
  });
});

describe('proxyRefusal', () => {
  it.each([
    [{ NODE_USE_ENV_PROXY: '1' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64 --use-env-proxy' }, []],
    [{}, ['--use-env-proxy']],
    [{ NODE_OPTIONS: '"--use-env-proxy"' }, []],
    [{ NODE_OPTIONS: "--max-old-space-size=64 '--use-env-proxy'" }, []],
    [{ NODE_OPTIONS: '--use-env-\\proxy' }, []],
    [{ NODE_OPTIONS: '--use_env_proxy' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64 --use-env_proxy' }, []],
    [{}, ['--use_env_proxy']],
    [{}, ['--use-env_proxy']],
  ])('refuses env_proxy for %j %j', (env, execArgv) => {
    expect(proxyRefusal({ env, execArgv })?.reason).toBe('env_proxy');
  });

  it.each([
    [{ NODE_USE_ENV_PROXY: '' }, []],
    [{ NODE_OPTIONS: '--max-old-space-size=64' }, ['--conditions=dev']],
  ])('allows %j %j', (env, execArgv) => {
    expect(proxyRefusal({ env, execArgv })).toBeUndefined();
  });
});
