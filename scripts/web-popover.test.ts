import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Node-side, like web-hover-menu.test.ts: web tests may not import node:fs, and Vitest reads CSS
// through a query as an empty string. The rendered behaviour is in
// packages/web/test/ds-popover.test.ts; happy-dom has no layout, so the placement is checked here
// as written.
const source = readFileSync(
  join(import.meta.dirname, '../packages/web/src/ds/Popover/Popover.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the one rule with exactly this selector, whitespace collapsed. */
function rule(selector: string): string[] {
  const bodies = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, head]) => head?.trim() === selector)
    .map(([, , body]) => body ?? '');
  expect(bodies, selector).toHaveLength(1);
  return (bodies[0] ?? '')
    .split(';')
    .map((declaration) =>
      declaration.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim(),
    )
    .filter(Boolean);
}

describe('Popover styles', () => {
  it('keeps inside the window under its anchor, at the menu level', () => {
    const root = rule('.root');
    expect(root).toEqual(
      expect.arrayContaining([
        'position: fixed',
        'z-index: var(--z-menu)',
        '--popover-width: min(var(--size-popover), 100% - var(--space-2) - var(--space-2))',
        'width: var(--popover-width)',
        'left: clamp(var(--space-2), var(--popover-left), 100% - var(--space-2) - var(--popover-width))',
        'top: var(--popover-y)',
        // Floored at the least height, so a panel following its anchor out slides out whole.
        'max-height: max(var(--popover-least), min(var(--size-popover-height), 100% - var(--popover-y) - var(--space-2)))',
      ]),
    );
    // No overflow on the root: a menu in the header may extend past the panel.
    expect(root.filter((declaration) => declaration.startsWith('overflow'))).toEqual([]);
    expect(rule('.body')).toContain('overflow-y: auto');
  });
  it('near the bottom moves up just enough to keep the header and body padding in the window', () => {
    const root = rule('.root');
    // The header row (content-box, with its hairline), the body padding and the root's borders.
    expect(root).toContain(
      '--popover-least: calc(var(--size-section-header) + var(--size-hairline) + var(--space-1) + var(--space-3) + var(--size-hairline) + var(--size-hairline))',
    );
    expect(rule('.header')).toEqual(
      expect.arrayContaining([
        'min-height: var(--size-section-header)',
        'border-bottom: var(--size-hairline) solid var(--color-border-default)',
      ]),
    );
    expect(rule('.header').some((declaration) => declaration.startsWith('box-sizing'))).toBe(false);
    expect(rule('.body')).toContain('padding: var(--space-1) var(--space-3) var(--space-3)');
    // The lower bound acts only for an anchor whose top is below the window: it follows it out.
    expect(root).toContain(
      '--popover-y: max(min(var(--popover-top) + var(--space-1), 100% - var(--space-2) - var(--popover-least)), var(--popover-anchor-top) - var(--popover-least) - var(--space-2))',
    );
  });
  it('leaves the window wholly with an anchor scrolled out', () => {
    // Not in view: hidden, which also takes its controls out of the tab order.
    expect(rule('.root[data-away]')).toEqual(['left: var(--popover-left)', 'visibility: hidden']);
    // An anchor narrower than the panel: its right edge, not its left, takes the panel out.
    expect(rule(".root[data-away='left']")).toEqual([
      'left: min(var(--popover-left), var(--popover-right) - var(--popover-width))',
    ]);
  });
  it('has one layout at every width: at 375px it fills the window less --space-2 a side', () => {
    expect(source).not.toContain('@media');
  });
});
