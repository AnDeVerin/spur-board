import { verifyWebAssets } from './package.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONS } from '../packages/contracts/src/index.ts';
import { verifyTools } from './package-smoke-mcp.ts';
import {
  command,
  credentialFreeEnv,
  installedVersion,
  installPackage,
  prepareSkillsForSmoke,
  runSmokeSteps,
  smokeInstalled,
  smokeSteps,
  verifySchema,
  verifyServedWeb,
  verifyVersion,
} from './package-smoke.ts';
import { smokeUpgrade } from './upgrade-smoke.ts';

describe('packed smoke steps', () => {
  it('requires both packed skills without replacing their content', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      const reference = join(root, 'skills/spur-board/references/commands.md');
      mkdirSync(join(root, 'skills/spur-board/references'), { recursive: true });
      writeFileSync(
        product,
        '# Real product skill\n\n- `board status` — [details](references/commands.md#board-status)\n',
      );
      writeFileSync(reference, '# Worker commands\n');
      const setup = join(root, 'skills/setup/SKILL.md');
      const setupReference = join(root, 'skills/setup/references/slack.md');
      mkdirSync(join(root, 'skills/setup/references'), { recursive: true });
      writeFileSync(setup, '# Real setup skill\n\n[Slack setup](references/slack.md)\n');
      writeFileSync(setupReference, '# Slack setup\n');
      prepareSkillsForSmoke(root);
      expect(readFileSync(reference, 'utf8')).toBe('# Worker commands\n');
      expect(readFileSync(setup, 'utf8')).toContain('[Slack setup](references/slack.md)');
      expect(readFileSync(setupReference, 'utf8')).toBe('# Slack setup\n');
      prepareSkillsForSmoke(root);
      expect(existsSync(product)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a packed setup skill with a missing linked reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      const reference = join(root, 'skills/spur-board/references/commands.md');
      mkdirSync(join(root, 'skills/spur-board/references'), { recursive: true });
      writeFileSync(product, '- `board status` — [details](references/commands.md#board-status)\n');
      writeFileSync(reference, '# Worker commands\n');
      const setup = join(root, 'skills/setup/SKILL.md');
      mkdirSync(join(root, 'skills/setup'), { recursive: true });
      writeFileSync(setup, '[Slack setup](references/slack.md)\n');
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('Packed setup skill is missing references/slack.md.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing packed setup skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      const reference = join(root, 'skills/spur-board/references/commands.md');
      mkdirSync(join(root, 'skills/spur-board/references'), { recursive: true });
      writeFileSync(product, '- `board status` — [details](references/commands.md#board-status)\n');
      writeFileSync(reference, '# Worker commands\n');
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('Packed setup skill spur-board-setup is missing.');
      expect(existsSync(join(root, 'skills/setup/SKILL.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to replace a missing packed product skill with a fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('Packed product skill spur-board is missing.');
      expect(existsSync(join(root, 'skills/setup/SKILL.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a packed skill with a missing command page', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-packed-skills-'));
    try {
      const product = join(root, 'skills/spur-board/SKILL.md');
      mkdirSync(join(root, 'skills/spur-board'), { recursive: true });
      writeFileSync(product, '- `board status` — [details](references/commands.md#board-status)\n');
      expect(() => {
        prepareSkillsForSmoke(root);
      }).toThrow('missing references/commands.md');
      expect(existsSync(join(root, 'skills/setup/SKILL.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the staged checks in one ordered list', () => {
    expect(smokeSteps.map((step) => step.name)).toEqual([
      'version',
      'web assets',
      'daemon',
      'web HTTP',
      'schema',
      'status',
      'mcp',
      'service unit',
      'skills install',
    ]);
    expect(smokeSteps.filter((step) => step.baseline).map((step) => step.name)).toEqual([
      'version',
      'daemon',
      'schema',
      'mcp',
    ]);
  });

  it('fails for a broken daemon or schema step', async () => {
    const context = { binary: '', expectedVersion: '', env: {}, home: '', packageRoot: '' };
    await expect(
      runSmokeSteps(context, [
        { name: 'daemon', run: () => Promise.reject(new Error('daemon failed')) },
      ]),
    ).rejects.toThrow('daemon failed');
    expect(() => {
      verifySchema({ code: 1, stdout: '', stderr: 'schema failed' });
    }).toThrow('schema failed');
    expect(() => {
      verifySchema({ code: 0, stdout: '{}', stderr: '' });
    }).toThrow('invalid catalog');
  });

  it('holds the candidate to the catalog and a previous release only to named tools', () => {
    const catalog = OPERATIONS.map((op) => ({ name: op.mcp.name }));
    const previous = catalog.slice(0, -2);
    expect(verifyTools(catalog, true)).toBe(OPERATIONS.length);
    expect(() => verifyTools(previous, true)).toThrow('differ from catalog');
    expect(verifyTools(previous, false)).toBe(OPERATIONS.length - 2);
    expect(() => verifyTools([], false)).toThrow('unnamed tools');
    expect(() => verifyTools([{ name: 1 }], false)).toThrow('unnamed tools');
    expect(() => verifyTools(undefined, false)).toThrow('did not list tools');
  });

  it('compares the packed binary version with its manifest', () => {
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.0.0\n', stderr: '' }, '0.1.0');
    }).toThrow();
    expect(() => {
      verifyVersion({ code: 0, stdout: '0.1.0\n', stderr: '' }, '0.1.0');
    }).not.toThrow();
  });

  it('terminates a hung packed command before smoke can continue', async () => {
    const started = performance.now();
    await expect(
      command(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {},
        50,
      ),
    ).rejects.toThrow('timed out');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('closes the fake API when the installed binary is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-missing-bin-'));
    try {
      await expect(
        smokeInstalled(join(root, 'missing-board'), join(root, 'home'), '0.1.0'),
      ).rejects.toThrow('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('credentialFreeEnv', () => {
  it('drops runner tokens, npm config and board credentials and keeps the rest', () => {
    const env = credentialFreeEnv({
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
      ACTIONS_RUNTIME_TOKEN: 'x',
      GITHUB_ENV: 'x',
      'npm_config_//registry.npmjs.org/:_authToken': 'x',
      SLACK_BOT_TOKEN: 'x',
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
    });
  });

  it('reads the installed package version under a prefix', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'board-installed-version-'));
    try {
      mkdirSync(join(prefix, 'node_modules/spur-board'), { recursive: true });
      writeFileSync(
        join(prefix, 'node_modules/spur-board/package.json'),
        JSON.stringify({ name: 'spur-board', version: '9.9.9' }),
      );
      expect(installedVersion(prefix)).toBe('9.9.9');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});

describe('credential-free spawn env', () => {
  const runnerNames = [
    'GITHUB_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'npm_config__authToken',
  ];
  let root = '';

  function setup(name: string, script: string): string {
    root = mkdtempSync(join(tmpdir(), 'board-spawn-env-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, name), `#!/bin/sh\nenv > "$SMOKE_ENV_DUMP"\n${script}`, {
      mode: 0o755,
    });
    const dump = join(root, 'env-dump');
    vi.stubEnv('GITHUB_TOKEN', 'sentinel-gh');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'sentinel-oidc-url');
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'sentinel-oidc');
    vi.stubEnv('npm_config__authToken', 'sentinel-npm');
    vi.stubEnv('BOARD_TOKEN', 'sentinel-board');
    vi.stubEnv('SMOKE_ENV_DUMP', dump);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    return join(bin, name);
  }

  function dumped(): string[] {
    const lines = readFileSync(join(root, 'env-dump'), 'utf8').split('\n');
    expect(lines.filter((line) => line.includes('sentinel-'))).toEqual([]);
    for (const name of runnerNames) {
      expect(lines.filter((line) => line.startsWith(`${name}=`))).toEqual([]);
    }
    return lines;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('gives npm install no runner credentials', () => {
    setup('npm', 'exit 0\n');
    installPackage('spur-board@0.1.0', join(root, 'prefix'));
    dumped();
  });

  it('gives npm view no runner credentials', async () => {
    setup('npm', 'echo "npm error code E404 https://registry.npmjs.org/spur-board" >&2\nexit 1\n');
    await expect(smokeUpgrade()).resolves.toBe('skipped');
    dumped();
  });

  it('gives the installed board binary no runner credentials', async () => {
    const board = setup('board', 'exit 1\n');
    await expect(smokeInstalled(board, join(root, 'home'), '0.1.0')).rejects.toThrow(
      '--version failed',
    );
    dumped();
  });

  it('gives the MCP handshake no runner credentials and an empty board token', async () => {
    const board = setup('board', "echo '{}'\nexec sleep 5\n");
    const context = {
      binary: board,
      expectedVersion: '0.1.0',
      env: {},
      home: root,
      packageRoot: root,
    };
    await expect(
      runSmokeSteps(
        context,
        smokeSteps.filter((step) => step.name === 'mcp'),
      ),
    ).rejects.toThrow('non-JSON-RPC');
    expect(dumped()).toContain('BOARD_TOKEN=');
  });
});

describe('installPackage tarball argument', () => {
  let root = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['release-artifacts/spur-board-0.1.0.tgz', resolve('release-artifacts/spur-board-0.1.0.tgz')],
    ['spur-board@0.1.0', 'spur-board@0.1.0'],
    ['file:./candidate.tgz', 'file:./candidate.tgz'],
  ])('passes %s to npm install as %s', (packageRef, expected) => {
    root = mkdtempSync(join(tmpdir(), 'board-install-ref-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$NPM_ARGS_DUMP"\n`, {
      mode: 0o755,
    });
    vi.stubEnv('NPM_ARGS_DUMP', join(root, 'args'));
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    installPackage(packageRef, join(root, 'prefix'));
    const args = readFileSync(join(root, 'args'), 'utf8').trimEnd().split('\n');
    expect(args).toEqual([
      'install',
      '--prefix',
      join(root, 'prefix'),
      expected,
      '--no-audit',
      '--no-fund',
    ]);
  });
});

const manifestLink = '<link rel="manifest" href="/manifest.webmanifest">';
const webManifest = JSON.stringify({ icons: [{ src: '/icons/icon-192.png' }] });

describe('installed web smoke', () => {
  it.each([
    'index.html',
    'assets/app-abcdefgh.js',
    'assets/app-abcdefgh.css',
    'assets/font-abcdefgh.woff2',
    'manifest.webmanifest',
    'icons/icon-192.png',
    '../OFL.txt',
  ])('rejects missing %s', (missing) => {
    const root = mkdtempSync(join(tmpdir(), 'board-smoke-web-'));
    const web = join(root, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    mkdirSync(join(web, 'icons'));
    writeFileSync(join(root, 'OFL.txt'), 'license');
    writeFileSync(
      join(web, 'index.html'),
      `<script src="/assets/app-abcdefgh.js"></script><link href="/assets/app-abcdefgh.css">${manifestLink}`,
    );
    writeFileSync(join(web, 'assets/app-abcdefgh.js'), 'app');
    writeFileSync(
      join(web, 'assets/app-abcdefgh.css'),
      '@font-face {src:url(./font-abcdefgh.woff2)}',
    );
    writeFileSync(join(web, 'assets/font-abcdefgh.woff2'), 'font');
    writeFileSync(join(web, 'manifest.webmanifest'), webManifest);
    writeFileSync(join(web, 'icons/icon-192.png'), 'png');
    expect(() => {
      verifyWebAssets(web, join(root, 'OFL.txt'));
    }).not.toThrow();
    rmSync(join(web, missing));
    expect(() => {
      verifyWebAssets(web, join(root, 'OFL.txt'));
    }).toThrow(/Missing web asset|license/);
  });
});

/** An installed web root with one script, the manifest, one manifest icon and the SVG favicon. */
function servedWeb(index: string) {
  const web = mkdtempSync(join(tmpdir(), 'board-served-web-'));
  mkdirSync(join(web, 'assets'));
  mkdirSync(join(web, 'icons'));
  const files: Record<string, readonly [string, string]> = {
    '/assets/main-abcdefgh.js': ['console.log("ready");', 'text/javascript; charset=utf-8'],
    '/manifest.webmanifest': [webManifest, 'application/manifest+json'],
    '/icons/icon-192.png': ['png-192', 'image/png'],
    '/favicon.svg': ['<svg/>', 'image/svg+xml'],
  };
  writeFileSync(join(web, 'index.html'), index);
  for (const [path, [body]] of Object.entries(files)) writeFileSync(join(web, path), body);
  return { web, files };
}
const servedIndex = `<script src="/assets/main-abcdefgh.js"></script>${manifestLink}<link rel="icon" href="/favicon.svg" type="image/svg+xml">`;

describe('installed web HTTP smoke', () => {
  it.each([
    'healthy',
    'page-status',
    'asset-status',
    'page-body',
    'asset-body',
    'manifest-type',
    'icon-status',
    'icon-body',
    'favicon-type',
  ])('requires actual HTTP 200, the type and installed bytes: %s', async (mode) => {
    const { web, files } = servedWeb(servedIndex);
    const calls: string[] = [];
    const fetcher: typeof fetch = (url, init) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push(href);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const path = href.slice('http://127.0.0.1:4789'.length);
      if (path === '/')
        return Promise.resolve(
          new Response(mode === 'page-body' ? 'wrong page' : servedIndex, {
            status: mode === 'page-status' ? 503 : 200,
          }),
        );
      const [body = '', type = ''] = files[path] ?? [];
      const wrong =
        (mode === 'asset-body' && path.startsWith('/assets/')) ||
        (mode === 'icon-body' && path === '/icons/icon-192.png');
      const missing =
        (mode === 'asset-status' && path.startsWith('/assets/')) ||
        (mode === 'icon-status' && path === '/icons/icon-192.png');
      const typed =
        (mode === 'manifest-type' && path === '/manifest.webmanifest') ||
        (mode === 'favicon-type' && path === '/favicon.svg')
          ? 'text/html; charset=utf-8'
          : type;
      return Promise.resolve(
        new Response(wrong ? servedIndex : body, {
          status: missing ? 404 : 200,
          headers: { 'content-type': typed },
        }),
      );
    };
    const result = verifyServedWeb(web, 'http://127.0.0.1:4789', '0.1.0', fetcher);
    if (mode === 'healthy') {
      await expect(result).resolves.toBeUndefined();
      expect(calls).toEqual([
        'http://127.0.0.1:4789/',
        'http://127.0.0.1:4789/assets/main-abcdefgh.js',
        'http://127.0.0.1:4789/manifest.webmanifest',
        'http://127.0.0.1:4789/icons/icon-192.png',
        'http://127.0.0.1:4789/favicon.svg',
      ]);
    } else await expect(result).rejects.toThrow(/HTTP 200/);
  });

  it('requires the index to link the manifest', async () => {
    const index = '<script src="/assets/main-abcdefgh.js"></script>';
    const { web } = servedWeb(index);
    const fetcher: typeof fetch = (url) =>
      Promise.resolve(
        new Response(url === 'http://127.0.0.1:4789/' ? index : 'console.log("ready");'),
      );
    await expect(verifyServedWeb(web, 'http://127.0.0.1:4789', '0.1.0', fetcher)).rejects.toThrow(
      'Installed web index references no manifest.',
    );
  });

  it.each(['stamped', 'unstamped', 'other-version'])(
    'expects the version meta after <head>: %s',
    async (mode) => {
      const index = `<html><head></head>${servedIndex}</html>`;
      const { web, files } = servedWeb(index);
      const meta = (version: string) => `<meta name="board-version" content="${version}">`;
      const page =
        mode === 'unstamped'
          ? index
          : index.replace('<head>', `<head>${meta(mode === 'stamped' ? '0.1.0' : '0.2.0')}`);
      const fetcher: typeof fetch = (url) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        const path = href.slice('http://127.0.0.1:4789'.length);
        const [body = '', type = ''] = files[path] ?? [];
        return Promise.resolve(
          path === '/'
            ? new Response(page)
            : new Response(body, { headers: { 'content-type': type } }),
        );
      };
      const result = verifyServedWeb(web, 'http://127.0.0.1:4789', '0.1.0', fetcher);
      if (mode === 'stamped') await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(/HTTP 200/);
    },
  );
});
