import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(join(import.meta.dirname, '../packages/web/src/ds/tokens.css'), 'utf8');
function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}
const dark = declarations(tokens.split(':root {')[1]?.split('}')[0] ?? '');
const lightBlock = declarations(
  tokens.split(":root[data-theme='light'] {")[1]?.split('}')[0] ?? '',
);
const light = { ...dark, ...lightBlock };

describe('web design assets and policy', () => {
  it('uses exact desktop columns and rails with the existing narrow column width', () => {
    for (const theme of [dark, light]) {
      expect(theme['--size-column']).toBe('320px');
      expect(theme['--size-rail']).toBe('2px');
      expect(theme['--size-hairline']).toBe('1px');
      expect(theme['--size-spine']).toBe('34px');
    }
    const narrow = /@media \(max-width: 760px\) \{\s*:root \{([^}]+)\}\s*\}/.exec(tokens);
    expect(declarations(narrow?.[1] ?? '')).toEqual({ '--size-column': '248px' });
    expect(narrow?.index).toBeGreaterThan(tokens.indexOf(":root[data-theme='light'] {"));
  });
  it('preserves every prototype token and inherited scale byte for byte', () => {
    // Issue 590 authorizes only these two additions; all remaining bytes must match.
    expect(tokens.match(/--color-text-attention:/g)).toHaveLength(2);
    let original = tokens;
    for (const value of ['#ffd700', '#7d4e00']) {
      const line = `  --color-text-attention: ${value};\n`;
      expect((value === '#ffd700' ? dark : light)['--color-text-attention']).toBe(value);
      original = original.replace(line, '');
    }
    // Issue 656 authorizes only these two additions.
    expect(tokens.match(/--color-fill-violet:/g)).toHaveLength(2);
    for (const [theme, value] of [
      [dark, 'rgba(163, 113, 247, 0.12)'],
      [light, 'rgba(130, 80, 223, 0.08)'],
    ] as const) {
      expect(theme['--color-fill-violet']).toBe(value);
      original = original.replace(`  --color-fill-violet: ${value};\n`, '');
    }
    // Issue 656 authorizes only these dark-theme substitutions.
    original = original.replace(/:root \{[^}]*\}/, (block) => {
      for (const [token, value, prototypeValue] of [
        ['--color-border-subtle', '#2a2a2e', 'rgba(35, 35, 38, 0.6)'],
        ['--color-border-default', '#38383d', '#232326'],
        ['--color-border-strong', '#48484f', '#323236'],
        ['--color-text-tertiary', '#85858c', '#6b6b70'],
      ] as const) {
        expect(dark[token]).toBe(value);
        const declaration = `  ${token}: ${value};\n`;
        expect(block.split(declaration)).toHaveLength(2);
        block = block.replace(declaration, `  ${token}: ${prototypeValue};\n`);
      }
      return block;
    });
    // Issue 625 authorizes only these light-theme substitutions.
    original = original.replace(/:root\[data-theme='light'\] \{[^}]*\}/, (block) => {
      for (const [token, value, prototypeValue] of [
        ['--color-text-secondary', '#454c54', '#59636e'],
        ['--color-text-tertiary', '#59636e', '#818b98'],
      ] as const) {
        expect(light[token]).toBe(value);
        const declaration = `  ${token}: ${value};\n`;
        expect(block.split(declaration)).toHaveLength(2);
        block = block.replace(declaration, `  ${token}: ${prototypeValue};\n`);
      }
      return block;
    });
    expect(original).toBe(
      readFileSync(join(import.meta.dirname, '../design/prototypes/board-v1/tokens.css'), 'utf8'),
    );
    const colors = (theme: Record<string, string>) =>
      Object.keys(theme)
        .filter((key) => key.startsWith('--color-'))
        .sort();
    expect(Object.keys(lightBlock).sort()).toEqual(colors(lightBlock));
    expect(colors(lightBlock)).toEqual(colors(dark));
    for (const theme of [dark, light])
      for (const [key, value] of Object.entries(theme)) {
        expect(value, key).not.toBe('');
        expect(value, key).not.toContain('var(');
      }
  });
});
