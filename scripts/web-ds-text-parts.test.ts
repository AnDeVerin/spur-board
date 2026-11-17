import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Node-side, like web.test.ts: web tests may not import node:fs, and Vitest reads CSS through
// a query as an empty string. The rendered behaviour is in packages/web/test/ds-text-parts.test.ts.
const read = (file: string) =>
  readFileSync(join(import.meta.dirname, '../packages/web/src/ds', file), 'utf8');
const css = (name: string) => read(`${name}/${name}.module.css`);
/** The declarations of the one rule with exactly this selector. */
function rule(source: string, selector: string): string[] {
  const bodies = [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, head]) => head?.replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector)
    .map(([, , body]) => body ?? '');
  expect(bodies, selector).toHaveLength(1);
  return (bodies[0] ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

describe('ds text parts styles', () => {
  it('CollapsibleSection title and count are one step up while the summary stays micro', () => {
    const source = css('CollapsibleSection');
    expect(rule(source, '.title')).toEqual([
      'font-size: var(--text-body)',
      'text-transform: uppercase',
      'letter-spacing: var(--tracking-label)',
      'font-weight: var(--weight-bold)',
      'color: var(--color-text-primary)',
    ]);
    expect(rule(source, '.count')).toContain('font-size: var(--text-small)');
    expect(rule(source, '.summary')).toContain('font-size: var(--text-micro)');
  });

  it('LineClamp clamps to --lines-fold with pre-wrap and leaves the text selectable', () => {
    const declarations = rule(css('LineClamp'), '.clamp');
    for (const declaration of [
      '-webkit-line-clamp: var(--lines-fold)',
      'line-clamp: var(--lines-fold)',
      'overflow: hidden',
      'white-space: pre-wrap',
      'color: var(--color-text-secondary)',
    ])
      expect(declarations).toContain(declaration);
    expect(css('LineClamp')).not.toMatch(/user-select/);
    expect(read('tokens.css')).toContain('  --lines-fold: 3;\n');
  });

  it('TextToggle is tertiary at rest, primary on hover, with no outline of its own', () => {
    const source = css('TextToggle');
    expect(rule(source, '.toggle')).toContain('color: var(--color-text-tertiary)');
    expect(rule(source, '.toggle:hover')).toEqual(['color: var(--color-text-primary)']);
    expect(rule(source, '.caret[data-expanded]')).toEqual(['transform: scaleY(-1)']);
    expect(source).not.toMatch(/\boutline(?:-[\w-]+)?\s*:/);
  });

  it('Chip tints colour only the fill and the icon', () => {
    const source = css('Chip');
    expect(rule(source, '.ready')).toEqual(['background: var(--color-fill-ready)']);
    expect(rule(source, '.ready svg')).toEqual(['color: var(--color-status-ready)']);
    expect(rule(source, '.error')).toEqual(['background: var(--color-fill-error)']);
    expect(rule(source, '.error svg')).toEqual(['color: var(--color-status-error)']);
  });
});
