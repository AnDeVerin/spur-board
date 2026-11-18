// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverMenu, type HoverMenuItem } from '../src/ds/index.ts';

// The theme menu's behaviour is in hover-menu.test.ts; this file covers the opening direction.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];
type Props = Parameters<typeof HoverMenu<Choice>>[0];

let container: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn<(value: Choice) => void>>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSelect = vi.fn<(value: Choice) => void>();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(props: Partial<Props> = {}) {
  act(() => {
    root.render(
      createElement(HoverMenu<Choice>, {
        label: 'Theme',
        icon: 'moon',
        items,
        onSelect,
        ...props,
      }),
    );
  });
}
const menuRoot = () => {
  const found = container.firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error('no root');
  return found;
};

describe('HoverMenu opening and actions', () => {
  it('(o) marks the root data-opens="down" only when it opens downward', () => {
    mount({ opens: 'down', defaultOpen: true });
    expect(menuRoot().dataset['opens']).toBe('down');
    mount({ opens: 'up' });
    expect(menuRoot().dataset['opens']).toBeUndefined();
    mount({});
    expect(menuRoot().hasAttribute('data-opens')).toBe(false);
  });
});
