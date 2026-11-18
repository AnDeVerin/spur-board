import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line local/web-import-boundary -- prototype source as text, for glyph parity
import appSource from '../../../design/prototypes/board-v1/app.js?raw';
// eslint-disable-next-line local/web-import-boundary -- prototype source as text, for glyph parity
import appV12Source from '../../../design/prototypes/board-v1-2/app.jsx?raw';
// eslint-disable-next-line local/web-import-boundary -- prototype source as text, for glyph parity
import baseSource from '../../../design/prototypes/board-v1/base.js?raw';
import { Icon, Logo, type IconName } from '../src/ds/index.ts';

const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  '../src/ds/{Icon,Logo}/*.examples.tsx',
  { eager: true },
);

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
// board-v1-2 draws agent, dispatcher and mirror in ACTOR_ICONS and grip in GripIcon, as JSX:
// JSX drops the whitespace between tags and names the dash attribute in camelCase.
function prototypeV12Glyph(name: string): string {
  const glyph =
    name === 'grip'
      ? /function GripIcon\(\)[^]*?<svg[^>]*>([^]*?)<\/svg>/.exec(appV12Source)?.[1]
      : new RegExp(`^\\s*${name}: \\(\\s*<Fragment>([^]*?)</Fragment>`, 'm').exec(
          appV12Source,
        )?.[1];
  if (glyph === undefined) throw new Error(`board-v1-2/app.jsx has no glyph ${name}`);
  return glyph.replace(/>\s+</g, '><').replaceAll('strokeDasharray=', 'stroke-dasharray=');
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
const v12IconNames: IconName[] = ['agent', 'dispatcher', 'mirror', 'grip'];
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

  it.each(v12IconNames)('icon %s matches the board-v1-2 prototype glyph', (name) => {
    const { open, inner } = svgParts(renderToStaticMarkup(createElement(Icon, { name })));
    expect(open).toContain('viewBox="0 0 16 16"');
    expect(open).toContain('fill="none"');
    expect(open).toContain('stroke="currentColor"');
    expect(normalise(inner)).toBe(normalise(prototypeV12Glyph(name)));
  });

  it.each(['shadow', 'mirror'] as const)('keeps the dashed stroke of %s', (name) => {
    expect(renderToStaticMarkup(createElement(Icon, { name }))).toContain(
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
      expect(render(iconExamples[name]).match(/<svg/g)).toHaveLength(26);
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
