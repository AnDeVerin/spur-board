import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('centres fitting board columns safely and retains horizontal overflow scrolling', () => {
  const css = readFileSync(
    new URL('../packages/web/src/board/Board.module.css', import.meta.url),
    'utf8',
  );
  const main = /\.main\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(main).toMatch(/justify-content:\s*safe center;/);
  expect(main).toMatch(/overflow-x:\s*auto;/);
});
