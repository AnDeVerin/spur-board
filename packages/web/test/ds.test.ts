import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSync } from 'vite';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line local/web-import-boundary -- prototype source as text, for glyph parity
import appSource from '../../../design/prototypes/board-v1/app.js?raw';
// eslint-disable-next-line local/web-import-boundary -- prototype source as text, for glyph parity
import baseSource from '../../../design/prototypes/board-v1/base.js?raw';
import {
  Icon,
  KeyValueBox,
  Logo,
  Meter,
  type IconName,
  type KeyValueRow,
  type MeterThresholds,
} from '../src/ds/index.ts';
import indexSource from '../src/ds/index.ts?raw';

// Keys only: Vitest returns an empty string for CSS read through a query.
const files = Object.keys(import.meta.glob('../src/ds/*/*.{tsx,css}'));
const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  '../src/ds/*/*.examples.tsx',
  { eager: true },
);

/**
 * ds/index.ts exports values only as `export { ... } from './<Name>/<Name>.tsx'`; type-only
 * exports are free. Every component so re-exported needs `<Name>.module.css` and a
 * `<Name>.examples.tsx` with at least one named export.
 */
function checkDesignSystem(
  source: string,
  paths: readonly string[],
  modules: Record<string, Record<string, unknown>>,
) {
  const problems: string[] = [];
  const folders = new Set<string>();
  for (const node of parseSync('index.ts', source).program.body) {
    const unsupported = () =>
      problems.push(`unsupported export: ${source.slice(node.start, node.end)}`);
    if (node.type === 'ExportAllDeclaration') problems.push(`export * from ${node.source.value}`);
    if (node.type === 'ExportDefaultDeclaration' || node.type === 'TSExportAssignment')
      unsupported();
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    if (node.declaration) {
      unsupported();
      continue;
    }
    if (node.specifiers.every((specifier) => specifier.exportKind === 'type')) continue;
    const name = node.source && /^\.\/(\w+)\/\1\.tsx$/.exec(node.source.value)?.[1];
    if (name) folders.add(name);
    else unsupported();
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
      folders: [
        'Chip',
        'Icon',
        'KeyValueBox',
        'Logo',
        'Meter',
        'Quiet',
        'StatusDot',
        'ThemeSwitch',
      ],
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

  it.each([
    [
      "import { Ghost } from './Ghost/Ghost.tsx';\nexport { Ghost };",
      ['unsupported export: export { Ghost };'],
    ],
    ['export const ghost = 1;', ['unsupported export: export const ghost = 1;']],
    ['export function Ghost() {}', ['unsupported export: export function Ghost() {}']],
    ['export default 1;', ['unsupported export: export default 1;']],
    [
      "export { ghost } from './ghost.ts';",
      ["unsupported export: export { ghost } from './ghost.ts';"],
    ],
    ["import type { GhostTone } from './Ghost/Ghost.tsx';\nexport type { GhostTone };", []],
    ["import type { GhostTone } from './Ghost/Ghost.tsx';\nexport { type GhostTone };", []],
    ["export type GhostTone = 'a';", []],
    ['export interface GhostProps {}', []],
  ])('accepts only value re-exports from a component folder: %s', (source, problems) => {
    expect(checkDesignSystem(source, [], {})).toEqual({ problems, folders: [] });
  });

  it('reports export star', () => {
    expect(checkDesignSystem("export * from './Chip/Chip.tsx';", [], {}).problems).toEqual([
      'export * from ./Chip/Chip.tsx',
    ]);
  });
});

// Prototype markup and React markup differ only in self-closing tags and whitespace.
function normalise(markup: string): string {
  return markup
    .replace(/<(\w+)([^<>]*?)\s*\/>/g, '<$1$2></$1>')
    .replace(/\s+/g, ' ')
    .trim();
}
function svgParts(html: string): { open: string; inner: string } {
  const match = /^(<svg[^>]*>)(.*)<\/svg>$/s.exec(html);
  if (!match) throw new Error(`not one svg: ${html}`);
  return { open: match[1] ?? '', inner: match[2] ?? '' };
}
function prototypeGlyph(name: string): string {
  // merge and shadow put the string on the line after the key.
  const glyph = new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'm').exec(baseSource)?.[1];
  if (glyph === undefined) throw new Error(`base.js has no glyph ${name}`);
  return glyph;
}
const iconNames: IconName[] = [
  'mark',
  'caret',
  'search',
  'inbox',
  'ticket',
  'pr',
  'term',
  'check',
  'x',
  'clock',
  'merge',
  'bubble',
  'person',
  'block',
  'back',
  'pulse',
  'shadow',
  'hash',
  'diamond',
  'sun',
  'moon',
  'auto',
];
const iconExamples = examples['../src/ds/Icon/Icon.examples.tsx'] ?? {};
const logoExamples = examples['../src/ds/Logo/Logo.examples.tsx'] ?? {};
const render = (example: unknown) => renderToStaticMarkup(createElement(example as ComponentType));

describe('Icon and Logo', () => {
  it.each(iconNames)('icon %s matches the prototype glyph', (name) => {
    const { open, inner } = svgParts(renderToStaticMarkup(createElement(Icon, { name })));
    expect(open).toContain('viewBox="0 0 16 16"');
    expect(open).toContain('fill="none"');
    expect(open).toContain('stroke="currentColor"');
    expect(normalise(inner)).toBe(normalise(prototypeGlyph(name)));
  });

  it('keeps the dashed stroke of shadow', () => {
    expect(renderToStaticMarkup(createElement(Icon, { name: 'shadow' }))).toContain(
      'stroke-dasharray="1.6 1.6"',
    );
  });

  it('logo matches the prototype header', () => {
    const header = /<svg viewBox="0 0 16 16" aria-label="spur-board">(.*?)<\/svg>/.exec(
      appSource,
    )?.[1];
    expect(header).toBeDefined();
    for (const size of ['header', 'small'] as const) {
      const { open, inner } = svgParts(renderToStaticMarkup(createElement(Logo, { size })));
      expect(open).toContain('viewBox="0 0 16 16"');
      expect(open).toContain('fill="none"');
      expect(open).toContain('stroke="currentColor"');
      expect(normalise(inner)).toBe(normalise(header ?? ''));
    }
  });

  it.each([
    ['Icon', (props: { label?: string }) => createElement(Icon, { name: 'x', ...props })],
    ['Logo', (props: { label?: string }) => createElement(Logo, props)],
  ] as const)('%s is decorative without label, named with label', (_name, make) => {
    const bare = svgParts(renderToStaticMarkup(make({}))).open;
    expect(bare).toContain('aria-hidden="true"');
    expect(bare).not.toContain('role=');
    expect(bare).not.toContain('aria-label');
    const named = svgParts(renderToStaticMarkup(make({ label: 'Close' }))).open;
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Close"');
    expect(named).not.toContain('aria-hidden');
  });

  it('shows every icon once on base and on elevated', () => {
    for (const name of ['OnBase', 'OnElevated'])
      expect(render(iconExamples[name]).match(/<svg/g)).toHaveLength(22);
  });

  it('has the examples the gallery shows', () => {
    expect(Object.keys(iconExamples).sort()).toEqual([
      'InQuiet',
      'Labeled',
      'OnBase',
      'OnElevated',
    ]);
    expect(Object.keys(logoExamples).sort()).toEqual(['Header', 'Small']);
  });

  it('renders nothing focusable and paints with currentColor', () => {
    for (const example of [...Object.values(iconExamples), ...Object.values(logoExamples)]) {
      const html = render(example);
      expect(html).not.toMatch(/tabindex|<button|<a[\s>]/i);
      for (const svg of html.match(/<svg[^>]*>/g) ?? []) {
        expect(svg).toContain('fill="none"');
        expect(svg).toContain('stroke="currentColor"');
      }
    }
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

describe('KeyValueBox', () => {
  const render = (rows: readonly KeyValueRow[], title?: string) =>
    renderToStaticMarkup(createElement(KeyValueBox, { rows, title }));
  const count = (html: string, text: string) =>
    html.toLowerCase().split(text.toLowerCase()).length - 1;

  it('marks each status row and puts each status word in the DOM once', () => {
    const html = render([
      { key: 'PR open', value: 'met', status: 'pass' },
      { key: 'Checks green', value: 'checks pending', status: 'wait' },
      { key: 'PR exists', value: 'no PR', status: 'fail' },
      { key: 'Merged', status: 'unchecked' },
      { key: 'Open turn', value: 'none' },
    ]);
    for (const status of ['pass', 'wait', 'fail', 'unchecked'])
      expect(count(html, `data-status="${status}"`)).toBe(1);
    expect(count(html, 'data-status=')).toBe(4);
    for (const word of ['passed', 'waiting', 'failed', 'not checked'])
      expect(count(html, word)).toBe(1);
    expect(count(html, 'aria-hidden="true"')).toBe(4);
    expect(html).toContain('Open turn');
    expect(html).toContain('none');
  });

  it('does not repeat a word the value already says, and shows it for a message row', () => {
    const html = render([
      { key: 'Merged', value: 'Not checked', status: 'unchecked' },
      { key: 'Spur unavailable', status: 'fail' },
    ]);
    expect(count(html, 'not checked')).toBe(1);
    expect(count(html, 'failed')).toBe(1);
    // A null value is no value: the same visible word and message key as an omitted one.
    const message = render([{ key: 'Spur unavailable', status: 'fail' }]);
    const nullValue = render([{ key: 'Spur unavailable', value: null, status: 'fail' }]);
    expect(count(nullValue, 'failed')).toBe(1);
    expect(nullValue).toBe(message);
  });

  it('renders the title only when given, and nothing for no rows and no title', () => {
    expect(render([{ key: 'CPU', value: '—' }], 'github pull requests')).toContain(
      'github pull requests',
    );
    expect(render([{ key: 'CPU', value: '—' }])).not.toContain('github');
    expect(render([], 'github pull requests')).toContain('github pull requests');
    expect(render([])).toBe('');
  });
});

describe('Meter', () => {
  const low: MeterThresholds = { warn: 0.2, error: 0.05, worse: 'low' };
  const render = (value: number | null, limit = 5000, thresholds: MeterThresholds | null = low) =>
    renderToStaticMarkup(
      createElement(Meter, { name: 'Budget', value, limit, thresholds: thresholds ?? undefined }),
    );

  it('draws an ok reading with its bar, label and meter attributes', () => {
    const html = render(4210);
    expect(html).toContain('data-level="ok"');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="Budget"');
    expect(html).toContain('aria-valuetext="4210 / 5000"');
    expect(html).toContain('aria-valuenow="4210"');
    expect(html).toContain('width:84%');
    expect(html).toContain('4210 / 5000');
    expect(html).not.toContain('warning');
  });

  it.each([
    [1000, 'warning'],
    [900, 'warning'],
    [250, 'error'],
    [150, 'error'],
  ])('switches at inclusive thresholds when low is worse: %d is %s', (value, level) => {
    const html = render(value);
    expect(html).toContain(`data-level="${level}"`);
    expect(html).toContain(`aria-valuetext="${String(value)} / 5000 · ${level}"`);
    expect(html).toContain(`· ${level}</span>`);
  });

  it('switches when high is worse', () => {
    const high: MeterThresholds = { warn: 0.8, error: 0.9, worse: 'high' };
    expect(render(92, 100, high)).toContain('data-level="error"');
    expect(render(85, 100, high)).toContain('data-level="warning"');
    expect(render(79, 100, high)).toContain('data-level="ok"');
  });

  it('stays ok without thresholds', () => {
    expect(render(1, 5000, null)).toContain('data-level="ok"');
  });

  it('clamps the fill and the value but keeps the reading', () => {
    const html = render(6000);
    expect(html).toContain('width:100%');
    expect(html).toContain('aria-valuenow="5000"');
    expect(html).toContain('aria-valuetext="6000 / 5000"');
  });

  it.each([
    ['a null value', null, 5000],
    ['a zero limit', 10, 0],
  ])('draws no reading for %s', (_, value, limit) => {
    const html = render(value, limit);
    expect(html).toContain('data-level="unknown"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).not.toContain('width:');
    expect(html).toContain(`— / ${String(limit)}`);
    expect(html).toContain(`aria-label="Budget: unknown / ${String(limit)}"`);
  });
});
