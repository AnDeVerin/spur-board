import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSync } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import indexSource from '../src/ds/index.ts?raw';

// Keys only: Vitest returns an empty string for CSS read through a query.
const files = Object.keys(import.meta.glob('../src/ds/*/*.{tsx,css}'));
const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  '../src/ds/*/*.examples.tsx',
  { eager: true },
);

/**
 * Every component that ds/index.ts re-exports by value from `./<Name>/<Name>.tsx` needs
 * `<Name>.module.css` and a `<Name>.examples.tsx` with at least one named export.
 */
function checkDesignSystem(
  source: string,
  paths: readonly string[],
  modules: Record<string, Record<string, unknown>>,
) {
  const problems: string[] = [];
  const folders = new Set<string>();
  for (const node of parseSync('index.ts', source).program.body) {
    if (node.type === 'ExportAllDeclaration') problems.push(`export * from ${node.source.value}`);
    if (node.type !== 'ExportNamedDeclaration' || !node.source || node.exportKind === 'type')
      continue;
    const name = /^\.\/(\w+)\/\1\.tsx$/.exec(node.source.value)?.[1];
    if (name && node.specifiers.some((specifier) => specifier.exportKind !== 'type'))
      folders.add(name);
  }
  const sorted = [...folders].sort();
  for (const name of sorted) {
    const base = `../src/ds/${name}/${name}`;
    if (!paths.includes(`${base}.examples.tsx`)) problems.push(`${name}: missing examples`);
    else if (Object.keys(modules[`${base}.examples.tsx`] ?? {}).length === 0)
      problems.push(`${name}: no examples`);
    if (!paths.includes(`${base}.module.css`)) problems.push(`${name}: missing css`);
  }
  return { problems, folders: sorted };
}

describe('design system examples rule', () => {
  it('passes on the real tree and counts each value-exported component', () => {
    expect(checkDesignSystem(indexSource, files, examples)).toEqual({
      problems: [],
      folders: ['Chip', 'Quiet', 'StatusDot', 'ThemeSwitch'],
    });
    for (const module of Object.values(examples))
      expect(Object.keys(module).length).toBeGreaterThan(0);
  });

  it('reports missing examples and css for a value re-export', () => {
    expect(
      checkDesignSystem("export { Ghost } from './Ghost/Ghost.tsx';", [], {}).problems,
    ).toEqual(['Ghost: missing examples', 'Ghost: missing css']);
  });

  it('reports an examples module with no named export', () => {
    const paths = ['../src/ds/Ghost/Ghost.examples.tsx', '../src/ds/Ghost/Ghost.module.css'];
    const modules = { '../src/ds/Ghost/Ghost.examples.tsx': {} };
    expect(
      checkDesignSystem("export { Ghost } from './Ghost/Ghost.tsx';", paths, modules).problems,
    ).toEqual(['Ghost: no examples']);
  });

  it('skips type-only re-exports', () => {
    expect(
      checkDesignSystem("export type { GhostTone } from './Ghost/Ghost.tsx';", [], {}),
    ).toEqual({ problems: [], folders: [] });
    expect(
      checkDesignSystem("export { type GhostTone } from './Ghost/Ghost.tsx';", [], {}),
    ).toEqual({ problems: [], folders: [] });
  });

  it('reports export star', () => {
    expect(checkDesignSystem("export * from './Chip/Chip.tsx';", [], {}).problems).toEqual([
      'export * from ./Chip/Chip.tsx',
    ]);
  });
});

describe('design system examples', () => {
  const cases = Object.entries(examples).flatMap(([path, module]) =>
    Object.entries(module).map(([name, example]) => ({ label: `${path} ${name}`, example })),
  );
  it.each(cases)('$label renders with zero props', ({ example }) => {
    expect(example).toBeTypeOf('function');
    const error = vi.spyOn(console, 'error');
    try {
      const html = renderToStaticMarkup(createElement(example as ComponentType));
      expect(html).not.toBe('');
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
