import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CollapsibleSection, quiet, TabPanel, Tabs, type TabItem } from '../src/ds/index.ts';

const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  ['../src/ds/CollapsibleSection/*.examples.tsx', '../src/ds/Tabs/*.examples.tsx'],
  { eager: true },
);

describe('CollapsibleSection', () => {
  const render = (props: { defaultOpen?: boolean; count?: number; summary?: string }) =>
    renderToStaticMarkup(
      createElement(CollapsibleSection, { title: 'Blocks', children: 'Body text', ...props }),
    );
  const attr = (html: string, tag: string, name: string) =>
    new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];

  it('sets aria-expanded and aria-controls and names the button by the title', () => {
    for (const defaultOpen of [true, false]) {
      const html = render({ defaultOpen, count: 3, summary: '2 open' });
      expect(attr(html, 'button', 'type')).toBe('button');
      expect(attr(html, 'button', 'aria-expanded')).toBe(String(defaultOpen));
      const body = attr(html, 'button', 'aria-controls');
      expect(body).toBeTruthy();
      expect(html).toContain(`<div id="${body ?? ''}"`);
      const title = attr(html, 'button', 'aria-labelledby');
      expect(title).toBeTruthy();
      expect(html).toContain(`<span id="${title ?? ''}"`);
      expect(html).toMatch(new RegExp(`id="${title ?? ''}"[^>]*>Blocks</span>`));
      expect(html).toContain('>3</span>');
      expect(html).toContain('>2 open</span>');
      expect(html).toContain('Body text');
    }
  });

  it('hides the body only when collapsed', () => {
    expect(render({})).not.toContain('hidden=""');
    expect(render({ defaultOpen: false })).toMatch(/<div id="[^"]*"[^>]*hidden=""/);
  });

  it('names the double-click action of the current state', () => {
    expect(render({})).toContain('title="Double-click to collapse"');
    expect(render({ defaultOpen: false })).toContain('title="Double-click to expand"');
  });

  it('makes the section a quiet container', () => {
    expect(quiet).not.toBe('');
    expect(render({})).toMatch(new RegExp(`^<section class="${quiet} `));
  });

  it('leaves out an absent count and summary', () => {
    expect(render({})).toMatch(/>Blocks<\/span><\/div>/);
  });

  it('has the examples the gallery shows', () => {
    expect(
      Object.keys(
        examples['../src/ds/CollapsibleSection/CollapsibleSection.examples.tsx'] ?? {},
      ).sort(),
    ).toEqual(['Collapsed', 'Open', 'Sticky']);
  });
});

describe('Tabs', () => {
  const filters: TabItem[] = [
    { value: 'all', label: 'all', count: 7 },
    { value: 'spur-board', label: 'spur-board', count: 3 },
    { value: 'system', label: 'system' },
  ];
  const render = (value: string, tabs: readonly TabItem[] = filters) =>
    renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Tabs, {
          id: 'f',
          label: 'Filter',
          variant: 'segmented',
          tabs,
          value,
          onChange: () => undefined,
        }),
        createElement(TabPanel, { tabsId: 'f', value, children: 'List' }),
      ),
    );
  const tabTags = (html: string) => html.match(/<button[^>]*>/g) ?? [];

  it('uses the tablist, tab and tabpanel roles with roving focus', () => {
    const html = render('spur-board');
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
    expect(html).toContain('role="tablist" aria-label="Filter"');
    const tags = tabTags(html);
    expect(tags).toHaveLength(3);
    for (const tag of tags) expect(tag).toContain('role="tab"');
    const selected = tags.filter((tag) => tag.includes('aria-selected="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('id="f-tab-spur-board"');
    expect(selected[0]).toContain('tabindex="0"');
    expect(tags.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(2);
    expect(html.match(/aria-controls=/g)).toHaveLength(1);
    expect(selected[0]).toContain('aria-controls="f-panel-spur-board"');
    const panel = html.match(/<div[^>]*role="tabpanel"[^>]*>List<\/div>/g) ?? [];
    expect(panel).toHaveLength(1);
    expect(panel[0]).toContain('id="f-panel-spur-board"');
    expect(panel[0]).toContain('aria-labelledby="f-tab-spur-board"');
  });

  it('puts the tab panel in the tab order, so Tab reaches content with no control', () => {
    const panel = render('spur-board').match(/<div[^>]*role="tabpanel"[^>]*>/g) ?? [];
    expect(panel).toHaveLength(1);
    expect(panel[0]).toContain('tabindex="0"');
  });

  it('shows a count and names the tab with it', () => {
    const html = render('all');
    expect(html).toContain('aria-label="spur-board 3"');
    expect(html).toMatch(/spur-board<span[^>]*>3<\/span>/);
    const plain = tabTags(html).find((tag) => tag.includes('id="f-tab-system"'));
    expect(plain).not.toContain('aria-label');
  });

  it('keeps the first tab as the tab stop when the value matches no tab', () => {
    const tags = tabTags(render('none'));
    expect(tags[0]).toContain('tabindex="0"');
    expect(tags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
    expect(tags.join('')).not.toContain('aria-selected="true"');
    expect(tags.join('')).not.toContain('aria-controls');
  });

  it('renders nothing for no tabs', () => {
    expect(
      renderToStaticMarkup(
        createElement(Tabs, {
          id: 'f',
          label: 'Filter',
          tabs: [],
          value: '',
          onChange: () => undefined,
        }),
      ),
    ).toBe('');
  });

  it('encodes values in ids', () => {
    expect(render('a b', [{ value: 'a b', label: 'a b' }])).toContain('id="f-tab-a%20b"');
  });

  it('has the examples the gallery shows', () => {
    expect(Object.keys(examples['../src/ds/Tabs/Tabs.examples.tsx'] ?? {}).sort()).toEqual([
      'Focused',
      'Segmented',
      'Underline',
    ]);
  });
});
