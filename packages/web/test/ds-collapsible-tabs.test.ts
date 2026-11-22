// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
    ).toEqual(['Collapsed', 'Focused', 'OnOpenChange', 'Open', 'Sticky']);
  });

  it('does not report on render', () => {
    const onOpenChange = vi.fn();
    for (const defaultOpen of [true, false]) {
      renderToStaticMarkup(
        createElement(CollapsibleSection, {
          title: 'Blocks',
          children: 'Body text',
          defaultOpen,
          onOpenChange,
        }),
      );
    }
    expect(onOpenChange).not.toHaveBeenCalled();
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

  it('marks a disabled tab and never makes it the tab stop', () => {
    const off = (index: number) =>
      filters.map((tab, at) => (at === index ? { ...tab, disabled: true } : tab));
    const one = tabTags(render('all', off(1)));
    const marked = one.filter((tag) => tag.includes('aria-disabled="true"'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('id="f-tab-spur-board"');
    expect(marked[0]).toContain('tabindex="-1"');
    const firstOff = tabTags(render('none', off(0)));
    expect(firstOff[1]).toContain('tabindex="0"');
    expect(firstOff.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);
  });

  it('marks every tab of a disabled list and leaves no tab stop', () => {
    const html = renderToStaticMarkup(
      createElement(Tabs, {
        id: 'f',
        label: 'Filter',
        tabs: filters,
        value: 'all',
        onChange: () => undefined,
        disabled: true,
      }),
    );
    expect(tabTags(html).filter((tag) => tag.includes('aria-disabled="true"'))).toHaveLength(3);
    expect(html).not.toContain('tabindex="0"');
  });

  describe('keys and clicks', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const tabs: TabItem[] = [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', disabled: true },
      { value: 'c', label: 'c' },
      { value: 'd', label: 'd', disabled: true },
    ];
    const mount = (disabled = false) => {
      const onChange = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          createElement(Tabs, { id: 'k', label: 'Keys', tabs, value: 'a', onChange, disabled }),
        );
      });
      const tab = (value: string) => {
        const found = document.getElementById(`k-tab-${value}`);
        if (!found) throw new Error(`no tab ${value}`);
        return found;
      };
      const key = (value: string, k: string) => {
        tab(value).focus();
        act(() => {
          tab(value).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        });
      };
      const click = (value: string) => {
        act(() => {
          tab(value).click();
        });
      };
      const unmount = () => {
        act(() => {
          root.unmount();
        });
        host.remove();
      };
      return { onChange, tab, key, click, unmount };
    };

    it('skip disabled tabs with wrap, from a focused disabled tab too', () => {
      const { onChange, tab, key, click, unmount } = mount();
      const after = (value: string, k: string) => {
        onChange.mockClear();
        key(value, k);
        return onChange.mock.calls;
      };
      expect(after('a', 'ArrowRight')).toEqual([['c']]);
      expect(document.activeElement).toBe(tab('c'));
      expect(after('c', 'ArrowRight')).toEqual([['a']]);
      expect(document.activeElement).toBe(tab('a'));
      expect(after('a', 'ArrowLeft')).toEqual([['c']]);
      expect(after('a', 'End')).toEqual([['c']]);
      expect(after('c', 'Home')).toEqual([['a']]);
      expect(after('b', 'ArrowRight')).toEqual([['c']]);
      expect(document.activeElement).toBe(tab('c'));
      expect(after('b', 'ArrowLeft')).toEqual([['a']]);
      onChange.mockClear();
      click('b');
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    });

    it('do nothing on a disabled list', () => {
      const { onChange, tab, key, click, unmount } = mount(true);
      for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        key('a', k);
        expect(document.activeElement, k).toBe(tab('a'));
      }
      click('a');
      click('c');
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    });
  });

  it('has the examples the gallery shows', () => {
    expect(Object.keys(examples['../src/ds/Tabs/Tabs.examples.tsx'] ?? {}).sort()).toEqual([
      'Disabled',
      'DisabledTab',
      'Focused',
      'Segmented',
      'Underline',
    ]);
  });
});
