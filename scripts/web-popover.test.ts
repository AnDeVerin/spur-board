import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Node-side, like web-hover-menu.test.ts: web tests may not import node:fs, and Vitest reads CSS
// through a query as an empty string. The rendered behaviour is in
// packages/web/test/ds-popover.test.ts; happy-dom has no layout, so the styles are checked here
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
  it('keeps inside the window next to its anchor, at the menu level', () => {
    const root = rule('.root');
    expect(root).toEqual(
      expect.arrayContaining([
        'position: fixed',
        'z-index: var(--z-menu)',
        '--popover-width: min(var(--size-popover), 100% - var(--popover-edge-left) - var(--popover-edge-right))',
        'width: var(--popover-width)',
        // Floored at the least height, so the header and one control always fit; the fallback
        // keeps it valid before the first placement writes --popover-available.
        'max-height: max(var(--popover-least), min(var(--size-popover-height), var(--popover-available, var(--size-popover-height))))',
        // The window edges: --space-2, or the safe-area inset when it is larger (#760), resolved
        // through scroll-padding for Popover.tsx to read as placement padding.
        '--popover-edge-left: max(var(--space-2), env(safe-area-inset-left, 0px))',
        '--popover-edge-right: max(var(--space-2), env(safe-area-inset-right, 0px))',
        '--popover-edge-bottom: max(var(--space-2), env(safe-area-inset-bottom, 0px))',
        'scroll-padding: var(--space-2) var(--popover-edge-right) var(--popover-edge-bottom) var(--popover-edge-left)',
      ]),
    );
    // Popover.tsx places it with @floating-ui/dom: no placement math in the stylesheet.
    for (const name of ['top', 'left', '--popover-y'])
      expect(
        root.filter((declaration) => declaration.startsWith(`${name}:`)),
        name,
      ).toEqual([]);
    expect(root.join(';')).not.toContain('clamp(');
    // No overflow on the root: a menu beside the title may extend past the panel.
    expect(root.filter((declaration) => declaration.startsWith('overflow'))).toEqual([]);
    expect(rule('.body')).toContain('overflow-y: auto');
  });
  it('near the bottom shrinks to the header and one control, which flip reacts to', () => {
    const root = rule('.root');
    // The header row (content-box, with its hairline), the body padding, room for one standard
    // control in the body, and the root's borders.
    expect(root).toContain(
      '--popover-least: calc(var(--popover-header, calc(var(--size-section-header) + var(--size-hairline))) + var(--space-1) + var(--size-control) + var(--space-3) + var(--size-hairline) + var(--size-hairline))',
    );
    expect(rule('.header')).toEqual(
      expect.arrayContaining([
        'min-height: var(--size-section-header)',
        'border-bottom: var(--size-hairline) solid var(--color-border-default)',
      ]),
    );
    expect(rule('.header').some((declaration) => declaration.startsWith('box-sizing'))).toBe(false);
    expect(rule('.body')).toContain('padding: var(--space-1) var(--space-3) var(--space-3)');
  });
  it('keeps Close inside the panel: the actions slot shrinks and scrolls, Close never shrinks', () => {
    const ring = 'calc(var(--width-ring) + var(--offset-ring))';
    expect(rule('.actions')).toEqual(
      expect.arrayContaining([
        'flex: 0 1 auto',
        'min-width: 0',
        'overflow-x: auto',
        // Grown by one ring outward on the top and sides and by the hairline below, then padded
        // back: a focused tab's ring and its underline on the header border are not clipped.
        `margin: calc(-1 * ${ring}) calc(-1 * ${ring}) calc(-1 * var(--size-hairline))`,
        `padding: ${ring} ${ring} var(--size-hairline)`,
      ]),
    );
    expect(rule('.close')).toContain('flex: none');
    expect(rule('.title')).toEqual(expect.arrayContaining(['flex: 0 1 auto', 'min-width: 0']));
  });
  it('leaves the window wholly with an anchor scrolled out', () => {
    // Not in view: not rendered, so no descendant can show itself and its controls leave the tab
    // order. Its position no longer matters, so no other rule keys on the side.
    expect(rule('.root[data-away]')).toEqual(['display: none']);
    expect(source).not.toContain("[data-away='");
    expect(source).not.toContain('visibility');
  });
  it('has one layout at every width: at 375px it fills the window less --space-2 a side', () => {
    expect(source).not.toContain('@media');
  });
});
