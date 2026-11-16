// @vitest-environment happy-dom
import { createElement, Fragment, StrictMode, useLayoutEffect, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal, SidePanel } from '../src/ds/index.ts';
import {
  button,
  dialogs,
  emulateFocusFixup,
  example,
  key,
  mountEachTest,
  openOverPanel,
  panel,
  press,
  render,
  top,
} from './ds-layers-helpers.ts';

type By = 'autoFocus' | 'effect';
// A field that takes focus on mount: through `autoFocus`, or from its own layout effect, which
// runs before the layer's.
function Field({ by }: { by: By }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (by === 'effect') ref.current?.focus();
  }, [by]);
  return createElement('input', { ref, 'aria-label': 'Field', autoFocus: by === 'autoFocus' });
}

mountEachTest();

describe('focus returns to the opener', () => {
  emulateFocusFixup();

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

  // The inbox panel (or an outer modal) and the task layer (a modal unless `Inner` says
  // otherwise), nested in the inbox or as a sibling rendered before or after it. `field` puts a
  // `Field` first in the inbox or the task layer.
  type Layout = {
    place?: 'inside' | 'before' | 'after';
    Outer?: typeof Modal;
    Inner?: typeof Modal;
    field?: { layer: 'inbox' | 'task'; by: By };
  };
  function Stack({ place = 'inside', Outer = SidePanel, Inner = Modal, field }: Layout) {
    const [shown, setShown] = useState({ inbox: false, task: false });
    // Each handler is one state update: "Open both" mounts both layers in one commit, and
    // "Close both" unmounts them in one commit.
    const set = (change: Partial<typeof shown>) => () => {
      setShown((now) => ({ ...now, ...change }));
    };
    const fieldIn = (layer: 'inbox' | 'task') =>
      field?.layer === layer ? createElement(Field, { by: field.by }) : null;
    const modal = createElement(Inner, {
      open: shown.task,
      onClose: set({ task: false }),
      title: 'Task',
      children: createElement(
        Fragment,
        null,
        fieldIn('task'),
        createElement('button', { onClick: set({ inbox: false }) }, 'Close inbox'),
        createElement('button', { onClick: set({ inbox: false, task: false }) }, 'Close both'),
      ),
    });
    return createElement(
      'div',
      null,
      createElement('button', { onClick: set({ inbox: true }) }, 'Open inbox'),
      createElement('button', { onClick: set({ inbox: true, task: true }) }, 'Open both'),
      place === 'before' ? modal : null,
      createElement(Outer, {
        open: shown.inbox,
        onClose: set({ inbox: false }),
        title: 'Inbox',
        children: createElement(
          Fragment,
          null,
          fieldIn('inbox'),
          createElement('button', { onClick: set({ task: true }) }, 'Open task'),
          place === 'inside' ? modal : null,
        ),
      }),
      place === 'after' ? modal : null,
    );
  }
  const titleOf = (dialog: Element | null) =>
    document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent ?? '';
  const where = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return 'body';
    const dialog = active.closest<HTMLElement>('[role="dialog"]');
    const name = active.getAttribute('aria-label') ?? active.textContent;
    return dialog ? `${titleOf(dialog)} ${name}` : name;
  };
  const inert = () =>
    [...document.body.children]
      .filter((element) => element.hasAttribute('inert'))
      .map((element) => element.id || titleOf(element.querySelector('[role="dialog"]')))
      .sort();
  // Layer roots in document order, which is their paint order within one z level: bottom first.
  const open = () => dialogs().map(titleOf);
  const mount = (layout: Layout, strict?: boolean) => {
    const stack = createElement(Stack, layout);
    render(strict ? createElement(StrictMode, null, stack) : stack);
  };

  type Case = Layout & { name: string; clicks: string[]; strict?: boolean };
  const apart = ['Task Close', 'Inbox Open task', 'Open inbox'];
  const together = ['Task Close', 'Inbox Close', 'Open both'];
  const both = ['Open both'];
  it.each<Case & { focus: string[] }>([
    { name: 'panel, then its modal', clicks: ['Open inbox', 'Open task'], focus: apart },
    { name: 'panel and nested modal in one commit', clicks: both, focus: together },
    { name: 'the same under StrictMode', clicks: both, strict: true, focus: together },
    { name: 'sibling modal first, one commit', clicks: both, place: 'before', focus: together },
    { name: 'modal nested in a modal, one commit', clicks: both, Outer: Modal, focus: together },
    {
      name: 'panel nested in a panel, one commit',
      clicks: both,
      Inner: SidePanel,
      focus: together,
    },
    {
      name: 'sibling modal after a modal, one commit',
      clicks: both,
      place: 'after',
      Outer: Modal,
      focus: together,
    },
  ])('stacks layers in visual order: $name', ({ clicks, strict, focus, ...layout }) => {
    mount(layout, strict);
    for (const name of clicks) press(button(name));
    // Task is on top (page and outer layer inert) and its root is the last layer root, so it
    // also paints on top; each Escape closes the top layer.
    const after = [
      { open: ['Inbox', 'Task'], inert: ['Inbox', 'root'] },
      { open: ['Inbox'], inert: ['root'] },
      { open: [], inert: [] },
    ];
    for (const [step, expected] of after.entries()) {
      if (step > 0) key('Escape');
      const seen = { open: open(), inert: inert(), focus: where() };
      expect(seen).toEqual({ ...expected, focus: focus[step] });
    }
  });

  // Task opened from "Open task" inside the outer layer, which "Open inbox" opened from the page.
  // Each step is a button in the top layer or Escape; after each, the open layers and the focus.
  const sequential = ['Open inbox', 'Open task'];
  it.each<Case & { steps: [string, string[], string][]; opened?: string }>([
    {
      name: 'Escape twice',
      clicks: sequential,
      steps: [
        ['Escape', ['Inbox'], 'Inbox Open task'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'the panel closes with its modal open',
      clicks: sequential,
      steps: [['Close inbox', [], 'Open inbox']],
    },
    {
      name: 'the same under StrictMode',
      clicks: sequential,
      strict: true,
      steps: [['Close inbox', [], 'Open inbox']],
    },
    {
      name: 'panel and modal close in one commit',
      clicks: sequential,
      steps: [['Close both', [], 'Open inbox']],
    },
    {
      name: 'the outer of a modal in a modal closes',
      clicks: sequential,
      Outer: Modal,
      steps: [['Close inbox', [], 'Open inbox']],
    },
    {
      name: 'a sibling modal outlives its panel',
      clicks: sequential,
      place: 'after',
      steps: [
        ['Close inbox', ['Task'], 'Task Close inbox'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'a sibling modal first and its panel close in one commit',
      clicks: sequential,
      place: 'before',
      steps: [['Close both', [], 'Open inbox']],
    },
    {
      name: 'panel and nested modal opened in one commit, panel closes',
      clicks: both,
      steps: [['Close inbox', [], 'Open both']],
    },
    // A field that takes focus on mount keeps it, and is never the opener focus returns to.
    {
      name: 'an autoFocus field in the panel, then its modal',
      clicks: sequential,
      field: { layer: 'inbox', by: 'autoFocus' },
      steps: [
        ['Escape', ['Inbox'], 'Inbox Open task'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'a field the panel focuses in a mount layout effect, then its modal',
      clicks: sequential,
      field: { layer: 'inbox', by: 'effect' },
      steps: [['Close inbox', [], 'Open inbox']],
    },
    {
      name: 'an autoFocus field in the modal over the panel',
      clicks: sequential,
      field: { layer: 'task', by: 'autoFocus' },
      opened: 'Task Field',
      steps: [
        ['Escape', ['Inbox'], 'Inbox Open task'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'a field focused in a mount layout effect in the modal over the panel',
      clicks: sequential,
      field: { layer: 'task', by: 'effect' },
      opened: 'Task Field',
      steps: [
        ['Escape', ['Inbox'], 'Inbox Open task'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'an autoFocus field in a panel over a panel',
      clicks: sequential,
      Inner: SidePanel,
      field: { layer: 'task', by: 'autoFocus' },
      opened: 'Task Field',
      steps: [
        ['Escape', ['Inbox'], 'Inbox Open task'],
        ['Escape', [], 'Open inbox'],
      ],
    },
    {
      name: 'panel and nested modal with an autoFocus field opened in one commit',
      clicks: both,
      field: { layer: 'task', by: 'autoFocus' },
      opened: 'Task Field',
      steps: [
        ['Escape', ['Inbox'], 'Inbox Close'],
        ['Escape', [], 'Open both'],
      ],
    },
  ])('returns focus after teardown: $name', ({ clicks, strict, steps, opened, ...layout }) => {
    mount(layout, strict);
    for (const name of clicks) press(button(name));
    expect({ open: open(), focus: where() }).toEqual({
      open: ['Inbox', 'Task'],
      focus: opened ?? 'Task Close',
    });
    for (const [step, layers, focus] of steps) {
      if (step === 'Escape') key('Escape');
      else press(button(step, top()));
      expect({ step, open: open(), focus: where() }).toEqual({ step, open: layers, focus });
    }
  });

  // One layer opened from a page button, with a field that takes focus on mount.
  it.each<{ name: string; Outer: typeof Modal; by: By }>([
    { name: 'a modal with an autoFocus field', Outer: Modal, by: 'autoFocus' },
    { name: 'a modal focusing a field in a mount layout effect', Outer: Modal, by: 'effect' },
    { name: 'a panel with an autoFocus field', Outer: SidePanel, by: 'autoFocus' },
    { name: 'a panel focusing a field in a mount layout effect', Outer: SidePanel, by: 'effect' },
  ])('the field keeps focus and the page opener gets it back: $name', ({ Outer, by }) => {
    mount({ Outer, field: { layer: 'inbox', by } });
    press(button('Open inbox'));
    expect(where()).toBe('Inbox Field');
    key('Escape');
    expect({ open: open(), focus: where() }).toEqual({ open: [], focus: 'Open inbox' });
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
