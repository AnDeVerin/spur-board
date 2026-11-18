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
