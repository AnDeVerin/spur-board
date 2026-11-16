import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { SidePanel } from '../src/ds/index.ts';

// Shared by the happy-dom layer tests: ds-layers.test.ts and ds-layers-focus.test.ts.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const examples: Record<string, Record<string, ComponentType>> = import.meta.glob(
  [
    '../src/ds/Modal/*.examples.tsx',
    '../src/ds/SidePanel/*.examples.tsx',
    '../src/ds/Scrim/*.examples.tsx',
  ],
  { eager: true },
);
export const example = (folder: string, name: string): ComponentType => {
  const found = examples[`../src/ds/${folder}/${folder}.examples.tsx`]?.[name];
  if (!found) throw new Error(`no example ${folder} / ${name}`);
  return found;
};

let host: HTMLDivElement | undefined;
let root: Root | undefined;

/** The `#root` element the React root renders into; a fresh one for each test. */
export const container = (): HTMLDivElement => {
  if (!host) throw new Error('no container: call mountEachTest() in the test file');
  return host;
};

/** Gives each test a fresh React root in `#root` and clears the page after it. */
export function mountEachTest(): void {
  beforeEach(() => {
    host = document.createElement('div');
    host.id = 'root';
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.documentElement.style.overflow = '';
  });
}

/** Emulates browser focus fixup for each test: an element that turns inert loses focus to body. */
export function emulateFocusFixup(): void {
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
}

export const render = (node: ReactNode) => {
  act(() => {
    root?.render(node);
  });
};
export const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
export const top = () => {
  const found = dialogs().at(-1);
  if (!found) throw new Error('no dialog');
  return found;
};
export const layerRoot = (dialog: HTMLElement) => {
  const found = dialog.parentElement;
  if (!found) throw new Error('no layer root');
  return found;
};
export const button = (name: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
export const bodyOf = (dialog: HTMLElement) => {
  const found = dialog.lastElementChild;
  if (!(found instanceof HTMLElement)) throw new Error('no body');
  return found;
};
// Focus first, as a mouse click in Chrome or a keyboard press does: the layer reads the opener.
export const press = (target: HTMLElement) => {
  act(() => {
    target.focus();
    target.click();
  });
};
export const key = (name: string, init: KeyboardEventInit = {}) => {
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
export const openOverPanel = () => {
  render(createElement(example('Modal', 'OverPanel')));
  press(button('Open inbox'));
  const opener = button('Open task 509', top());
  press(opener);
  return opener;
};
export const panel = (props: Partial<Parameters<typeof SidePanel>[0]> = {}) =>
  createElement(SidePanel, {
    open: true,
    onClose: () => undefined,
    title: 'Inbox',
    children: 'Items',
    ...props,
  });
