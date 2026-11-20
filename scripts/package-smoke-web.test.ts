import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyWebAssets } from './package.ts';
import { verifyServedWeb } from './package-smoke.ts';

// The installed web graph and the listener checks of `package:smoke` (package-smoke.test.ts holds
// the other smoke steps).
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

const appIcons = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png'];
/** An installed web root with one script, the manifest, its three icons and the root icons. */
function servedWeb(index: string, icons: readonly string[] = appIcons) {
  const web = mkdtempSync(join(tmpdir(), 'board-served-web-'));
  mkdirSync(join(web, 'assets'));
  mkdirSync(join(web, 'icons'));
  const manifest = JSON.stringify({ icons: icons.map((src) => ({ src })) });
  const files: Record<string, readonly [string, string]> = {
    '/assets/main-abcdefgh.js': ['console.log("ready");', 'text/javascript; charset=utf-8'],
    '/manifest.webmanifest': [manifest, 'application/manifest+json'],
    ...Object.fromEntries(
      [...appIcons, '/favicon-32.png', '/apple-touch-icon.png'].map((path) => [
        path,
        [`png ${path}`, 'image/png'],
      ]),
    ),
    '/favicon.svg': ['<svg/>', 'image/svg+xml'],
  };
  writeFileSync(join(web, 'index.html'), index);
  for (const [path, [body]] of Object.entries(files)) writeFileSync(join(web, path), body);
  return { web, files };
}
const servedLinks = {
  manifest: manifestLink,
  svg: '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  png: '<link rel="icon" href="/favicon-32.png" type="image/png">',
  touch: '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
};
const servedIndex = `<script src="/assets/main-abcdefgh.js"></script>${Object.values(servedLinks).join('')}`;

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
        ...[
          '/manifest.webmanifest',
          '/favicon.svg',
          '/favicon-32.png',
          '/apple-touch-icon.png',
          ...appIcons,
        ].map((path) => `http://127.0.0.1:4789${path}`),
      ]);
    } else await expect(result).rejects.toThrow(/HTTP 200/);
  });

  // `package:smoke <tarball>` checks no tarball listing, so this is the only check of the set.
  it.each([
    ['no manifest link', { drop: 'manifest' }, /references no manifest/],
    ['no SVG icon link', { drop: 'svg' }, /index links .*, expected/],
    ['no 32px icon link', { drop: 'png' }, /index links .*, expected/],
    ['no touch icon link', { drop: 'touch' }, /index links .*, expected/],
    ['icons: []', { icons: [] }, /manifest icons are none, expected/],
    ['no maskable icon', { icons: appIcons.slice(0, 2) }, /manifest icons .*, expected/],
    ['a png-extra type', { type: 'image/png-extra' }, /HTTP 200 and image\/png/],
    ['a type with parameters', { type: ' Image/PNG ; charset=binary' }, undefined],
  ] as const)('requires the app files and their media type: %s', async (_, variant, error) => {
    const drop = 'drop' in variant ? variant.drop : undefined;
    const index = drop === undefined ? servedIndex : servedIndex.replace(servedLinks[drop], '');
    const { web, files } = servedWeb(index, 'icons' in variant ? variant.icons : appIcons);
    const fetcher: typeof fetch = (url) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const path = href.slice('http://127.0.0.1:4789'.length);
      const [body = '', type = ''] = files[path] ?? [];
      const png = 'type' in variant && type === 'image/png' ? variant.type : type;
      return Promise.resolve(
        path === '/'
          ? new Response(index)
          : new Response(body, { headers: { 'content-type': png } }),
      );
    };
    const result = verifyServedWeb(web, 'http://127.0.0.1:4789', '0.1.0', fetcher);
    if (error === undefined) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(error);
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
