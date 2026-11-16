// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../src/ds/index.ts';
import {
  button,
  bodyOf,
  container,
  dialogs,
  example,
  examples,
  key,
  layerRoot,
  mountEachTest,
  openOverPanel,
  panel,
  press,
  render,
  top,
} from './ds-layers-helpers.ts';

mountEachTest();

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
    // Close to the body is the layer's own move too.
    act(() => {
      close.focus();
    });
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body);
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
    expect(container().hasAttribute('inert')).toBe(true);
    expect(panelRoot.hasAttribute('inert')).toBe(false);
    press(button('Open task 509', top()));
    const modalRoot = layerRoot(top());
    expect(container().hasAttribute('inert')).toBe(true);
    expect(panelRoot.hasAttribute('inert')).toBe(true);
    expect(modalRoot.hasAttribute('inert')).toBe(false);
    key('Escape');
    expect(panelRoot.hasAttribute('inert')).toBe(false);
    expect(container().hasAttribute('inert')).toBe(true);
    key('Escape');
    expect(container().hasAttribute('inert')).toBe(false);
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
    expect(container().hasAttribute('inert')).toBe(false);
  });

  it('has the examples the gallery shows', () => {
    const names = (folder: string) =>
      Object.keys(examples[`../src/ds/${folder}/${folder}.examples.tsx`] ?? {}).sort();
    expect(names('Modal')).toEqual(['Default', 'Focused', 'OverPanel']);
    expect(names('SidePanel')).toEqual(['Focused', 'Left', 'Right']);
    expect(names('Scrim')).toEqual(['Default']);
  });

  it('Scrim / Default covers its box and hides on click', () => {
    render(createElement(example('Scrim', 'Default')));
    press(button('Show scrim'));
    const scrim = container().querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(scrim?.parentElement?.style.position).toBe('relative');
    act(() => {
      scrim?.click();
    });
    expect(container().querySelector('[aria-hidden="true"]')).toBeNull();
    expect(button('Show scrim')).toBeTruthy();
  });
});
