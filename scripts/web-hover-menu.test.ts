import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Node-side, like web.test.ts: web tests may not import node:fs, and Vitest reads CSS through
// a query as an empty string. The rendered behaviour is in packages/web/test/hover-menu*.test.ts;
// the hover guard and the focus rings are in web.test.ts.
const css = readFileSync(
  join(import.meta.dirname, '../packages/web/src/ds/HoverMenu/HoverMenu.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the one top-level rule with exactly this selector. */
function rule(selector: string): string[] {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, head]) => head?.trim() === selector)
    .map(([, , body]) => body ?? '');
  expect(bodies, selector).toHaveLength(1);
  return (bodies[0] ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

describe('HoverMenu styles', () => {
  it('opening downward sizes the root to the trigger and puts the menu under it', () => {
    expect(rule(".root[data-opens='down']")).toEqual(['height: auto']);
    expect(rule(".root[data-opens='down'] .menu")).toEqual(['top: 100%', 'bottom: auto']);
  });
  it.each(['.cause', '.note'])('%s wraps at the menu width and never widens it', (selector) => {
    expect(rule(selector)).toEqual(
      expect.arrayContaining(['box-sizing: border-box', 'width: 0', 'min-width: 100%']),
    );
  });
  it('a disabled item shows not-allowed, dims its content and takes no hover', () => {
    expect(rule(".item[aria-disabled='true']")).toEqual(['cursor: not-allowed']);
    expect(rule(".item[aria-disabled='true'] > *")).toEqual(['opacity: var(--opacity-disabled)']);
    expect(css).toMatch(
      /@media \(hover: hover\) \{[^@]*\.item:hover:not\(\[aria-disabled='true'\]\) \{/,
    );
    expect(css).not.toMatch(/\.item:hover \{/);
  });
  it('action items stay on one line and a rule is one hairline', () => {
    expect(rule('.action .item')).toEqual(['white-space: nowrap']);
    expect(rule('.separator')).toEqual([
      'height: var(--size-hairline)',
      'margin: var(--space-1) 0',
      'background: var(--color-border-default)',
    ]);
  });
});
