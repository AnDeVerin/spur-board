import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, inject, it } from 'vitest';
import type {} from '../packages/testkit/src/global-setup.ts';
import {
  faviconSvg,
  readTokens,
  renderIcon,
  type IconLayout,
} from '../packages/web/build/app-icons.ts';
import {
  MARK_FRAME,
  MARK_LINECAP,
  MARK_PATH,
  MARK_VIEWBOX,
} from '../packages/web/src/ds/Logo/mark.ts';

const web = join(import.meta.dirname, '../packages/web');
const dist = inject('webAssetsRoot');
const read = (file: string) => readFileSync(join(web, file), 'utf8');
const tokensCss = read('src/ds/tokens.css');

// The test's own token parse, apart from readTokens.
function token(selector: string, name: string): string {
  const block = tokensCss.split(`${selector} {`)[1]?.split('}')[0] ?? '';
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1];
  if (found === undefined) throw new Error(`no ${name} in ${selector}`);
  return found.trim();
}
const darkBg = token(':root', '--color-bg-base');
const darkFg = token(':root', '--color-text-primary');
const lightBg = token(":root[data-theme='light']", '--color-bg-base');
const stroke = Number(token(':root', '--stroke-icon'));
const channels = (hex: string) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
const bg = { hex: darkBg, channels: channels(darkBg) };
const fg = { hex: darkFg, channels: channels(darkFg) };

const PNGS: { file: string; size: number; layout: IconLayout }[] = [
  { file: 'favicon-32.png', size: 32, layout: 'full' },
  { file: 'apple-touch-icon.png', size: 180, layout: 'full' },
  { file: 'icons/icon-192.png', size: 192, layout: 'full' },
  { file: 'icons/icon-512.png', size: 512, layout: 'full' },
  { file: 'icons/icon-512-maskable.png', size: 512, layout: 'safe' },
];
const APP_FILES = ['favicon.svg', 'manifest.webmanifest', ...PNGS.map((png) => png.file)];

/** A minimal PNG reader for the icons: 8-bit RGB, no interlace, filter 0 on every row. */
function decodePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    types.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // bit depth 8, colour type 2 (RGB, no alpha), compression, filter, interlace 0
      expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  expect(types[0]).toBe('IHDR');
  expect(types.at(-1)).toBe('IEND');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  expect(raw.length).toBe(stride * height);
  for (let row = 0; row < height; row++) expect(raw[row * stride]).toBe(0);
  const pixel = (x: number, y: number) => {
    const start = y * stride + 1 + x * 3;
    return [raw[start], raw[start + 1], raw[start + 2]];
  };
  return { width, height, pixel };
}

describe('app icons', () => {
  it.each(PNGS)('$file is an opaque $size px RGB PNG equal to renderIcon', (png) => {
    const bytes = readFileSync(join(dist, png.file));
    const image = decodePng(bytes);
    expect([image.width, image.height]).toEqual([png.size, png.size]);
    const options = { size: png.size, layout: png.layout, bg, fg, stroke };
    const rendered = renderIcon(options);
    expect(Buffer.from(renderIcon(options)).equals(Buffer.from(rendered))).toBe(true);
    expect(bytes.equals(Buffer.from(rendered))).toBe(true);
  });

  it.each(PNGS.filter((png) => png.layout === 'full'))(
    '$file fills the image with the mark: background corners, mark on the frame top edge',
    (png) => {
      const image = decodePng(readFileSync(join(dist, png.file)));
      const last = png.size - 1;
      for (const [x, y] of [
        [0, 0],
        [last, 0],
        [0, last],
        [last, last],
      ] as const)
        expect(image.pixel(x, y)).toEqual(bg.channels);
      const row = Math.floor((MARK_FRAME.y / MARK_VIEWBOX) * png.size);
      expect(image.pixel(Math.floor(png.size / 2), row)).toEqual(fg.channels);
    },
  );

  it('keeps every mark pixel of the maskable icon inside the safe circle', () => {
    const size = 512;
    const image = decodePng(readFileSync(join(dist, 'icons/icon-512-maskable.png')));
    const limit = 0.4 * size + 1;
    let farthest = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = image.pixel(x, y);
        if (r === bg.channels[0] && g === bg.channels[1] && b === bg.channels[2]) continue;
        const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        expect(distance).toBeLessThanOrEqual(limit);
        farthest = Math.max(farthest, distance);
      }
    }
    // The frame corners reach the circle: the mark is not shrunk further than the safe zone.
    expect(farthest).toBeGreaterThan(0.4 * size - 2);
    expect(image.pixel(size / 2, size / 2)).toEqual(fg.channels);
  });

  it('draws favicon.svg as a self-contained dark tile from mark.ts and the tokens', () => {
    const svg = readFileSync(join(dist, 'favicon.svg'), 'utf8');
    const box = String(MARK_VIEWBOX);
    expect(svg).toContain(`viewBox="0 0 ${box} ${box}"`);
    expect(svg).toContain(`<rect width="${box}" height="${box}" fill="${darkBg}"/>`);
    expect(svg).toContain(
      `<g fill="none" stroke="${darkFg}" stroke-width="${String(stroke)}" stroke-linecap="${MARK_LINECAP}">`,
    );
    const { x, y, width, height } = MARK_FRAME;
    expect(svg).toContain(
      `<rect x="${String(x)}" y="${String(y)}" width="${String(width)}" height="${String(height)}"/>`,
    );
    expect(svg).toContain(`<path d="${MARK_PATH}"/>`);
    expect(svg).not.toMatch(/<style|<script/i);
    expect(svg).toBe(faviconSvg({ bg, fg, stroke }));
  });

  it('pins the Logo stroke to mark.ts and keeps colours out of the icon sources', () => {
    const logo = /\.logo\s*\{([^}]+)\}/.exec(read('src/ds/Logo/Logo.module.css'))?.[1] ?? '';
    expect(logo).toContain('stroke-width: var(--stroke-icon);');
    expect(logo).toContain(`stroke-linecap: ${MARK_LINECAP};`);
    const sources = [
      'src/ds/Logo/mark.ts',
      ...readdirSync(join(web, 'build'), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => `build/${file}`),
    ];
    expect(sources.length).toBeGreaterThan(1);
    for (const file of sources)
      expect(/#[\da-f]{3,8}\b|\brgba?\s*\(/i.test(read(file)), file).toBe(false);
  });

  it('throws when a token the icons need is missing', () => {
    expect(() => readTokens(tokensCss.replace(/--stroke-icon:[^;]+;/, ''))).toThrow(
      /--stroke-icon/,
    );
    expect(() => readTokens(tokensCss.replaceAll('--color-text-primary:', '--x:'))).toThrow(
      /--color-text-primary/,
    );
  });
});

describe('web app manifest and head', () => {
  it('describes the installed app with the dark tokens and three existing icons', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
    const icon = (src: string, size: number, purpose: string) => ({
      src,
      sizes: `${String(size)}x${String(size)}`,
      type: 'image/png',
      purpose,
    });
    expect(manifest).toEqual({
      name: 'Spur Board',
      short_name: 'Board',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: darkBg,
      theme_color: darkBg,
      icons: [
        icon('/icons/icon-192.png', 192, 'any'),
        icon('/icons/icon-512.png', 512, 'any'),
        icon('/icons/icon-512-maskable.png', 512, 'maskable'),
      ],
    });
    for (const { src } of (manifest as { icons: { src: string }[] }).icons)
      expect(existsSync(join(dist, src))).toBe(true);
  });

  it('links the icons, the manifest and the theme colours from index.html', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const tags = (name: string): Record<string, string>[] =>
      [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) =>
        Object.fromEntries(
          [...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? '']),
        ),
      );
    const links = tags('link');
    const metas = tags('meta');
    const icons = links.filter((link) => link.rel === 'icon');
    expect(icons).toEqual([
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' },
      { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
    ]);
    expect(links.filter((link) => link.rel === 'apple-touch-icon')).toEqual([
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ]);
    expect(links.filter((link) => link.rel === 'manifest')).toEqual([
      { rel: 'manifest', href: '/manifest.webmanifest' },
    ]);
    expect(metas.filter((meta) => meta.name === 'theme-color')).toEqual([
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: darkBg },
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: lightBg },
    ]);
    const content = (name: string) => metas.find((meta) => meta.name === name)?.content;
    expect(content('viewport')).toContain('viewport-fit=cover');
    expect(content('mobile-web-app-capable')).toBe('yes');
    expect(content('apple-mobile-web-app-capable')).toBe('yes');
    expect(content('apple-mobile-web-app-title')).toBe('Board');
    expect(content('apple-mobile-web-app-status-bar-style')).toBe('black');
  });

  it('ships only index.html and the app files outside assets/, and no service worker', () => {
    const files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .filter((file) => !file.startsWith('assets') && file !== 'icons')
      .sort();
    expect(files).toEqual(['index.html', ...APP_FILES].sort());
    const scripts = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const file of scripts)
      expect(readFileSync(join(dist, 'assets', file), 'utf8')).not.toContain('serviceWorker');
  });

  it('keeps the theme colour static and the service worker out of the web shell sources', () => {
    const src = join(web, 'src');
    for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(?:tsx?|css)$/.test(file)) continue;
      const source = readFileSync(join(src, file), 'utf8');
      expect(source, file).not.toContain('serviceWorker');
      expect(source, file).not.toContain('theme-color');
    }
  });
});
