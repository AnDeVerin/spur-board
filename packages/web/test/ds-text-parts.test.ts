// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chip, focusRing, LineClamp, TextToggle } from '../src/ds/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The CSS and token checks run Node-side in scripts/web-ds-text-parts.test.ts.
describe('LineClamp', () => {
  it('renders one paragraph holding the full text', () => {
    const html = renderToStaticMarkup(createElement(LineClamp, { children: 'Line one\nLine two' }));
    expect(html).toMatch(/^<p class="[^"]+">Line one\nLine two<\/p>$/);
  });

  it('adds caller classes to the root while preserving default markup', () => {
    const render = (props: { className?: string | undefined }) =>
      renderToStaticMarkup(createElement(LineClamp, { children: 'Line one\nLine two', ...props }));
    const rest = render({});
    const custom = render({ className: 'layout spacing' });
    expect(custom).toMatch(/^<p class="[^"]+ layout spacing">/);
    expect(custom.replace(' layout spacing', '')).toBe(rest);
    expect(render({ className: undefined })).toBe(rest);
    expect(render({ className: '' })).toBe(rest);
  });

  describe('reports overflow at the prototype tolerance', () => {
    let container: HTMLDivElement;
    let root: Root;
    let size = { scroll: 36, client: 36 };
    let resize: (() => void) | undefined;
    const counts = { observe: 0, disconnect: 0 };
    const onOverflowChange = vi.fn<(overflows: boolean) => void>();
    const render = (text: string) => {
      act(() => {
        root.render(createElement(LineClamp, { onOverflowChange, children: text }));
      });
    };
    const calls = () => onOverflowChange.mock.calls.map(([overflows]) => overflows);

    beforeEach(() => {
      size = { scroll: 36, client: 36 };
      resize = undefined;
      counts.observe = 0;
      counts.disconnect = 0;
      onOverflowChange.mockReset();
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => size.scroll);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.client);
      // happy-dom's ResizeObserver never calls back; this fake hands the callback to the test.
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe() {
            counts.observe += 1;
          }
          disconnect() {
            counts.disconnect += 1;
          }
        },
      );
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });
    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('reports the first measurement, then only changes past one pixel', () => {
      render('Pick a migration order.');
      expect(calls()).toEqual([false]);
      size.scroll = 37;
      render('Pick a migration order.');
      expect(calls()).toEqual([false]);
      size.scroll = 38;
      render('Pick a migration order.');
      expect(calls()).toEqual([false, true]);
      render('Pick a migration order.');
      expect(calls()).toEqual([false, true]);
    });

    it('reports a first true', () => {
      size.scroll = 60;
      render('Long text');
      expect(calls()).toEqual([true]);
    });

    it('re-measures after new text at the same box height', () => {
      render('Short');
      size.scroll = 60;
      render('Long text that now runs past the fold');
      expect(calls()).toEqual([false, true]);
    });

    it('re-measures on resize and disconnects on unmount', () => {
      size.scroll = 60;
      render('Long text');
      expect(counts.observe).toBe(1);
      size.scroll = 36;
      act(() => {
        resize?.();
      });
      expect(calls()).toEqual([true, false]);
      render('Long text');
      expect(counts.observe).toBe(1);
      act(() => {
        root.unmount();
      });
      expect(counts.disconnect).toBe(1);
      root = createRoot(container);
    });
  });
});

describe('TextToggle', () => {
  const render = (props: {
    className?: string | undefined;
    expanded?: boolean;
    controls?: string;
    caret?: boolean;
  }) =>
    renderToStaticMarkup(
      createElement(TextToggle, { onClick: () => undefined, children: 'Show all', ...props }),
    );
  const attribute = (html: string, name: string) =>
    new RegExp(`<button[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];

  it('adds caller classes to the root while preserving default markup', () => {
    const rest = render({ expanded: true, controls: 'details', caret: true });
    const custom = render({
      expanded: true,
      controls: 'details',
      caret: true,
      className: 'layout spacing',
    });
    expect(attribute(custom, 'class')).toBe(`${attribute(rest, 'class') ?? ''} layout spacing`);
    expect(custom.replace(' layout spacing', '')).toBe(rest);
    expect(render({ className: undefined })).toBe(render({}));
    expect(render({ className: '' })).toBe(render({}));
  });

  it('is a quiet disclosure button with the ds ring', () => {
    const rest = render({});
    expect(attribute(rest, 'type')).toBe('button');
    expect(attribute(rest, 'class')?.split(' ')).toContain(focusRing);
    expect(rest).not.toMatch(/aria-expanded|aria-controls|<svg/);
    const open = render({ expanded: true, controls: 'b161', caret: true });
    expect(attribute(open, 'aria-expanded')).toBe('true');
    expect(attribute(open, 'aria-controls')).toBe('b161');
    expect(open).toMatch(/<span class="[^"]+" data-expanded=""><svg /);
    const closed = render({ expanded: false, caret: true });
    expect(attribute(closed, 'aria-expanded')).toBe('false');
    expect(closed).toMatch(/<span class="[^"]+"><svg /);
  });

  it('calls onClick once per click', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onClick = vi.fn<() => void>();
    act(() => {
      root.render(createElement(TextToggle, { onClick, children: 'Show all' }));
    });
    act(() => {
      container.querySelector('button')?.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('stays focusable and ignores clicks while busy', () => {
    expect(render({})).not.toMatch(/aria-busy|aria-disabled/);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onClick = vi.fn<() => void>();
    act(() => {
      root.render(createElement(TextToggle, { onClick, busy: true, children: 'Closing I7' }));
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.hasAttribute('disabled')).toBe(false);
    act(() => {
      button?.click();
    });
    expect(onClick).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('Chip wrap', () => {
  it('adds one class only when asked; by default a chip stays on one line', () => {
    const classes = (wrap?: boolean) =>
      /^<span class="([^"]+)">/
        .exec(renderToStaticMarkup(createElement(Chip, { tone: 'warn', wrap, children: 'x' })))?.[1]
        ?.split(' ');
    expect(classes()).toHaveLength(2);
    expect(classes(false)).toEqual(classes());
    expect(classes(true)).toEqual([...(classes() ?? []), expect.any(String)]);
  });
});

describe('Chip tints', () => {
  it('add one tone class to the default chip', () => {
    for (const tone of ['ready', 'error'] as const) {
      const html = renderToStaticMarkup(createElement(Chip, { tone, children: tone }));
      const classes = /^<span class="([^"]+)">/.exec(html)?.[1]?.split(' ');
      expect(classes).toHaveLength(2);
    }
  });
});
