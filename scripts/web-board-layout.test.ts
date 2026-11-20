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
  const columns = (space: string) =>
    sides(`var(${space})`, sideMax(space, 'right'), `var(${space})`, sideMax(space, 'left'));
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
  expect(declarations('board/Board.module.css', '.main', false).padding).toBe(
    sides(
      'var(--space-4)',
      sideMax('--space-6', 'right'),
      'var(--space-4)',
      sideMax('--space-6', 'left'),
    ),
  );
  expect(declarations('board/Board.module.css', '.main', true).padding).toBe(columns('--space-3'));
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
