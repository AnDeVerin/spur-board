import { readFileSync } from 'node:fs';
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
