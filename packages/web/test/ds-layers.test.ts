// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, SidePanel } from '../src/ds/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const examples: Record<string, Record<string, ComponentType>> = import.meta.glob(
  [
    '../src/ds/Modal/*.examples.tsx',
    '../src/ds/SidePanel/*.examples.tsx',
    '../src/ds/Scrim/*.examples.tsx',
  ],
  { eager: true },
);
const example = (folder: string, name: string): ComponentType => {
  const found = examples[`../src/ds/${folder}/${folder}.examples.tsx`]?.[name];
  if (!found) throw new Error(`no example ${folder} / ${name}`);
  return found;
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.documentElement.style.overflow = '';
});

const render = (node: ReactNode) => {
  act(() => {
    root.render(node);
  });
};
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const top = () => {
  const found = dialogs().at(-1);
  if (!found) throw new Error('no dialog');
  return found;
};
const layerRoot = (dialog: HTMLElement) => {
  const found = dialog.parentElement;
  if (!found) throw new Error('no layer root');
  return found;
};
const button = (name: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const bodyOf = (dialog: HTMLElement) => {
  const found = dialog.lastElementChild;
  if (!(found instanceof HTMLElement)) throw new Error('no body');
  return found;
};
// Focus first, as a mouse click in Chrome or a keyboard press does: the layer reads the opener.
const press = (target: HTMLElement) => {
  act(() => {
    target.focus();
    target.click();
  });
};
const key = (name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: name,
    ...init,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};
const openOverPanel = () => {
  render(createElement(example('Modal', 'OverPanel')));
  press(button('Open inbox'));
  const opener = button('Open task 509', top());
  press(opener);
  return opener;
};
const panel = (props: Partial<Parameters<typeof SidePanel>[0]> = {}) =>
  createElement(SidePanel, {
    open: true,
    onClose: () => undefined,
    title: 'Inbox',
    children: 'Items',
    ...props,
  });

describe('Modal and SidePanel', () => {
  it('labels the dialog by its title', () => {
    render(
      createElement(Modal, {
        open: true,
        onClose: () => undefined,
        title: 'Task 509',
        detail: 'review · 2h',
        children: 'Body',
      }),
    );
    const dialog = top();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const label = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('Task 509');
    expect(dialog.contains(label)).toBe(true);
  });

  it('renders title, detail, actions, close and body in order', () => {
    const onClose = vi.fn();
    render(
      createElement(Modal, {
        open: true,
        onClose,
        title: 'Task 509',
        detail: 'review · 2h',
        actions: createElement('span', { 'data-testid': 'actions' }, 'Tabs'),
        children: 'Body',
      }),
    );
    const dialog = top();
    expect(dialog.hasAttribute('tabindex')).toBe(false);
    expect(dialog.hasAttribute('data-side')).toBe(false);
    const [header, body] = [...dialog.children] as HTMLElement[];
    const parts = [...(header?.children ?? [])];
    expect(parts.map((part) => part.textContent)).toEqual(['Task 509', 'review · 2h', 'Tabs', '']);
    expect(parts[3]?.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
    expect(body?.textContent).toBe('Body');
    expect(body?.getAttribute('tabindex')).toBe('0');
    // The scrim comes first in the layer root, under the surface.
    const scrim = layerRoot(dialog).firstElementChild;
    expect(scrim?.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      (scrim as HTMLElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    render(createElement(Modal, { open: false, onClose, title: 'Task 509', children: 'Body' }));
    for (const side of ['right', 'left'] as const) {
      render(panel({ side, icon: 'inbox', detail: '3 wait for you' }));
      const surface = top();
      expect(surface.getAttribute('data-side')).toBe(side);
      const items = [...(surface.firstElementChild?.children ?? [])];
      expect(items.map((item) => item.tagName.toLowerCase())).toEqual([
        'svg',
        'span',
        'span',
        'span',
      ]);
      expect(items.map((item) => item.textContent)).toEqual(['', 'Inbox', '3 wait for you', '']);
      render(null);
    }
    render(panel());
    expect(top().getAttribute('data-side')).toBe('right');
    expect([...(top().firstElementChild?.children ?? [])].map((item) => item.textContent)).toEqual([
      'Inbox',
      '',
    ]);
  });

  it('focus moves to close on open', () => {
    render(createElement(example('SidePanel', 'Right')));
    press(button('Open right panel'));
    expect(document.activeElement).toBe(button('Close', top()));
  });

  it('Escape closes only the top layer', () => {
    openOverPanel();
    expect(dialogs()).toHaveLength(2);
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(dialogs()).toHaveLength(1);
    expect(top().getAttribute('data-side')).toBe('right');
    key('Escape');
    expect(dialogs()).toHaveLength(0);

    // Consumed by an earlier handler, or part of an IME composition: nothing closes.
    openOverPanel();
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
    };
    document.addEventListener('keydown', consume);
    key('Escape');
    document.removeEventListener('keydown', consume);
    expect(dialogs()).toHaveLength(2);
    expect(key('Escape', { isComposing: true }).defaultPrevented).toBe(false);
    expect(dialogs()).toHaveLength(2);
    render(null);

    // The latest render's onClose runs.
    const first = vi.fn();
    const second = vi.fn();
    render(panel({ onClose: first }));
    render(panel({ onClose: second }));
    key('Escape');
    act(() => {
      (layerRoot(top()).firstElementChild as HTMLElement).click();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  describe('focus returns to the opener', () => {
    // Emulates browser focus fixup: an element that turns inert loses focus to body.
    beforeEach(() => {
      // The originals, taken before the spies replace them.
      type Method = (this: Element, ...args: unknown[]) => unknown;
      const setAttribute = Reflect.get(Element.prototype, 'setAttribute') as Method;
      const toggleAttribute = Reflect.get(Element.prototype, 'toggleAttribute') as Method;
      const fixup = (element: Element, name: string) => {
        const active = document.activeElement;
        if (name === 'inert' && element.hasAttribute('inert') && active && element.contains(active))
          (active as HTMLElement).blur();
      };
      vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
        this: Element,
        name: string,
        value: string,
      ) {
        setAttribute.call(this, name, value);
        fixup(this, name);
      });
      vi.spyOn(Element.prototype, 'toggleAttribute').mockImplementation(function (
        this: Element,
        name: string,
        force?: boolean,
      ) {
        const result = toggleAttribute.call(this, name, force) as boolean;
        fixup(this, name);
        return result;
      });
    });

    it('returns focus into the panel when the modal over it closes', () => {
      const opener = openOverPanel();
      expect(document.activeElement).toBe(button('Close', top()));
      key('Escape');
      expect(document.activeElement).toBe(opener);
      key('Escape');
      expect(document.activeElement).toBe(button('Open inbox'));
    });

    it('returns focus to the gallery opener of a single panel', () => {
      render(createElement(example('SidePanel', 'Left')));
      const opener = button('Open left panel');
      press(opener);
      key('Escape');
      expect(document.activeElement).toBe(opener);
    });

    it('leaves focus on the top layer when a lower layer closes', () => {
      const lower = (open: boolean) =>
        createElement(
          'div',
          null,
          open ? panel({ title: 'Lower' }) : null,
          createElement(Modal, {
            open: true,
            onClose: () => undefined,
            title: 'Top',
            children: 'x',
          }),
        );
      render(createElement('button', null, 'Opener'));
      button('Opener').focus();
      render(lower(true));
      const close = button('Close', top());
      expect(document.activeElement).toBe(close);
      render(lower(false));
      expect(dialogs()).toHaveLength(1);
      expect(document.activeElement).toBe(close);
    });
  });

  it('Tab cycles inside the open layer', () => {
    render(createElement(example('SidePanel', 'Left')));
    press(button('Open left panel'));
    const close = button('Close', top());
    const body = bodyOf(top());
    // Body is the last stop: Tab wraps to Close, Shift+Tab wraps back to the body.
    act(() => {
      body.focus();
    });
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body);
    // Close to the body is the browser's own move.
    act(() => {
      close.focus();
    });
    expect(key('Tab').defaultPrevented).toBe(false);
    // Focus outside the layer: Tab pulls it to the first stop, Shift+Tab to the last.
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    key('Tab');
    expect(document.activeElement).toBe(close);
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(body);
    // A Tab another handler took is left alone.
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
    };
    document.addEventListener('keydown', consume);
    key('Tab');
    document.removeEventListener('keydown', consume);
    expect(document.activeElement).toBe(body);
    render(null);

    // Modal over panel: Tab from the modal's last stop never reaches the panel.
    openOverPanel();
    const modal = top();
    const stops = [...modal.querySelectorAll<HTMLElement>('[tabindex="0"], button')].filter(
      (element) => element.getAttribute('tabindex') !== '-1',
    );
    act(() => {
      stops.at(-1)?.focus();
    });
    key('Tab');
    expect(document.activeElement).toBe(stops[0]);
    expect(modal.contains(document.activeElement)).toBe(true);
    act(() => {
      button('Open task 509').focus();
    });
    key('Tab');
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it('locks page scroll until the last layer closes', () => {
    document.documentElement.style.overflow = 'scroll';
    openOverPanel();
    expect(document.documentElement.style.overflow).toBe('hidden');
    key('Escape');
    expect(document.documentElement.style.overflow).toBe('hidden');
    key('Escape');
    expect(document.documentElement.style.overflow).toBe('scroll');
  });

  it('makes everything outside the top layer inert and restores it', () => {
    const preset = document.createElement('div');
    preset.setAttribute('inert', '');
    document.body.append(preset);
    render(createElement(example('Modal', 'OverPanel')));
    press(button('Open inbox'));
    const panelRoot = layerRoot(top());
    expect(container.hasAttribute('inert')).toBe(true);
    expect(panelRoot.hasAttribute('inert')).toBe(false);
    press(button('Open task 509', top()));
    const modalRoot = layerRoot(top());
    expect(container.hasAttribute('inert')).toBe(true);
    expect(panelRoot.hasAttribute('inert')).toBe(true);
    expect(modalRoot.hasAttribute('inert')).toBe(false);
    key('Escape');
    expect(panelRoot.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('inert')).toBe(true);
    key('Escape');
    expect(container.hasAttribute('inert')).toBe(false);
    expect(preset.hasAttribute('inert')).toBe(true);
  });

  it('StrictMode keeps one entry per layer', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const keydowns = (spy: typeof add) =>
      spy.mock.calls.filter(([type]) => type === 'keydown').length;
    document.documentElement.style.overflow = 'scroll';
    render(createElement(StrictMode, null, createElement(example('Modal', 'OverPanel'))));
    press(button('Open inbox'));
    press(button('Open task 509', top()));
    expect(dialogs()).toHaveLength(2);
    expect(keydowns(add) - keydowns(remove)).toBe(1);
    key('Escape');
    expect(dialogs()).toHaveLength(1);
    key('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(keydowns(add) - keydowns(remove)).toBe(0);
    expect(document.documentElement.style.overflow).toBe('scroll');
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('has the examples the gallery shows', () => {
    const names = (folder: string) =>
      Object.keys(examples[`../src/ds/${folder}/${folder}.examples.tsx`] ?? {}).sort();
    expect(names('Modal')).toEqual(['Default', 'OverPanel']);
    expect(names('SidePanel')).toEqual(['Left', 'Right']);
    expect(names('Scrim')).toEqual(['Default']);
  });

  it('Scrim / Default covers its box and hides on click', () => {
    render(createElement(example('Scrim', 'Default')));
    press(button('Show scrim'));
    const scrim = container.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(scrim?.parentElement?.style.position).toBe('relative');
    act(() => {
      scrim?.click();
    });
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(button('Show scrim')).toBeTruthy();
  });
});
