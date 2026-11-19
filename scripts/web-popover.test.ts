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
    const width = 'min(var(--size-popover), 100% - var(--space-2) - var(--space-2))';
    expect(root).toEqual(
      expect.arrayContaining([
        'position: fixed',
        'z-index: var(--z-menu)',
        'top: calc(var(--popover-top) + var(--space-1))',
        `width: ${width}`,
        `left: clamp(var(--space-2), var(--popover-left), 100% - var(--space-2) - ${width})`,
        'max-height: min(var(--size-popover-height), 100% - var(--popover-top) - var(--space-1) - var(--space-2))',
      ]),
    );
    // No overflow on the root: a menu in the header may extend past the panel.
    expect(root.filter((declaration) => declaration.startsWith('overflow'))).toEqual([]);
    expect(rule('.root[data-away]')).toEqual(['left: var(--popover-left)']);
    expect(rule('.body')).toContain('overflow-y: auto');
  });
  it('has one layout at every width: at 375px it fills the window less --space-2 a side', () => {
    expect(source).not.toContain('@media');
  });
});
