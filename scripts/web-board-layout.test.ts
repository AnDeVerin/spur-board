import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('draws the card accent with its dedicated rail token, preserving hairline offsets', () => {
  const css = readFileSync(
    new URL('../packages/web/src/board/Card.module.css', import.meta.url),
    'utf8',
  );
  const rail = /\.card::before\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(rail).toMatch(/width:\s*var\(--size-rail\);/);
  for (const edge of ['top', 'bottom', 'left'])
    expect(rail).toContain(`${edge}: calc(-1 * var(--size-hairline));`);
});

it('centres fitting board columns safely and retains horizontal overflow scrolling', () => {
  const css = readFileSync(
    new URL('../packages/web/src/board/Board.module.css', import.meta.url),
    'utf8',
  );
  const main = /\.main\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(main).toMatch(/justify-content:\s*safe center;/);
  expect(main).toMatch(/overflow-x:\s*auto;/);
});

const inset = (side: string) => `env(safe-area-inset-${side}, 0px)`;
const sides = (top: string, right: string, bottom: string, left: string) =>
  [top, right, bottom, left].join(' ');
const sideMax = (token: string, side: string) => `max(var(${token}), ${inset(side)})`;

/**
 * The declarations of every rule naming `selector`, wide (outside) or narrow (inside the
 * breakpoints.narrow block), merged in source order as the cascade applies them.
 */
function declarations(file: string, selector: string, narrow: boolean): Record<string, string> {
  const css = readFileSync(new URL(`../packages/web/src/${file}`, import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const [wide = '', inside = ''] = css.split('@media (max-width: 760px) {');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?<=^|[{},])\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]+)\\}`, 'g');
  const bodies = [...(narrow ? inside : wide).matchAll(rule)].map((m) => m[1] ?? '');
  expect(bodies.length, `${file} ${selector}`).toBeGreaterThan(0);
  return Object.fromEntries(
    bodies.flatMap((body) =>
      [...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1] ?? '',
        (m[2] ?? '').replace(/\s+/g, ' '),
      ]),
    ),
  );
}

it('keeps the header, its project list, status bar, columns, side panel, modal and popover clear of the safe-area insets', () => {
  const header = (space: string) =>
    sides(inset('top'), sideMax(space, 'right'), '0', sideMax(space, 'left'));
  const bar = (space: string) =>
    sides('0', sideMax(space, 'right'), inset('bottom'), sideMax(space, 'left'));
  const all = sides(inset('top'), inset('right'), inset('bottom'), inset('left'));
  expect(declarations('board/Header.module.css', '.header', false)).toMatchObject({
    height: `calc(var(--size-header) + ${inset('top')})`,
    padding: header('--space-6'),
  });
  expect(declarations('board/Header.module.css', '.header', true).padding).toBe(
    header('--space-3'),
  );
  expect(declarations('board/StatusBar.module.css', '.bar', false)).toMatchObject({
    'min-height': `calc(var(--size-statusbar) + ${inset('bottom')})`,
    padding: bar('--space-6'),
  });
  expect(declarations('board/StatusBar.module.css', '.bar', true).padding).toBe(bar('--space-3'));
  // The scrollport itself is inset, so it clips at the notch; its padding stays the tokens.
  expect(declarations('board/Board.module.css', '.main', false)).toMatchObject({
    'margin-left': inset('left'),
    'margin-right': inset('right'),
    padding: 'var(--space-4) var(--space-6)',
  });
  expect(declarations('board/Board.module.css', '.main', true)).toEqual({
    padding: 'var(--space-3)',
  });
  const panel = 'ds/SidePanel/SidePanel.module.css';
  expect(declarations(panel, '.root', false).inset).toBe(
    sides(
      `calc(var(--size-header) + ${inset('top')})`,
      '0',
      `calc(var(--size-statusbar) + ${inset('bottom')})`,
      '0',
    ),
  );
  expect(declarations(panel, ".surface[data-side='right']", false)['padding-right']).toBe(
    inset('right'),
  );
  expect(declarations(panel, ".surface[data-side='left']", false)['padding-left']).toBe(
    inset('left'),
  );
  expect(declarations(panel, '.surface[data-side]', true).padding).toBe(all);
  const modal = 'ds/Modal/Modal.module.css';
  expect(declarations(modal, '.surface', false)).toMatchObject({
    top: sideMax('--space-8', 'top'),
    bottom: sideMax('--space-8', 'bottom'),
    left: sideMax('--space-6', 'left'),
    right: sideMax('--space-6', 'right'),
  });
  expect(declarations(modal, '.surface', true)).toMatchObject({ inset: '0', padding: all });
  expect(declarations('board/Header.module.css', '.list', true)).toMatchObject({
    left: sideMax('--space-3', 'left'),
    right: sideMax('--space-3', 'right'),
  });
  // Popover width, left clamp and bottom room all read these edges (web-popover.test.ts).
  expect(declarations('ds/Popover/Popover.module.css', '.root', false)).toMatchObject({
    '--popover-edge-left': sideMax('--space-2', 'left'),
    '--popover-edge-right': sideMax('--space-2', 'right'),
    '--popover-edge-bottom': sideMax('--space-2', 'bottom'),
  });
});

it('writes every env() in the web shell as a safe-area inset with a 0px fallback', () => {
  const root = new URL('../packages/web/src/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.(?:css|tsx?)$/.test(file),
  );
  const uses = files.flatMap((file) =>
    [...readFileSync(new URL(file, root), 'utf8').matchAll(/env\([^)]*\)/g)].map((m) => [
      file,
      m[0],
    ]),
  );
  expect(uses.length).toBeGreaterThanOrEqual(5);
  for (const [file, use] of uses)
    expect(use, file).toMatch(/^env\(safe-area-inset-(?:top|right|bottom|left), 0px\)$/);
});

it('gives task blocks a toned rail and band, hides the folded part and right-aligns Collapse', () => {
  const css = readFileSync(
    new URL('../packages/web/src/board/TaskView.module.css', import.meta.url),
    'utf8',
  );
  const rule = (selector: string) =>
    new RegExp(
      `(?:^|[}/])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`,
    ).exec(css)?.[1];
  // Author `display: contents` beats the UA `[hidden]` rule unless this one restores it.
  expect(rule('.rest')).toMatch(/display:\s*contents;/);
  expect(rule('.rest[hidden]')).toMatch(/display:\s*none;/);
  expect(rule('.mine')).toContain('border-left: var(--size-rail) solid var(--color-you-bg);');
  expect(rule('.agent')).toContain(
    'border-left: var(--size-rail) solid var(--color-status-working);',
  );
  expect(rule('.mine .band')).toContain('background: var(--color-fill-attention);');
  expect(rule('.agent .band')).toContain('background: var(--color-fill-working);');
  expect(rule('.band')).toContain('background: var(--color-bg-elevated);');
  expect(rule('.band')).toContain(
    'border-bottom: var(--size-hairline) solid var(--color-border-default);',
  );
  expect(rule('.foot > button')).toMatch(/margin-left:\s*auto;/);
  expect(css).not.toContain('.forYou');
});

it('times the moved tint by --duration-pulse in CSS and in the timer, without it under reduced motion', () => {
  const read = (file: string) =>
    readFileSync(new URL(`../packages/web/src/${file}`, import.meta.url), 'utf8');
  const pulse = /--duration-pulse:\s*([\d.]+)s;/.exec(read('ds/tokens.css'))?.[1];
  const timer = /export const ORDER_TINT_MS = (\d+);/.exec(read('board/ColumnOrder.tsx'))?.[1];
  expect(pulse).toBeDefined();
  expect(Number(timer)).toBe(Number(pulse) * 1000);
  const css = read('board/Card.module.css');
  const [wide = '', reduced = ''] = css.split('@media (prefers-reduced-motion: reduce) {');
  expect(/\.wrap\[data-moved\] > \.card\s*\{([^}]+)\}/.exec(wide)?.[1]).toMatch(
    /animation:\s*moved var\(--duration-pulse\) ease-out;/,
  );
  expect(/\.wrap\[data-moved\] > \.card\s*\{([^}]+)\}/.exec(reduced)?.[1]).toMatch(
    /animation:\s*none;/,
  );
});

it('keeps the drop line above the first card inside the column scrollport', () => {
  // Between cards the line sits in the card gap, centred by its negative margins.
  expect(declarations('board/Columns.module.css', '.dropLine', false)).toMatchObject({
    height: 'var(--size-rail)',
    margin: 'calc(-1 * var(--space-1)) 0',
  });
  // As the first child of .body or .groupCards a negative top margin would clip it.
  expect(declarations('board/Columns.module.css', '.dropLine:first-child', false)).toEqual({
    margin: '0 0 calc(-1 * var(--space-2))',
  });
  expect(declarations('board/Columns.module.css', '.body', false).padding).toBe(
    'calc(2 * var(--space-0-25))',
  );
  expect(declarations('board/Columns.module.css', '.groupCards', false).gap).toBe('var(--space-2)');
});

it('keeps the drop line below the last card inside a scrolled column', () => {
  // Scrolled to the bottom, the last card ends one padding above the scrollport edge. The gap
  // plus the shared negative top margin would put the line below that edge, so as the last
  // child of .body or .groupCards it takes the whole gap back and sits right under the card.
  expect(declarations('board/Columns.module.css', '.dropLine:last-child', false)).toEqual({
    margin: 'calc(-1 * var(--space-2)) 0 0',
  });
  expect(declarations('board/Columns.module.css', '.body', false)).toMatchObject({
    gap: 'var(--space-2)',
    padding: 'calc(2 * var(--space-0-25))',
  });
  expect(declarations('board/Columns.module.css', '.groupCards', false).gap).toBe('var(--space-2)');
});
