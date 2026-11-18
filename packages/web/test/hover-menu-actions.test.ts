// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { HoverMenu, type HoverMenuItem } from '../src/ds/index.ts';

// The theme menu's behaviour is in hover-menu.test.ts; this file covers the opening direction,
// the action variant, disabled items, causes, groups and the note.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Choice = 'light' | 'dark' | 'auto';
const items: readonly HoverMenuItem<Choice>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];
const moves: readonly HoverMenuItem<string>[] = [
  { value: 'top', label: 'Move to top', disabled: true, cause: 'Already first' },
  { value: 'bottom', label: 'Move to bottom' },
  { value: 'todo', label: 'Move to todo…', group: 'part' },
  { value: 'ready', label: 'Move to ready…', group: 'part', disabled: true, cause: 'Mirrored' },
];
type Props = Parameters<typeof HoverMenu<string>>[0];

let container: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn<(value: string) => void>>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSelect = vi.fn<(value: string) => void>();
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
      createElement(HoverMenu<string>, {
        label: 'Move this task',
        icon: 'moon',
        items: moves,
        onSelect,
        variant: 'action',
        ...props,
      } as Props),
    );
  });
}
const menuRoot = () => {
  const found = container.firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error('no root');
  return found;
};
const trigger = () => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!found) throw new Error('no trigger');
  return found;
};
const menu = () => container.querySelector<HTMLElement>('[role="menu"]');
const actions = () => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const action = (index: number) => {
  const found = actions()[index];
  if (!found) throw new Error(`no item ${String(index)}`);
  return found;
};
const fire = (target: EventTarget, event: Event) => {
  act(() => {
    target.dispatchEvent(event);
  });
};
const click = (target: Element, detail: number) => {
  fire(target, new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
};
const key = (target: EventTarget, name: string) => {
  fire(target, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name }));
};
// Enter and Space on a focused button arrive as a click with detail 0.
const press = (target: Element, name: string) => {
  key(target, name);
  click(target, 0);
};
const described = (element: Element) => {
  const id = element.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
};

describe('HoverMenu opening and actions', () => {
  it('(o) marks the root data-opens="down" only when it opens downward', () => {
    mount({ variant: 'choice', items, opens: 'down', defaultOpen: true });
    expect(menuRoot().dataset['opens']).toBe('down');
    mount({ variant: 'choice', items, opens: 'up' });
    expect(menuRoot().dataset['opens']).toBeUndefined();
    mount({ variant: 'choice', items });
    expect(menuRoot().hasAttribute('data-opens')).toBe(false);
  });

  it('(p) action items are menuitems with no checked state or tick; one choice closes', () => {
    mount({ items: moves.map(({ value, label }) => ({ value, label })) });
    click(trigger(), 1);
    expect(actions()).toHaveLength(4);
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    for (const item of actions()) expect(item.hasAttribute('aria-checked')).toBe(false);
    expect(menu()?.querySelectorAll('svg')).toHaveLength(0);
    click(action(1), 1);
    expect(onSelect.mock.calls).toEqual([['bottom']]);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('(q) a disabled item names its cause and ignores click, Enter and Space', () => {
    mount();
    key(trigger(), 'ArrowDown');
    const top = action(0);
    expect(top.getAttribute('aria-disabled')).toBe('true');
    expect(top.hasAttribute('disabled')).toBe(false);
    const cause = described(top);
    expect(cause?.textContent).toBe('Already first');
    expect(cause?.hidden).toBe(false);
    expect(cause?.getAttribute('aria-hidden')).toBeNull();
    expect(action(1).hasAttribute('aria-disabled')).toBe(false);
    expect(action(1).hasAttribute('aria-describedby')).toBe(false);
    click(top, 1);
    press(top, 'Enter');
    press(top, ' ');
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(top);
  });

  it('(r) arrows and End land on disabled items', () => {
    mount();
    key(trigger(), 'ArrowDown');
    key(action(0), 'ArrowDown');
    expect(document.activeElement).toBe(action(1));
    key(action(1), 'ArrowDown');
    key(action(2), 'ArrowDown');
    expect(document.activeElement).toBe(action(3));
    key(action(3), 'Home');
    expect(document.activeElement).toBe(action(0));
    key(action(0), 'End');
    expect(document.activeElement).toBe(action(3));
    key(action(3), 'ArrowDown');
    expect(document.activeElement).toBe(action(0));
  });

  it('(s) one rule separates two groups; one group has none', () => {
    mount({ defaultOpen: true });
    const rules = menu()?.querySelectorAll('[role="separator"]') ?? [];
    expect(rules).toHaveLength(1);
    expect(action(2).previousElementSibling).toBe(rules[0]);
    expect(rules[0]?.previousElementSibling).toBe(action(1));
    mount({ items: moves.map((item) => ({ ...item, group: 'part' })), defaultOpen: true });
    expect(menu()?.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });

  it('(t) the note is the last element of the menu and describes it', () => {
    mount({ note: 'Ready mirrors a GitHub Project.', defaultOpen: true });
    const note = menu()?.lastElementChild;
    expect(note?.textContent).toBe('Ready mirrors a GitHub Project.');
    expect(described(menu() ?? document.body)).toBe(note);
    mount({ defaultOpen: true });
    expect(menu()?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('(u) opening by keyboard focuses a disabled first item, which does nothing', () => {
    mount();
    trigger().focus();
    key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(action(0));
    press(action(0), 'Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(action(0));
  });

  it('(v) every direct menu child is an item, a rule or a none-role text line', () => {
    mount({ note: 'Ready mirrors a GitHub Project.', defaultOpen: true });
    const roles = [...(menu()?.children ?? [])].map((child) => child.getAttribute('role'));
    expect(roles).toEqual([
      'menuitem',
      'none',
      'menuitem',
      'separator',
      'menuitem',
      'menuitem',
      'none',
      'none',
    ]);
    expect(described(action(3))?.getAttribute('role')).toBe('none');
  });

  it('types: an action menu takes no value', () => {
    type ChoiceProps = Parameters<typeof HoverMenu<Choice>>[0];
    const base = {
      label: 'Theme',
      icon: 'moon' as const,
      items,
      onSelect: vi.fn<(value: Choice) => void>(),
    };
    expectTypeOf({ ...base, value: 'dark' as const }).toExtend<ChoiceProps>();
    expectTypeOf({
      ...base,
      variant: 'choice' as const,
      value: 'dark' as const,
    }).toExtend<ChoiceProps>();
    expectTypeOf({ ...base, variant: 'action' as const }).toExtend<ChoiceProps>();
    expectTypeOf({
      ...base,
      variant: 'action' as const,
      value: 'dark' as const,
    }).not.toExtend<ChoiceProps>();
  });
});
