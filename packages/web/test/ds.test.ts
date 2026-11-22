import { createElement, type ComponentProps, type ComponentType, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSync } from 'vite';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Button,
  Chip,
  focusRing,
  FormRow,
  IconButton,
  KeyValueBox,
  StatusDot,
  TextArea,
  TextInput,
  type KeyValueRow,
} from '../src/ds/index.ts';
import indexSource from '../src/ds/index.ts?raw';

// Keys only: Vitest returns an empty string for CSS read through a query.
const files = Object.keys(import.meta.glob('../src/ds/*/*.{tsx,css}'));
const examples: Record<string, Record<string, unknown>> = import.meta.glob(
  '../src/ds/*/*.examples.tsx',
  { eager: true },
);

/**
 * ds/index.ts exports values only as `export { ... } from './<Name>/<Name>.tsx'`; type-only
 * exports are free. Every component so re-exported needs `<Name>.module.css` and a
 * `<Name>.examples.tsx` with at least one named export.
 */
function checkDesignSystem(
  source: string,
  paths: readonly string[],
  modules: Record<string, Record<string, unknown>>,
) {
  const problems: string[] = [];
  const folders = new Set<string>();
  for (const node of parseSync('index.ts', source).program.body) {
    const unsupported = () =>
      problems.push(`unsupported export: ${source.slice(node.start, node.end)}`);
    if (node.type === 'ExportAllDeclaration') problems.push(`export * from ${node.source.value}`);
    if (node.type === 'ExportDefaultDeclaration' || node.type === 'TSExportAssignment')
      unsupported();
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    if (node.declaration) {
      unsupported();
      continue;
    }
    if (node.specifiers.every((specifier) => specifier.exportKind === 'type')) continue;
    const name = node.source && /^\.\/(\w+)\/\1\.tsx$/.exec(node.source.value)?.[1];
    if (name) folders.add(name);
    else unsupported();
  }
  const sorted = [...folders].sort();
  for (const name of sorted) {
    const base = `../src/ds/${name}/${name}`;
    if (!paths.includes(`${base}.examples.tsx`)) problems.push(`${name}: missing examples`);
    else if (Object.keys(modules[`${base}.examples.tsx`] ?? {}).length === 0)
      problems.push(`${name}: no examples`);
    if (!paths.includes(`${base}.module.css`)) problems.push(`${name}: missing css`);
  }
  return { problems, folders: sorted };
}

describe('design system examples rule', () => {
  it('passes on the real tree and counts each value-exported component', () => {
    expect(checkDesignSystem(indexSource, files, examples)).toEqual({
      problems: [],
      folders: [
        'Banner',
        'Breakpoints',
        'Button',
        'Chip',
        'CollapsibleSection',
        'FocusRing',
        'FormRow',
        'HoverMenu',
        'Icon',
        'IconButton',
        'KeyValueBox',
        'LineClamp',
        'Logo',
        'Meter',
        'Modal',
        'Popover',
        'Quiet',
        'Scrim',
        'SidePanel',
        'Skeleton',
        'StatusDot',
        'Tabs',
        'TextArea',
        'TextInput',
        'TextToggle',
        'ThemeSwitch',
      ],
    });
    for (const module of Object.values(examples))
      expect(Object.keys(module).length).toBeGreaterThan(0);
  });

  it('reports missing examples and css for a value re-export', () => {
    expect(
      checkDesignSystem("export { Ghost } from './Ghost/Ghost.tsx';", [], {}).problems,
    ).toEqual(['Ghost: missing examples', 'Ghost: missing css']);
  });

  it('reports an examples module with no named export', () => {
    const paths = ['../src/ds/Ghost/Ghost.examples.tsx', '../src/ds/Ghost/Ghost.module.css'];
    const modules = { '../src/ds/Ghost/Ghost.examples.tsx': {} };
    expect(
      checkDesignSystem("export { Ghost } from './Ghost/Ghost.tsx';", paths, modules).problems,
    ).toEqual(['Ghost: no examples']);
  });

  it('skips type-only re-exports', () => {
    expect(
      checkDesignSystem("export type { GhostTone } from './Ghost/Ghost.tsx';", [], {}),
    ).toEqual({ problems: [], folders: [] });
    expect(
      checkDesignSystem("export { type GhostTone } from './Ghost/Ghost.tsx';", [], {}),
    ).toEqual({ problems: [], folders: [] });
  });

  it.each([
    [
      "import { Ghost } from './Ghost/Ghost.tsx';\nexport { Ghost };",
      ['unsupported export: export { Ghost };'],
    ],
    ['export const ghost = 1;', ['unsupported export: export const ghost = 1;']],
    ['export function Ghost() {}', ['unsupported export: export function Ghost() {}']],
    ['export default 1;', ['unsupported export: export default 1;']],
    [
      "export { ghost } from './ghost.ts';",
      ["unsupported export: export { ghost } from './ghost.ts';"],
    ],
    ["import type { GhostTone } from './Ghost/Ghost.tsx';\nexport type { GhostTone };", []],
    ["import type { GhostTone } from './Ghost/Ghost.tsx';\nexport { type GhostTone };", []],
    ["export type GhostTone = 'a';", []],
    ['export interface GhostProps {}', []],
  ])('accepts only value re-exports from a component folder: %s', (source, problems) => {
    expect(checkDesignSystem(source, [], {})).toEqual({ problems, folders: [] });
  });

  it('reports export star', () => {
    expect(checkDesignSystem("export * from './Chip/Chip.tsx';", [], {}).problems).toEqual([
      'export * from ./Chip/Chip.tsx',
    ]);
  });
});

const render = (example: unknown) => renderToStaticMarkup(createElement(example as ComponentType));

describe('StatusDot and Chip', () => {
  it('StatusDot working and Chip title render; defaults unchanged', () => {
    const dot = (tone: ComponentProps<typeof StatusDot>['tone']) =>
      markup(createElement(StatusDot, { tone }));
    const working = dot('working');
    expect(working).toContain('aria-hidden="true"');
    expect(new Set([working, dot('ok'), dot('warn'), dot('error'), dot('unknown')]).size).toBe(5);
    expect(markup(createElement(Chip, { children: 'draft' }))).not.toContain('title=');
    expect(markup(createElement(Chip, { tone: 'you', children: 'B1' }))).not.toContain('title=');
    expect(markup(createElement(Chip, { title: 'Open blocks: B7', children: '+1' }))).toContain(
      'title="Open blocks: B7"',
    );
    expect(Object.keys(examples['../src/ds/StatusDot/StatusDot.examples.tsx'] ?? {})).toContain(
      'Working',
    );
    expect(Object.keys(examples['../src/ds/Chip/Chip.examples.tsx'] ?? {})).toContain('Titled');
  });
});

const controlFolders = ['Button', 'FormRow', 'IconButton', 'TextArea', 'TextInput'];
const controlExamples = (folder: string) =>
  examples[`../src/ds/${folder}/${folder}.examples.tsx`] ?? {};
const markup = (element: ReactElement) => renderToStaticMarkup(element);
const attribute = (html: string, name: string) => new RegExp(`${name}="([^"]+)"`).exec(html)?.[1];
const onChange = () => undefined;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('controls and form fields', () => {
  it('has the examples the gallery shows', () => {
    expect(
      Object.fromEntries(controlFolders.map((f) => [f, Object.keys(controlExamples(f))])),
    ).toEqual({
      Button: ['Primary', 'Outlined', 'Disabled', 'Busy', 'Disclosure', 'DescribedBy', 'Focused'],
      FormRow: ['Answer', 'Error', 'Sending', 'Disabled', 'SendFails', 'NarrowActions'],
      IconButton: ['Close', 'InActions', 'Disabled', 'Focused'],
      TextArea: ['Empty', 'Typing', 'Disabled', 'Focused'],
      TextInput: ['Empty', 'WithValue', 'Disabled', 'InFormRow', 'Focused'],
    });
  });

  it('busy button stays focusable, exposes aria-busy and ignores clicks', () => {
    const busy = markup(createElement(Button, { busy: true, children: 'Sending' }));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).not.toContain(' disabled=""');
    const disabled = markup(createElement(Button, { disabled: true, children: 'Send' }));
    expect(disabled).toContain(' disabled=""');
    expect(disabled).not.toContain('aria-busy');
    const [primary, outlined] = (['primary', 'outlined'] as const).map((variant) =>
      markup(createElement(Button, { variant, children: 'Send' })),
    );
    for (const html of [primary, outlined]) expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(primary).not.toBe(outlined);

    // Button has no hooks, so calling it reads the click handler it renders.
    const click = (busyNow: boolean) => {
      const onClick = vi.fn();
      const preventDefault = vi.fn();
      const element = Button({ busy: busyNow, onClick, children: 'Send' }) as ReactElement<{
        onClick: (event: { preventDefault: () => void }) => void;
      }>;
      element.props.onClick({ preventDefault });
      return {
        onClick: onClick.mock.calls.length,
        preventDefault: preventDefault.mock.calls.length,
      };
    };
    expect(click(true)).toEqual({ onClick: 0, preventDefault: 1 });
    expect(click(false)).toEqual({ onClick: 1, preventDefault: 0 });
  });

  it('button renders aria-expanded and aria-controls only when passed', () => {
    const html = (props: Partial<ComponentProps<typeof Button>>) =>
      markup(createElement(Button, { ...props, children: 'stand' }));
    expect(html({})).not.toMatch(/aria-(expanded|controls)/);
    expect(html({ expanded: false, controls: 'list' })).toMatch(
      / aria-expanded="false" aria-controls="list"/,
    );
    expect(html({ expanded: true })).toMatch(/^<button[^>]* aria-expanded="true">/);
  });

  it('button renders aria-describedby only when passed', () => {
    const html = (props: Partial<ComponentProps<typeof Button>>) =>
      markup(createElement(Button, { ...props, children: 'Close the turn' }));
    expect(html({ describedBy: 'line' })).toMatch(/^<button[^>]* aria-describedby="line"/);
    expect(html({})).not.toContain('aria-describedby');
  });

  it('icon button names itself from label and hides its icon', () => {
    const html = markup(createElement(IconButton, { icon: 'x', label: 'Close' }));
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close"');
    expect(/<svg[^>]*>/.exec(html)?.[0]).toContain('aria-hidden="true"');
    expectTypeOf<{ icon: 'x' }>().not.toExtend<ComponentProps<typeof IconButton>>();
  });

  it.each([
    {
      tag: 'textarea',
      value: '>draft</textarea>',
      field: () => createElement(TextArea, { value: 'draft', onChange }),
    },
    {
      tag: 'input',
      value: 'value="draft"',
      field: () => createElement(TextInput, { value: 'draft', onChange, label: 'Commit' }),
    },
  ])('form row links label, hint and error to the $tag field', ({ tag, value, field }) => {
    const hint = 'The agent reads it on its next turn';
    const error = 'Not sent: the daemon did not answer.';
    const row = (note: { hint: string } | { hint: string; error: string }) =>
      markup(
        createElement(FormRow, {
          label: 'Answer B89',
          ...note,
          actions: createElement(Button, { children: 'Send' }),
          children: field(),
        }),
      );
    const fieldTag = (html: string) => new RegExp(`<${tag}[^>]*>`).exec(html)?.[0] ?? '';
    for (const [html, text] of [
      [row({ hint }), hint],
      [row({ hint, error }), error],
    ] as const) {
      const id = attribute(html, 'for');
      expect(id).toBeDefined();
      expect(attribute(fieldTag(html), 'id')).toBe(id);
      expect(fieldTag(html)).not.toContain('aria-label');
      const describedBy = attribute(fieldTag(html), 'aria-describedby') ?? '';
      expect(html).toMatch(
        new RegExp(`<p[^>]*id="${escapeRegExp(describedBy)}"[^>]*>${escapeRegExp(text)}</p>`),
      );
      expect(html).toContain(value);
      const order = ['<label', `<${tag}`, text, '>Send</button>'].map((part) => html.indexOf(part));
      expect(
        order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? 0))),
      ).toBe(true);
    }
    const plain = row({ hint });
    expect(fieldTag(plain)).not.toContain('aria-invalid');
    expect(plain).not.toContain('role="alert"');
    const failed = row({ hint, error });
    expect(fieldTag(failed)).toContain('aria-invalid="true"');
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain(hint);
  });

  it('text input shows the clear action only with a value', () => {
    const input = (value: string, disabled = false) =>
      markup(
        createElement(TextInput, {
          value,
          onChange: () => undefined,
          label: 'Filter tasks',
          placeholder: 'Task key, session or block id',
          icon: 'search',
          disabled,
        }),
      );
    const empty = input('');
    expect(/<input[^>]*>/.exec(empty)?.[0]).not.toMatch(/ id=|aria-describedby|aria-invalid/);
    expect(empty).not.toContain('aria-label="Clear"');
    expect(empty).toContain('aria-label="Filter tasks"');
    expect(empty).toContain('placeholder="Task key, session or block id"');
    expect(empty).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*<input/s);
    expect(input('B89')).toContain('aria-label="Clear"');
    const disabled = input('B89', true);
    expect(disabled).not.toContain('aria-label="Clear"');
    expect(/<input[^>]*>/.exec(disabled)?.[0]).toContain('disabled=""');
  });

  it('every field in the new examples has an accessible name and no tabindex', () => {
    for (const folder of controlFolders)
      for (const [name, example] of Object.entries(controlExamples(folder))) {
        const html = render(example);
        expect(html, `${folder} / ${name}`).not.toMatch(/tabindex/i);
        for (const tag of html.match(/<(?:textarea|input)[^>]*>/g) ?? []) {
          const label = attribute(tag, 'aria-label');
          const id = attribute(tag, 'id');
          const named =
            (label !== undefined && label.trim() !== '') ||
            (id !== undefined && html.includes(`for="${id}"`));
          expect(named, `${folder} / ${name}: ${tag}`).toBe(true);
        }
      }
  });
});

describe('design system examples', () => {
  const cases = Object.entries(examples).flatMap(([path, module]) =>
    Object.entries(module).map(([name, example]) => ({ label: `${path} ${name}`, example })),
  );
  it.each(cases)('$label renders with zero props', ({ example }) => {
    expect(example).toBeTypeOf('function');
    const error = vi.spyOn(console, 'error');
    try {
      const html = renderToStaticMarkup(createElement(example as ComponentType));
      expect(html).not.toBe('');
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('KeyValueBox', () => {
  const render = (rows: readonly KeyValueRow[], title?: string) =>
    renderToStaticMarkup(createElement(KeyValueBox, { rows, title }));
  const count = (html: string, text: string) =>
    html.toLowerCase().split(text.toLowerCase()).length - 1;

  it('marks each status row and puts each status word in the DOM once', () => {
    const html = render([
      { key: 'PR open', value: 'met', status: 'pass' },
      { key: 'Checks green', value: 'checks pending', status: 'wait' },
      { key: 'PR exists', value: 'no PR', status: 'fail' },
      { key: 'Merged', status: 'unchecked' },
      { key: 'Open turn', value: 'none' },
    ]);
    for (const status of ['pass', 'wait', 'fail', 'unchecked'])
      expect(count(html, `data-status="${status}"`)).toBe(1);
    expect(count(html, 'data-status=')).toBe(4);
    for (const word of ['passed', 'waiting', 'failed', 'not checked'])
      expect(count(html, word)).toBe(1);
    expect(count(html, 'aria-hidden="true"')).toBe(4);
    expect(html).toContain('Open turn');
    expect(html).toContain('none');
  });

  it('does not repeat a word the value already says, and shows it for a message row', () => {
    const html = render([
      { key: 'Merged', value: 'Not checked', status: 'unchecked' },
      { key: 'Spur unavailable', status: 'fail' },
    ]);
    expect(count(html, 'not checked')).toBe(1);
    expect(count(html, 'failed')).toBe(1);
    // A null value is no value: the same visible word and message key as an omitted one.
    const message = render([{ key: 'Spur unavailable', status: 'fail' }]);
    const nullValue = render([{ key: 'Spur unavailable', value: null, status: 'fail' }]);
    expect(count(nullValue, 'failed')).toBe(1);
    expect(nullValue).toBe(message);
  });

  it('renders the title only when given, and nothing for no rows and no title', () => {
    expect(render([{ key: 'CPU', value: '—' }], 'github pull requests')).toContain(
      'github pull requests',
    );
    expect(render([{ key: 'CPU', value: '—' }])).not.toContain('github');
    expect(render([], 'github pull requests')).toContain('github pull requests');
    expect(render([])).toBe('');
  });
});

describe('Chip', () => {
  it('with href renders a new-tab link named from its visible text and keeps the plain span', () => {
    const plain = markup(createElement(Chip, { children: 'session s1' }));
    expect(plain).toMatch(/^<span class="[^"]+">session s1<\/span>$/);
    expect(markup(createElement(Chip, { label: 'ignored', children: 'session s1' }))).toBe(plain);
    const link = markup(
      createElement(Chip, {
        href: 'https://github.com/o/r/pull/12',
        label: 'PR #12, o/r',
        children: 'PR #12',
      }),
    );
    expect(link).toMatch(/^<a /);
    expect(link).toContain('href="https://github.com/o/r/pull/12"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain('aria-label="PR #12, o/r"');
    expect(attribute(link, 'class')?.split(' ')).toContain(focusRing);
    expect(Object.keys(controlExamples('Chip'))).toEqual([
      'Default',
      'Warn',
      'You',
      'Ghost',
      'Titled',
      'Wrapping',
      'Link',
      'LinkFocused',
      'ReadyTint',
      'ReadyTintIcon',
      'ErrorTint',
      'ErrorTintIcon',
    ]);
    for (const name of ['Link', 'LinkFocused']) {
      const html = markup(createElement(controlExamples('Chip')[name] as ComponentType));
      const text = /<a [^>]*>([^<]+)<\/a>/.exec(html)?.[1] ?? '';
      expect(text).not.toBe('');
      expect(attribute(html, 'aria-label')?.startsWith(text)).toBe(true);
    }
  });
});
