// Vite build plugin: draws the favicon, the app icons and the web app manifest from the Spur mark
// (`src/ds/Logo/mark.ts`) and the design tokens (`src/ds/tokens.css`), emits them at fixed root
// names and links them from index.html. The listener (`packages/core/src/api/web-server.ts`) and
// the package checks (`scripts/package.ts`) list the same names.
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { MARK_FRAME, MARK_LINECAP, MARK_PATH, MARK_VIEWBOX } from '../src/ds/Logo/mark.ts';

export type IconLayout = 'full' | 'safe';

interface Colour {
  readonly hex: string;
  readonly channels: readonly [number, number, number];
}

interface Tokens {
  readonly dark: { readonly bgBase: Colour; readonly textPrimary: Colour };
  readonly light: { readonly bgBase: Colour };
  readonly strokeIcon: number;
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf('}', start);
  if (start === -1 || end === -1) throw new Error(`tokens.css has no ${selector} block.`);
  return css.slice(start, end);
}

function value(source: string, name: string): string {
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(source)?.[1]?.trim();
  if (found === undefined) throw new Error(`tokens.css has no ${name} token.`);
  return found;
}

function colour(source: string, name: string): Colour {
  const hex = value(source, name);
  const digits = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!digits) throw new Error(`${name} is not a six-digit hex colour: ${hex}`);
  const [, r = '', g = '', b = ''] = digits;
  return { hex, channels: [parseInt(r, 16), parseInt(g, 16), parseInt(b, 16)] };
}

/** The dark (`:root`) and light token values the icons and metas use; throws on a missing one. */
export function readTokens(css: string): Tokens {
  const dark = block(css, ':root');
  const light = block(css, ":root[data-theme='light']");
  const strokeIcon = Number(value(dark, '--stroke-icon'));
  if (!Number.isFinite(strokeIcon) || strokeIcon <= 0) throw new Error('Bad --stroke-icon.');
  return {
    dark: {
      bgBase: colour(dark, '--color-bg-base'),
      textPrimary: colour(dark, '--color-text-primary'),
    },
    light: { bgBase: colour(light, '--color-bg-base') },
    strokeIcon,
  };
}

type Segment = readonly [number, number, number, number];

/** The mark as straight segments in viewBox units: the four frame sides, then the path. */
function markSegments(): Segment[] {
  const { x, y, width, height } = MARK_FRAME;
  const segments: Segment[] = [
    [x, y, x + width, y],
    [x + width, y, x + width, y + height],
    [x + width, y + height, x, y + height],
    [x, y + height, x, y],
  ];
  const tokens = MARK_PATH.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)/gi) ?? [];
  let index = 0;
  let cx = 0;
  let cy = 0;
  const number = () => {
    const token = tokens[index++];
    const parsed = Number(token);
    if (token === undefined || !Number.isFinite(parsed)) throw new Error(`Bad mark path number.`);
    return parsed;
  };
  const isNumber = () => index < tokens.length && !/^[a-z]$/i.test(tokens[index] ?? '');
  while (index < tokens.length) {
    const command = tokens[index++] ?? '';
    const relative = command === command.toLowerCase();
    let first = true;
    do {
      let nx = cx;
      let ny = cy;
      switch (command.toUpperCase()) {
        case 'M':
        case 'L':
          nx = number() + (relative ? cx : 0);
          ny = number() + (relative ? cy : 0);
          break;
        case 'H':
          nx = number() + (relative ? cx : 0);
          break;
        case 'V':
          ny = number() + (relative ? cy : 0);
          break;
        default:
          throw new Error(`Unsupported mark path command: ${command}`);
      }
      // A moveto's extra coordinate pairs are linetos.
      if (!(first && command.toUpperCase() === 'M')) segments.push([cx, cy, nx, ny]);
      cx = nx;
      cy = ny;
      first = false;
    } while (isNumber());
  }
  return segments;
}

/** Mark scale per layout: `full` fills the image with the 16-unit box; `safe` fits the stroked
 * frame's corners on the maskable safe circle (radius 0.4 of the image). */
function markScale(layout: IconLayout, stroke: number): number {
  if (layout === 'full') return 1;
  const half = Math.max(MARK_FRAME.width, MARK_FRAME.height) / 2 + stroke / 2;
  return 0.4 / ((half * Math.SQRT2) / MARK_VIEWBOX);
}

const SAMPLES = 4;

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size: number, rgb: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let row = 0; row < size; row++) {
    raw.set(rgb.subarray(row * size * 3, (row + 1) * size * 3), row * (size * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/**
 * An opaque 8-bit RGB PNG of the mark on a full background square. Each segment is a stroked
 * rectangle with square caps; coverage is a 4x4 supersample per pixel, blended in integers.
 */
export function renderIcon(options: {
  size: number;
  layout: IconLayout;
  bg: Colour;
  fg: Colour;
  stroke: number;
}): Uint8Array {
  const { size, bg, fg, stroke } = options;
  const unit = (markScale(options.layout, stroke) * size) / MARK_VIEWBOX;
  const toPixel = (u: number) => size / 2 + (u - MARK_VIEWBOX / 2) * unit;
  const toUnit = (p: number) => MARK_VIEWBOX / 2 + (p - size / 2) / unit;
  const half = stroke / 2;
  const mask = new Uint16Array(size * size);
  for (const [x1, y1, x2, y2] of markSegments()) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const tx = (x2 - x1) / length;
    const ty = (y2 - y1) / length;
    const reach = half * Math.SQRT2;
    const clamp = (p: number) => Math.min(size, Math.max(0, p));
    const left = Math.floor(clamp(toPixel(Math.min(x1, x2) - reach)));
    const right = Math.ceil(clamp(toPixel(Math.max(x1, x2) + reach)));
    const top = Math.floor(clamp(toPixel(Math.min(y1, y2) - reach)));
    const bottom = Math.ceil(clamp(toPixel(Math.max(y1, y2) + reach)));
    for (let py = top; py < bottom; py++) {
      for (let px = left; px < right; px++) {
        let bits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          const dy = toUnit(py + (sy + 0.5) / SAMPLES) - y1;
          for (let sx = 0; sx < SAMPLES; sx++) {
            const dx = toUnit(px + (sx + 0.5) / SAMPLES) - x1;
            const along = dx * tx + dy * ty;
            const across = dy * tx - dx * ty;
            if (Math.abs(across) <= half && along >= -half && along <= length + half) {
              bits |= 1 << (sy * SAMPLES + sx);
            }
          }
        }
        mask[py * size + px] = (mask[py * size + px] ?? 0) | bits;
      }
    }
  }
  const total = SAMPLES * SAMPLES;
  const rgb = new Uint8Array(size * size * 3);
  for (let pixel = 0; pixel < size * size; pixel++) {
    let bits = mask[pixel] ?? 0;
    let covered = 0;
    while (bits) {
      covered += bits & 1;
      bits >>>= 1;
    }
    for (let channel = 0; channel < 3; channel++) {
      const back = bg.channels[channel] ?? 0;
      const front = fg.channels[channel] ?? 0;
      rgb[pixel * 3 + channel] = Math.floor(
        (back * (total - covered) + front * covered + total / 2) / total,
      );
    }
  }
  return encodePng(size, rgb);
}

/** The favicon: a self-contained tile, no `<style>`, so its contrast holds in any tab strip. */
export function faviconSvg(options: { bg: Colour; fg: Colour; stroke: number }): string {
  const { x, y, width, height } = MARK_FRAME;
  const box = String(MARK_VIEWBOX);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">` +
    `<rect width="${box}" height="${box}" fill="${options.bg.hex}"/>` +
    `<g fill="none" stroke="${options.fg.hex}" stroke-width="${String(options.stroke)}" stroke-linecap="${MARK_LINECAP}">` +
    `<rect x="${String(x)}" y="${String(y)}" width="${String(width)}" height="${String(height)}"/>` +
    `<path d="${MARK_PATH}"/></g></svg>\n`
  );
}

const ICONS = [
  { fileName: 'favicon-32.png', size: 32, layout: 'full' },
  { fileName: 'apple-touch-icon.png', size: 180, layout: 'full' },
  { fileName: 'icons/icon-192.png', size: 192, layout: 'full', purpose: 'any' },
  { fileName: 'icons/icon-512.png', size: 512, layout: 'full', purpose: 'any' },
  { fileName: 'icons/icon-512-maskable.png', size: 512, layout: 'safe', purpose: 'maskable' },
] as const;

/** The web app manifest; it takes the dark tokens, the default theme. */
function webManifest(tokens: Tokens): string {
  const colourHex = tokens.dark.bgBase.hex;
  const icons = ICONS.flatMap((icon) =>
    'purpose' in icon
      ? [
          {
            src: `/${icon.fileName}`,
            sizes: `${String(icon.size)}x${String(icon.size)}`,
            type: 'image/png',
            purpose: icon.purpose,
          },
        ]
      : [],
  );
  const manifest = {
    name: 'Spur Board',
    short_name: 'Board',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: colourHex,
    theme_color: colourHex,
    icons,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function headTags(tokens: Tokens): HtmlTagDescriptor[] {
  const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({
    tag: 'link',
    attrs,
    injectTo: 'head',
  });
  const themeColor = (scheme: string, content: string): HtmlTagDescriptor => ({
    tag: 'meta',
    attrs: { name: 'theme-color', media: `(prefers-color-scheme: ${scheme})`, content },
    injectTo: 'head',
  });
  return [
    link({ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' }),
    link({ rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' }),
    link({ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }),
    link({ rel: 'manifest', href: '/manifest.webmanifest' }),
    themeColor('dark', tokens.dark.bgBase.hex),
    themeColor('light', tokens.light.bgBase.hex),
  ];
}

/** Emits the favicon, the app icons and the manifest, and links them from index.html. */
export function appIcons(): Plugin {
  const tokens = () =>
    readTokens(readFileSync(new URL('../src/ds/tokens.css', import.meta.url), 'utf8'));
  return {
    name: 'app-icons',
    apply: 'build',
    transformIndexHtml() {
      return headTags(tokens());
    },
    generateBundle() {
      const read = tokens();
      const { bgBase: bg, textPrimary: fg } = read.dark;
      const stroke = read.strokeIcon;
      this.emitFile({
        type: 'asset',
        fileName: 'favicon.svg',
        source: faviconSvg({ bg, fg, stroke }),
      });
      for (const icon of ICONS) {
        this.emitFile({
          type: 'asset',
          fileName: icon.fileName,
          source: renderIcon({ size: icon.size, layout: icon.layout, bg, fg, stroke }),
        });
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: webManifest(read) });
    },
  };
}
