import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type {} from '../packages/testkit/src/global-setup.ts';

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
function rgb(color: string): number[] {
  const hex = /^#[\da-f]{6}$/i.test(color);
  const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(color);
  const values = hex ? color.slice(1).match(/../g) : rgba?.slice(1);
  if (!values) throw new Error(`Unsupported color: ${color}`);
  return values.map((value) => (hex ? parseInt(value, 16) : Number(value)));
}
function luminance(color: string | number[]): number {
  const channels = (typeof color === 'string' ? rgb(color) : color)
    .map((value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
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
/** Every innermost `selector { body }` rule, comments removed, selector trimmed. */
function cssRules(css: string): { selector: string; body: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }),
  );
}
/** The token the first of `selectors` in `file` binds to `property`; '' when none binds one. */
function bound(file: string, property: string, ...selectors: string[]): string {
  const rules = cssRules(read(file));
  const pattern = new RegExp(`(?<![\\w-])${property}: var\\((--[\\w-]+)\\);`);
  for (const selector of selectors) {
    const token = rules.find((rule) => rule.selector === selector)?.body.match(pattern)?.[1];
    if (token !== undefined) return token;
  }
  return '';
}
const ring = 'var(--width-ring) solid var(--color-status-working)';
// Text fields show focus with their border; the transparent outline is for forced colours mode.
const forcedColoursRing = 'var(--width-ring) solid transparent';
const forcedColoursFields = new Set([
  'src/ds/TextInput/TextInput.module.css .box:focus-within',
  'src/ds/TextArea/TextArea.module.css .field:focus',
]);
// The TextInput box draws its focus cue, so the input inside it drops its own outline.
const outlineNone = new Set(['src/ds/TextInput/TextInput.module.css .input']);
/** Each `outline*` declaration in `css` that is not the one ds focus ring. */
function outlineViolations(file: string, css: string): string[] {
  return cssRules(css).flatMap(({ selector, body }) =>
    [...body.matchAll(/(outline(?:-[\w-]+)?)\s*:\s*([^;]+);/g)]
      .filter(([, property, raw]) => {
        const value = (raw ?? '').trim();
        if (property === 'outline-offset') return value !== 'var(--offset-ring)';
        if (property !== 'outline') return true;
        if (value === ring) return false;
        if (value === forcedColoursRing) return !forcedColoursFields.has(`${file} ${selector}`);
        if (value === 'none') return !outlineNone.has(`${file} ${selector}`);
        return true;
      })
      .map(([declaration]) => `${file} ${selector}: ${declaration}`),
  );
}
describe('web design assets and policy', () => {
  it.each(Object.entries({ dark, light }))('%s text meets AA contrast', (_name, theme) => {
    const bindings = (file: string) => {
      const rules = cssRules(read(file));
      return (selector: string, property: string) =>
        rules
          .find((rule) => rule.selector === selector)
          ?.body.match(new RegExp(`\\b${property}: var\\((--[\\w-]+)\\);`))?.[1] ?? '';
    };
    const binding = bindings('src/ds/Banner/Banner.module.css');
    const pairs: [string, string | number[], string?][] = [];
    for (const variant of ['error', 'warning', 'info']) {
      const selector = `.root[data-variant='${variant}']`;
      const main = binding(`${selector} .main`, 'color') || binding(selector, 'color');
      const fill = rgb(theme[binding(selector, 'background')] ?? '');
      const alpha = fill[3] ?? 1;
      // Composite in sRGB, retaining fractional channels before luminance conversion.
      const base = rgb(theme['--color-bg-base'] ?? '');
      const background = base.map((v, i) => (fill[i] ?? 0) * alpha + v * (1 - alpha));
      for (const token of [main, binding('.detail', 'color')]) pairs.push([token, background]);
    }
    // Task view block bands (#687): meta text on the operator, agent and closed band fills.
    const taskBinding = bindings('src/board/TaskView.module.css');
    for (const selector of ['.mine .band', '.agent .band', '.band']) {
      const fill = rgb(theme[taskBinding(selector, 'background')] ?? '');
      const alpha = fill[3] ?? 1;
      // Tinted fills replace the elevated band background and sit on the page.
      const base = rgb(theme['--color-bg-base'] ?? '');
      const background = base.map((v, i) => (fill[i] ?? 0) * alpha + v * (1 - alpha));
      const meta = taskBinding(selector, 'color') || taskBinding('.band', 'color');
      pairs.push([meta, background, `TaskView ${selector} ${meta}`]);
    }
    for (const [kind, names] of [
      ['text', ['primary', 'secondary', 'tertiary']],
      ['status', ['working', 'ready', 'attention', 'error']],
    ] as const)
      for (const name of names)
        for (const bg of ['base', 'elevated'])
          pairs.push([`--color-${kind}-${name}`, theme[`--color-bg-${bg}`] ?? '']);
    for (const [token, background, label] of pairs) {
      const a = luminance(theme[token] ?? '');
      const b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(ratio, label ?? token).toBeGreaterThanOrEqual(4.5);
    }
  });
  // Board text on tone fills (#754): the card status cells on the card, and the text of a tinted
  // Approvals row in the task view. A new tone or text part is one row of the table.
  const card = 'src/board/Card.module.css';
  const approvals = 'src/board/TaskApprovals.module.css';
  const cellTone = (tone: string) => `.cell[data-tone='${tone}']`;
  const tonePairs: [label: string, text: string, fill: string, base: string][] = [
    ...['neutral', 'ok', 'pend', 'bad'].flatMap((tone) => {
      const fill = bound(card, 'background', cellTone(tone));
      return [
        [`card ${tone} cell`, bound(card, 'color', cellTone(tone), '.cell'), fill],
        [`card ${tone} cell suffix`, bound(card, 'color', '.suffix'), fill],
      ].map(([label = '', text = '', on = '']): [string, string, string, string] => [
        label,
        text,
        on,
        '--color-bg-elevated',
      ]);
    }),
    // A loud row is not quiet: its text reads the same at rest as on hover.
    ...[
      ['what', bound(approvals, 'color', '.what')],
      ['sha', bound(approvals, 'color', '.sha')],
      ['PR ref', bound(approvals, 'color', '.row[data-loud] .ref', '.ref')],
      ['not watched entry chip', bound('src/ds/Chip/Chip.module.css', 'color', '.chip')],
      // The author and the icon inherit the task view's primary text.
      ['author', '--color-text-primary'],
    ].map(([label = '', text = '']): [string, string, string, string] => [
      `loud approvals row ${label}`,
      text,
      bound(approvals, 'background', '.row[data-loud]'),
      '--color-bg-base',
    ]),
  ];
  it.each(
    Object.entries({ dark, light }).flatMap(([name, theme]) =>
      tonePairs.map((pair) => [name, ...pair, theme] as const),
    ),
  )('%s %s text meets 4.5:1 on its fill', (_name, _label, text, fill, base, theme) => {
    expect(text, 'text token').not.toBe('');
    const under = rgb(theme[base] ?? '');
    const [r = 0, g = 0, b = 0, alpha = 1] = fill === '' ? under : rgb(theme[fill] ?? '');
    // Composite in sRGB, retaining fractional channels before luminance conversion.
    const background = under.map((v, i) => ([r, g, b][i] ?? 0) * alpha + v * (1 - alpha));
    const [x, y] = [luminance(theme[text] ?? ''), luminance(background)];
    expect((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
  it('lets each free text of an Approvals row break within the row', () => {
    const rules = cssRules(read(approvals));
    for (const part of ['.ref', '.author'])
      expect(
        rules.some(
          ({ selector, body }) =>
            selector.split(/\s*,\s*/).includes(part) && /overflow-wrap: anywhere;/.test(body),
        ),
        part,
      ).toBe(true);
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
  it('Tabs keeps the selected underline tab bright on hover', () => {
    // A selector's weight: its classes, attributes and pseudo-classes; `:where()` counts none.
    const weight = (selector: string) => {
      let rest = selector;
      for (let at = rest.indexOf(':where('); at !== -1; at = rest.indexOf(':where(')) {
        let depth = 0;
        let end = at + ':where'.length;
        do {
          if (rest[end] === '(') depth += 1;
          if (rest[end] === ')') depth -= 1;
          end += 1;
        } while (depth > 0 && end < rest.length);
        rest = rest.slice(0, at) + rest.slice(end);
      }
      return (rest.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    };
    const selectors = cssRules(read('src/ds/Tabs/Tabs.module.css')).map((rule) => rule.selector);
    const hover = selectors.find((selector) => selector.startsWith('.underline .tab:hover'));
    expect(hover).toBeDefined();
    expect(selectors).toContain(".underline .tab[aria-selected='true']");
    // The selected rule comes later, so equal weight lets it win over hover.
    expect(weight(hover ?? '')).toBeLessThanOrEqual(
      weight(".underline .tab[aria-selected='true']"),
    );
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
  it('a layer header puts its actions at the right, directly before Close', () => {
    const margins = cssRules(read('src/ds/Scrim/Scrim.module.css')).flatMap(({ selector, body }) =>
      [...body.matchAll(/margin-left\s*:\s*([^;]+);/g)].map((m) => `${selector}: ${m[1] ?? ''}`),
    );
    expect(margins).toEqual(['.actions: auto', '.close: auto', '.actions + .close: 0']);
  });
  it('a layer body keeps its outward ring inside the surface and its content in place', () => {
    const one = 'calc(var(--width-ring) + var(--offset-ring))';
    const rules = (file: string) =>
      cssRules(read(file))
        .filter(({ selector }) => selector === '.body')
        .map(({ body }) => body.replace(/\s+/g, ' '));
    expect(rules('src/ds/Scrim/Scrim.module.css')).toEqual([
      expect.stringContaining(`margin: 0 ${one} ${one};`),
    ]);
    const less = (space: string) => `calc(var(${space}) - var(--width-ring) - var(--offset-ring))`;
    expect(rules('src/ds/Modal/Modal.module.css')).toEqual([
      expect.stringContaining(`padding: ${one} ${less('--space-4')} ${less('--space-4')};`),
      expect.stringContaining(`padding: ${one} ${less('--space-3')} ${less('--space-3')};`),
    ]);
    expect(rules('src/ds/SidePanel/SidePanel.module.css')).toEqual([
      expect.stringContaining(`padding: var(--space-4) ${less('--space-4')} ${less('--space-4')};`),
    ]);
  });
  it('ThemeSwitch lifts a focused item so the next item cannot cover its ring', () => {
    const lifts = cssRules(read('src/ds/ThemeSwitch/ThemeSwitch.module.css')).filter(
      ({ selector, body }) =>
        selector.split(',').some((part) => part.trim() === '.item:focus-visible') &&
        body.includes('position: relative;') &&
        body.includes('z-index: var(--z-focus);'),
    );
    expect(lifts).toHaveLength(1);
    expect(dark['--z-focus']).toBe('1');
  });
  it('stacks menus above panels and below modals', () => {
    // A menu kept live beside an open panel, such as the status bar theme menu, must open over
    // it; a modal covers both.
    const z = (name: string) => Number(dark[name]);
    expect(z('--z-panel')).toBeLessThan(z('--z-menu'));
    expect(z('--z-menu')).toBeLessThan(z('--z-modal'));
  });
  it('outlineViolations accepts only the ds ring, including negative fixtures', () => {
    const rule = (selector: string, body: string) => `${selector} {\n  ${body}\n}\n`;
    for (const ok of [
      rule('.a:focus-visible', 'outline: var(--width-ring) solid var(--color-status-working);'),
      rule('.a:focus-visible', 'outline-offset: var(--offset-ring);'),
      '/* outline: 2px solid red; */',
    ])
      expect(outlineViolations('x.css', ok), ok).toEqual([]);
    for (const bad of [
      rule('.a:focus-visible', 'outline: 2px solid var(--color-accent-violet);'),
      rule('.a:focus-visible', 'outline-offset: 2px;'),
      rule('.a:focus-visible', 'outline-color: var(--color-status-working);'),
      rule('.a', 'outline: var(--width-ring) solid transparent;'),
      rule('.a:focus-visible', 'outline: var(--width-ring) solid transparent;'),
      rule('.a:focus-within', 'outline: var(--width-ring) solid transparent;'),
      rule('.box:focus-within', 'outline: var(--width-ring) solid transparent;'),
      rule('.input', 'outline: none;'),
      rule('.a:focus', 'outline: 0;'),
    ])
      expect(outlineViolations('x.css', bad), bad).toHaveLength(1);
    for (const [file, ok] of [
      ['src/ds/TextInput/TextInput.module.css', rule('.input', 'outline: none;')],
      [
        'src/ds/TextInput/TextInput.module.css',
        rule('.box:focus-within', 'outline: var(--width-ring) solid transparent;'),
      ],
      [
        'src/ds/TextArea/TextArea.module.css',
        rule('.field:focus', 'outline: var(--width-ring) solid transparent;'),
      ],
    ] as const)
      expect(outlineViolations(file, ok), ok).toEqual([]);
  });
  it('every outline in the web sources and the gallery is the ds ring', () => {
    const files = [
      ...readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).map(
        (file) => `src/${file}`,
      ),
      ...readdirSync(join(root, 'gallery'), { recursive: true, encoding: 'utf8' }).map(
        (file) => `gallery/${file}`,
      ),
    ].filter((file) => file.endsWith('.css'));
    expect(files).toContain('gallery/Gallery.module.css');
    expect(files.flatMap((file) => outlineViolations(file, read(file)))).toEqual([]);
  });
  it('no web source outside src/ds/ declares an outline; screens take the ds focusRing', () => {
    const files = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .map((file) => `src/${file}`)
      .filter((file) => file.endsWith('.css') && !file.startsWith('src/ds/'));
    expect(files).toContain('src/App.module.css');
    const outlines = files.flatMap((file) =>
      cssRules(read(file)).flatMap(({ selector, body }) =>
        [...body.matchAll(/\boutline(?:-[\w-]+)?\s*:[^;]*;/g)].map(
          ([declaration]) => `${file} ${selector}: ${declaration}`,
        ),
      ),
    );
    expect(outlines).toEqual([]);
  });
  it('every ds component with a focus outline has a Focused example', () => {
    const folders = readdirSync(join(root, 'src/ds'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const focusable = folders.filter((name) => {
      const file = `src/ds/${name}/${name}.module.css`;
      return (
        existsSync(join(root, file)) &&
        cssRules(read(file)).some(
          (rule) => rule.selector.includes(':focus') && /\boutline\s*:/.test(rule.body),
        )
      );
    });
    expect(focusable.sort()).toEqual([
      'Button',
      'CollapsibleSection',
      'FocusRing',
      'HoverMenu',
      'IconButton',
      'Modal',
      'SidePanel',
      'Tabs',
      'TextArea',
      'TextInput',
      'ThemeSwitch',
    ]);
    for (const name of focusable)
      expect(read(`src/ds/${name}/${name}.examples.tsx`), name).toContain(
        'export function Focused(',
      );
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
