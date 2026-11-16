import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type {} from '../packages/testkit/src/global-setup.ts';
import { createShellQaServer, shellFixture, shellScenarios } from './web-shell-qa.ts';
import { statusOutputSchema } from '../packages/contracts/src/browser.ts';

const root = join(import.meta.dirname, '../packages/web');
const webAssetsRoot = inject('webAssetsRoot');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const tokens = read('src/ds/tokens.css');
function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}
const dark = declarations(tokens.split(':root {')[1]?.split('}')[0] ?? '');
const light = {
  ...dark,
  ...declarations(tokens.split(":root[data-theme='light'] {")[1]?.split('}')[0] ?? ''),
};
function luminance(hex: string): number {
  const rgb = (hex.match(/[\da-f]{2}/gi) ?? [])
    .map((value) => parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
}
function rawColor(source: string): boolean {
  return /#[\da-f]{3,8}\b|\brgba?\s*\(/i.test(source);
}
// Prototypes may declare a proposed token with a raw value before it joins tokens.css.
function withoutProposed(source: string): string {
  return source.replace(/--proposed-[\w-]+:[^;]+;/g, '');
}
/** Every `@media <query> { ... }` block, braces matched, for one exact query. */
function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  const head = `@media ${query} {`;
  for (let start = css.indexOf(head); start !== -1; start = css.indexOf(head, start + 1)) {
    let depth = 0;
    for (let end = start + head.length - 1; end < css.length; end++) {
      if (css[end] === '{') depth++;
      if (css[end] === '}' && --depth === 0) {
        blocks.push(css.slice(start, end + 1));
        break;
      }
    }
  }
  return blocks;
}
/**
 * Each parenthesised `@media` feature that names a width and is not in `allowed`, whitespace
 * removed; `allowed` entries are compared with whitespace removed too.
 */
function unlistedMediaWidths(css: string, allowed: readonly string[]): string[] {
  const squash = (text: string) => text.replace(/\s+/g, '');
  const listed = new Set(allowed.map(squash));
  return [...css.matchAll(/@media([^{]+)\{/g)].flatMap((media) =>
    [...(media[1] ?? '').matchAll(/\([^()]*\)/g)]
      .map((feature) => squash(feature[0]))
      .filter((feature) => /width/.test(feature) && !listed.has(feature)),
  );
}
describe('web design assets and policy', () => {
  it('preserves every prototype token and inherited scale byte for byte', () => {
    expect(tokens).toBe(
      readFileSync(join(import.meta.dirname, '../design/prototypes/board-v1/tokens.css'), 'utf8'),
    );
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const theme of [dark, light])
      for (const [key, value] of Object.entries(theme)) {
        expect(value, key).not.toBe('');
        expect(value, key).not.toContain('var(');
      }
  });
  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('%s primary/secondary/status text meets 4.5 on base and elevated', (_name, theme) => {
    for (const fg of [
      '--color-text-primary',
      '--color-text-secondary',
      '--color-status-working',
      '--color-status-ready',
      '--color-status-attention',
      '--color-status-error',
    ]) {
      for (const bg of ['--color-bg-base', '--color-bg-elevated']) {
        const a = luminance(theme[fg] ?? '');
        const b = luminance(theme[bg] ?? '');
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('rejects raw color literals outside the token file, including negative fixtures', () => {
    for (const invalid of ['color: #abc;', 'color: #123456;', 'rgb(0, 0, 0)', 'rgba(1,2,3,.5)'])
      expect(rawColor(invalid)).toBe(true);
    for (const file of readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.(?:css|ts|tsx)$/.test(file) && file !== 'ds/tokens.css',
    ))
      expect(rawColor(read(`src/${file}`)), file).toBe(false);
    for (const file of readdirSync(join(root, 'gallery'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((file) => /\.(?:css|ts|tsx)$/.test(file)))
      expect(rawColor(read(`gallery/${file}`)), `gallery/${file}`).toBe(false);
  });
  // Forced colours mode replaces border colours, so a focused field needs an outline as well.
  it.each([
    ['TextArea', '.field:focus'],
    ['TextInput', '.box:focus-within'],
  ])('%s keeps an outline on %s for forced colours mode', (name, selector) => {
    const css = read(`src/ds/${name}/${name}.module.css`);
    const rule = css.split('\n' + selector + ' {')[1]?.split('}')[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/^\s*outline: [^;]*\btransparent\b[^;]*;/m);
    expect(rule).not.toMatch(/outline: none/);
  });
  it('Skeleton stops the pulse under reduced motion', () => {
    const css = read('src/ds/Skeleton/Skeleton.module.css');
    const block = mediaBlocks(css, '(prefers-reduced-motion: reduce)').join('\n');
    expect(block).toMatch(/\.line \{[^}]*animation: none;/);
  });
  it('HoverMenu guards hover styles', () => {
    const css = read('src/ds/HoverMenu/HoverMenu.module.css');
    const guarded = mediaBlocks(css, '(hover: hover)');
    expect(guarded.join('\n')).toContain(':hover');
    let rest = css;
    for (const block of guarded) rest = rest.replace(block, '');
    expect(rest).not.toContain(':hover');
  });
  it.each(['.trigger:focus-visible', '.item:focus-visible'])(
    'HoverMenu %s uses the ds ring',
    (selector) => {
      const css = read('src/ds/HoverMenu/HoverMenu.module.css');
      const rule = css.split('\n' + selector + ' {')[1]?.split('}')[0];
      expect(rule).toBeDefined();
      expect(rule).toContain('outline: var(--width-ring) solid var(--color-status-working);');
      expect(rule).toContain('outline-offset: var(--offset-ring);');
      if (selector === '.item:focus-visible')
        expect(rule).toContain('background: var(--color-row-hover);');
    },
  );
  it('Modal insets its header actions by one ring so a stretched tab ring stays on screen', () => {
    const css = read('src/ds/Modal/Modal.module.css');
    const rule = css.split('\n.actions {')[1]?.split('}')[0];
    expect(rule).toBeDefined();
    expect(rule).toContain('padding-top: calc(var(--width-ring) + var(--offset-ring));');
  });
  it('unlistedMediaWidths reports widths outside the list', () => {
    const allowed = ['(max-width: 760px)'];
    for (const ok of [
      '(max-width: 760px)',
      'screen and (max-width:760px)',
      '(hover: none)',
      '(prefers-reduced-motion: reduce)',
    ])
      expect(unlistedMediaWidths(`@media ${ok} { a { b: c; } }`, allowed), ok).toEqual([]);
    for (const [query, reported] of [
      ['(max-width: 761px)', '(max-width:761px)'],
      ['(min-width: 760px)', '(min-width:760px)'],
      ['(width <= 760px)', '(width<=760px)'],
      ['(hover: none), (max-width: 40em)', '(max-width:40em)'],
    ] as const)
      expect(unlistedMediaWidths(`@media ${query} { a { b: c; } }`, allowed), query).toEqual([
        reported,
      ]);
  });
  it('every @media width in packages/web/src is a listed breakpoint', async () => {
    // scripts/ has no jsx option, so a static import of a .tsx fails typecheck (TS6142).
    const mod: unknown = await import(join(root, 'src/ds/Breakpoints/Breakpoints.tsx'));
    const list: unknown = (mod as { breakpoints?: unknown }).breakpoints;
    expect(list).toBeTypeOf('object');
    const allowed = Object.values(list as Record<string, unknown>);
    expect(allowed.length).toBeGreaterThan(0);
    for (const value of allowed) expect(value).toBeTypeOf('string');
    const queries = allowed as string[];
    let widths = 0;
    for (const file of readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.css'),
    )) {
      const css = read(`src/${file}`);
      widths += unlistedMediaWidths(css, []).length;
      expect(unlistedMediaWidths(css, queries), file).toEqual([]);
    }
    expect(widths).toBeGreaterThan(0);
  });
  it('rejects raw color literals in prototype styles outside --proposed-* declarations', () => {
    expect(rawColor(withoutProposed(':root { --proposed-accent: #ff00aa; }'))).toBe(false);
    expect(
      rawColor(withoutProposed(':root { --proposed-accent: #ff00aa; } a { color: #abc; }')),
    ).toBe(true);
    const prototypes = join(import.meta.dirname, '../design/prototypes');
    const sheets = readdirSync(prototypes)
      .map((slice) => join(prototypes, slice, 'proto.css'))
      .filter((file) => existsSync(file));
    expect(sheets.length).toBeGreaterThan(0);
    for (const file of sheets)
      expect(rawColor(withoutProposed(readFileSync(file, 'utf8'))), file).toBe(false);
  });
  it('ships only local hashed fonts with the original bytes and license', () => {
    const assets = readdirSync(join(webAssetsRoot, 'assets'));
    const css = assets
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(join(webAssetsRoot, 'assets', file), 'utf8'))
      .join('\n');
    expect(css).not.toMatch(/https?:|fonts\.google/i);
    for (const weight of ['Regular', 'Medium', 'Bold']) {
      const font = assets.find((file) =>
        new RegExp(`^JetBrainsMono-${weight}-[\\w-]{8,}\\.woff2$`).test(file),
      );
      expect(font).toBeDefined();
      expect(css).toContain(font);
      expect(readFileSync(join(webAssetsRoot, 'assets', font ?? 'missing'))).toEqual(
        readFileSync(
          join(
            import.meta.dirname,
            `../design/prototypes/board-v1/fonts/JetBrainsMono-${weight}.woff2`,
          ),
        ),
      );
    }
    expect(read('OFL.txt').replace(/[ \t]+$/gm, '')).toBe(
      readFileSync(
        join(import.meta.dirname, '../design/prototypes/board-v1/fonts/OFL.txt'),
        'utf8',
      ).replace(/[ \t]+$/gm, ''),
    );
    expect(existsSync(join(webAssetsRoot, 'index.html'))).toBe(true);
  });
});
describe('shell QA scenarios', () => {
  it.each(shellScenarios)('%s fixture conforms to the production status shape', (name) => {
    expect(statusOutputSchema.safeParse(shellFixture(name)).success).toBe(true);
  });
  it('provides empty, mixed-health long-name and recovery data', () => {
    expect(shellFixture('empty').tasks).toHaveLength(0);
    const mixed = shellFixture('mixed').sources;
    expect(mixed).toHaveLength(12);
    expect(mixed.some((source) => source.blindReason !== null)).toBe(true);
    expect(mixed.some((source) => !source.stale && source.blindReason === null)).toBe(true);
    expect(shellFixture('recovered').tasks).toHaveLength(2);
  });
});

it('serves built assets and controlled status/error/recovery fixtures on loopback', async () => {
  const server = createShellQaServer(webAssetsRoot);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(origin)).status).toBe(200);
    for (const name of ['empty', 'mixed', 'read-error', 'recovered']) {
      expect((await fetch(`${origin}/__qa/scenario/${name}`, { method: 'POST' })).status).toBe(204);
      const response = await fetch(`${origin}/v1/ops/status.get`, { method: 'POST' });
      if (name === 'read-error') expect(response.status).toBe(500);
      else {
        const body = (await response.json()) as { value: unknown };
        expect(statusOutputSchema.parse(body.value)).toEqual(
          shellFixture(name === 'empty' ? 'empty' : name === 'mixed' ? 'mixed' : 'recovered'),
        );
      }
    }
    const events = await fetch(`${origin}/v1/events`);
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body?.getReader();
    if (!reader) throw new Error('Missing fixture event stream');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: hello');
    await reader.cancel();
    const legacy = await fetch(`${origin}/v1/stream`);
    expect(legacy.status).toBe(404);
    expect(await legacy.text()).toBe('');
    await fetch(`${origin}/__qa/scenario/stream-drop`, { method: 'POST' });
    expect((await fetch(`${origin}/v1/events`)).status).toBe(502);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
