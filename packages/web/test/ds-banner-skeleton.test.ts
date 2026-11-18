import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Banner, Button, Skeleton, breakpoints, type BannerVariant } from '../src/ds/index.ts';

const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  '../src/ds/*/*.examples.tsx',
  { eager: true },
);
const count = (html: string, text: string) => html.split(text).length - 1;

describe('Banner', () => {
  const render = (variant: BannerVariant, extra: { detail?: string; action?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(Banner, {
        variant,
        icon: 'x',
        detail: extra.detail,
        action: extra.action ? createElement(Button, { children: 'Retry now' }) : undefined,
        children: 'The daemon does not answer',
      }),
    );

  it.each([
    ['error', 'alert'],
    ['warning', 'status'],
    ['info', 'status'],
  ] as const)('banner role per variant: %s is %s', (variant, role) => {
    const html = render(variant);
    expect(html).toContain(`role="${role}"`);
    expect(count(html, 'role="')).toBe(1);
    expect(html).toContain(`data-variant="${variant}"`);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('The daemon does not answer');
    expect(html).not.toContain('<button');
  });

  it('banner action and detail', () => {
    const bare = render('error');
    const full = render('error', { detail: 'Retrying in 12 s', action: true });
    expect(count(full, '<span')).toBe(count(bare, '<span') + 2);
    const main = full.indexOf('The daemon does not answer');
    expect(main).toBeGreaterThan(-1);
    expect(full.indexOf('Retrying in 12 s')).toBeGreaterThan(main);
    expect(count(full, '<button')).toBe(1);
    expect(full).toContain('Retry now');
    expect(full.indexOf('Retry now')).toBeGreaterThan(full.indexOf('Retrying in 12 s'));
  });
});

describe('Skeleton', () => {
  const render = (widths?: readonly number[]) =>
    renderToStaticMarkup(createElement(Skeleton, widths === undefined ? {} : { widths }));
  const widthsOf = (html: string) => [...html.matchAll(/width:([^;"]+)/g)].map((m) => m[1]);

  it('skeleton draws one line per width', () => {
    const html = render([30, 100, 70]);
    expect(widthsOf(html)).toEqual(['30%', '100%', '70%']);
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(render()).toBe(html);
    expect(widthsOf(render([45, 100, 85, 60]))).toEqual(['45%', '100%', '85%', '60%']);
  });

  it('clamps widths and renders nothing for no widths', () => {
    expect(widthsOf(render([-5, 150, Number.NaN]))).toEqual(['0%', '100%', '100%']);
    expect(render([])).toBe('');
  });
});

describe('breakpoints', () => {
  it('breakpoints lists narrow first', () => {
    expect(Object.entries(breakpoints)).toEqual([['narrow', '(max-width: 760px)']]);
  });
});

describe('Banner, Skeleton, HoverMenu and Breakpoints examples', () => {
  const names = (folder: string) =>
    Object.keys(examples[`../src/ds/${folder}/${folder}.examples.tsx`] ?? {}).sort();

  it('has the examples the gallery shows', () => {
    expect(names('Banner')).toEqual([
      'Error',
      'ErrorWithAction',
      'Info',
      'InfoWithAction',
      'LongText',
      'Warning',
      'WarningWithAction',
    ]);
    expect(names('Skeleton')).toEqual(['Card', 'Column', 'Widths']);
    expect(names('HoverMenu')).toEqual([
      'ActionsFocused',
      'CardMenu',
      'CardMenuMirror',
      'CauseLine',
      'Closed',
      'Focused',
      'Open',
      'OpensDown',
      'Selected',
      'SortMenu',
      'TextTrigger',
      'Touch',
      'TwoMenus',
    ]);
    expect(names('Breakpoints')).toEqual(['List']);
  });
});
