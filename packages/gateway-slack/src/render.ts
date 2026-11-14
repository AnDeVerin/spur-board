import type { Action, Persona, RichText, RichTextInline } from '@spur-board/contracts';
import { z } from 'zod';
import { itemsOf } from './wire.ts';

/** Slack section mrkdwn is capped at 3000 characters; leave room for formatting. */
export const MAX_PART_TEXT = 2900;
/** Slack allows at most 10 elements in one context block. */
const MAX_CONTEXT_ELEMENTS = 10;
const MARKER_PREFIX = 'spur:';
const ORIGIN_PREFIX = 'spur-origin:';

const roleIcons: Record<Persona['role'], string> = {
  orchestrator: ':compass:',
  curator: ':classical_building:',
  worker: ':hammer:',
  board: ':clipboard:',
};

export function iconFor(persona: Persona): string {
  return persona.icon ?? roleIcons[persona.role];
}

function blockId(prefix: string, key: string): string | null {
  try {
    const id = `${prefix}${encodeURIComponent(key)}`;
    return id.length <= 255 ? id : null;
  } catch {
    return null;
  }
}

export function markerId(key: string): string | null {
  return blockId(MARKER_PREFIX, key);
}

export function originMarkerId(key: string): string | null {
  return blockId(ORIGIN_PREFIX, key);
}

const blockIdWire = z.object({ block_id: z.string() });

/** The string `block_id` of each block, in order; anything that is not a block list has none. */
function blockIds(blocks: unknown): string[] {
  return (itemsOf(blocks) ?? []).flatMap((block) => {
    const id = blockIdWire.safeParse(block).data?.block_id;
    return id === undefined ? [] : [id];
  });
}

export function markerFromBlocks(blocks: unknown): string | undefined {
  for (const id of blockIds(blocks)) {
    if (!id.startsWith(MARKER_PREFIX)) continue;
    try {
      return decodeURIComponent(id.slice(MARKER_PREFIX.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The first part of a multipart root also carries the unsuffixed delivery key. */
export function originKeyFromBlocks(blocks: unknown): string | undefined {
  for (const id of blockIds(blocks)) {
    if (!id.startsWith(ORIGIN_PREFIX)) continue;
    try {
      return decodeURIComponent(id.slice(ORIGIN_PREFIX.length));
    } catch {
      return undefined;
    }
  }
  return markerFromBlocks(blocks);
}

declare const mrkdwnBrand: unique symbol;
/** Slack mrkdwn whose outside text went through `escapeText`; only this module makes one. */
export type Mrkdwn = string & { readonly [mrkdwnBrand]: true };

/** The single `&<>` escaper: every piece of outside text reaches mrkdwn through it. */
function escapeText(value: string): Mrkdwn {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') as Mrkdwn;
}

/** Board markup: the literal parts are board source, every value is already `Mrkdwn`. */
function markup(parts: TemplateStringsArray, ...values: readonly Mrkdwn[]): Mrkdwn {
  return parts.reduce((out, part, index) => `${out}${values[index - 1] ?? ''}${part}`) as Mrkdwn;
}

function joined(values: readonly Mrkdwn[], separator: '' | '\n' | '\n\n'): Mrkdwn {
  return values.join(separator) as Mrkdwn;
}

/** Splitting on a newline never cuts an entity, so each line stays escaped. */
function lines(value: Mrkdwn): Mrkdwn[] {
  return value.split('\n') as Mrkdwn[];
}

const lookalikes = { '*': '∗', _: 'ˍ', '~': '∼' } as const;
type Mark = keyof typeof lookalikes;
const urlRun = /https?:\/\/\S+/g;
const wordChar = /[\p{L}\p{N}]/u;

/**
 * Swaps a `*`, `_` or `~` in outside text for a lookalike unless a letter or digit sits on both
 * sides of it (the node's start and end count as boundaries), so Slack cannot format it; `own`
 * is the span's mark and is always swapped. Marks inside `https?://` runs stay so Slack still
 * links the URL. Neighbours are read from the original text: `ˍ` is a letter (Lm). A mark at a
 * word edge changes copied bytes: `__init__` shows `ˍˍinitˍˍ`, `/srv/_config.yml` shows
 * `/srv/ˍconfig.yml`.
 */
function neutralize(text: string, own?: Mark): string {
  const urls = [...text.matchAll(urlRun)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
  return text.replace(/[*_~]/g, (found: string, index: number) => {
    const mark = found as Mark;
    if (mark === own) return lookalikes[mark];
    if (urls.some(([start, end]) => start <= index && index < end)) return mark;
    const before = text[index - 1];
    const after = text[index + 1];
    const inWord =
      before !== undefined && after !== undefined && wordChar.test(before) && wordChar.test(after);
    return inWord ? mark : lookalikes[mark];
  });
}

/** Slack applies `~` and `_` only within one line and not across edge spaces. */
function perLine(text: string, wrap: (line: Mrkdwn) => Mrkdwn): Mrkdwn {
  return joined(
    text.split('\n').map((line) => {
      const value = line.trim();
      return value.length === 0 ? escapeText('') : wrap(escapeText(value));
    }),
    '\n',
  );
}

const userId = /^[A-Za-z0-9_]+$/;

function inline(value: RichTextInline): Mrkdwn {
  switch (value.kind) {
    case 'text':
      return escapeText(neutralize(value.text));
    case 'emphasis':
      return markup`*${escapeText(neutralize(value.text, '*'))}*`;
    case 'code':
      return markup`\`${escapeText(value.text.replaceAll('`', '´'))}\``;
    case 'strike':
      return perLine(neutralize(value.text, '~'), (line) => markup`~${line}~`);
    case 'italic':
      return perLine(neutralize(value.text, '_'), (line) => markup`_${line}_`);
    case 'link':
      return markup`<${escapeText(value.url.replace(/[<>|]/g, ''))}|${escapeText(neutralize(value.text).replaceAll('|', '¦'))}>`;
    case 'mention':
      return userId.test(value.user)
        ? markup`<@${escapeText(value.user)}>`
        : escapeText(neutralize(`@${value.user}`));
  }
}

/**
 * Trailing context blocks become the elements of one context block after the section: at most
 * 10, the last joining any overflow by newlines. When any element would exceed one part, or
 * without other visible content, they stay paragraphs, so the section text carries every
 * character.
 */
export function splitContext(body: RichText): { body: RichText; context: Mrkdwn[] } {
  let end = body.length;
  while (end > 0 && body[end - 1]?.kind === 'context') end--;
  if (renderText(body.slice(0, end)).length === 0) return { body, context: [] };
  const context = body
    .slice(end)
    .map((block) =>
      block.kind === 'context' ? joined(block.children.map(inline), '') : escapeText(''),
    )
    .filter((text) => text.length > 0);
  const bounded = [
    ...context.slice(0, MAX_CONTEXT_ELEMENTS - 1),
    ...(context.length >= MAX_CONTEXT_ELEMENTS
      ? [joined(context.slice(MAX_CONTEXT_ELEMENTS - 1), '\n')]
      : []),
  ];
  if (bounded.some((text) => text.length > MAX_PART_TEXT)) return { body, context: [] };
  return { body: body.slice(0, end), context: bounded };
}

export function renderText(body: RichText): Mrkdwn {
  return joined(
    body
      .map((block) => {
        if (block.kind === 'code_block') {
          return markup`\`\`\`\n${escapeText(block.text.replaceAll('```', "'''"))}\n\`\`\``;
        }
        const value = joined(block.children.map(inline), '');
        return block.kind === 'quote'
          ? joined(
              lines(value).map((line) => markup`> ${line}`),
              '\n',
            )
          : value;
      })
      .filter((value) => value.length > 0),
    '\n\n',
  );
}

function literal(value: RichTextInline): string {
  switch (value.kind) {
    case 'text':
    case 'emphasis':
    case 'code':
    case 'strike':
    case 'italic':
      return value.text;
    case 'link':
      return `${value.text} (${value.url})`;
    case 'mention':
      return `<@${value.user}>`;
  }
}

/** Private replies use structured text so quoted data is never parsed as mrkdwn. */
export function renderResponse(body: RichText, cliHint?: string) {
  const pointer = cliHint === undefined ? '' : `More: ${cliHint} (CLI)`;
  const suffix = pointer === '' ? '' : `\n\n${pointer}`;
  let remaining = MAX_PART_TEXT - suffix.length;
  const maxElements = 40;
  const shown: Extract<RichText[number], { kind: 'paragraph' | 'quote' }>[] = [];
  let truncated = false;
  for (const block of body) {
    const value = block.kind === 'code_block' ? block.text : block.children.map(literal).join('');
    if (value.length === 0) continue;
    if (shown.length >= maxElements || remaining <= 0) {
      truncated = true;
      break;
    }
    const part = value.slice(0, remaining);
    shown.push({
      kind: block.kind === 'quote' ? 'quote' : 'paragraph',
      children: [{ kind: 'text', text: part }],
    });
    remaining -= part.length + 2;
    if (part.length < value.length) {
      truncated = true;
      break;
    }
  }
  const elements = shown.map((block) => ({
    type: block.kind === 'quote' ? ('rich_text_quote' as const) : ('rich_text_section' as const),
    elements: [{ type: 'text' as const, text: block.children.map(literal).join('') }],
  }));
  if (truncated && pointer !== '') {
    elements.push({ type: 'rich_text_section', elements: [{ type: 'text', text: pointer }] });
  }
  const fallback = shown
    .map((block) => {
      const value = block.children.map(literal).join('');
      return block.kind === 'quote' ? `Quote: ${value}` : value;
    })
    .join('\n\n');
  // The fallback shows only in notifications and previews; Slack decodes its entities there.
  const escaped = escapeText(fallback);
  const limit = MAX_PART_TEXT - (truncated ? suffix.length : 0);
  const text = `${escaped.length <= limit ? escaped : (splitText(escaped, limit)?.[0] ?? '')}${truncated ? suffix : ''}`;
  return { text, blocks: [{ type: 'rich_text' as const, elements }] };
}

/** Prefer a paragraph or word boundary; never cut a Slack entity or angle-bracket token. */
export function splitText<T extends string>(text: T, max = MAX_PART_TEXT): T[] | null {
  if (text.length === 0) return [];
  // Cuts fall outside entities and tokens, so each part keeps the escaping of `text`.
  const parts: T[] = [];
  let remaining: string = text;
  while (remaining.length > max) {
    const paragraph = remaining.lastIndexOf('\n\n', max);
    const space = remaining.lastIndexOf(' ', max);
    let cut = paragraph > max / 3 ? paragraph + 2 : space > max / 3 ? space + 1 : max;
    const token = /&(?:amp|lt|gt);|<[^>]*>/g;
    for (const match of remaining.matchAll(token)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start < cut && cut < end) {
        cut = start;
        break;
      }
    }
    if (cut === 0 || remaining.slice(0, cut).trimEnd().length === 0) return null;
    parts.push(remaining.slice(0, cut).trimEnd() as T);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining as T);
  return parts;
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a code point; a cut ends in `…`. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = '';
  for (const point of text) {
    if (kept.length + point.length + 1 > max) break;
    kept += point;
  }
  return `${kept}…`;
}

function plain(text: string, max: number) {
  return { type: 'plain_text' as const, text: capText(text, max) };
}

export function messageBlocks(
  text: Mrkdwn,
  marker: string,
  actions: readonly Action[] = [],
  originKey?: string,
  context: readonly Mrkdwn[] = [],
) {
  type SectionBlock = {
    type: 'section';
    block_id: string;
    text: { type: 'mrkdwn'; text: string };
  };
  type PlainText = { type: 'plain_text'; text: string };
  type ActionsBlock = {
    type: 'actions';
    elements: {
      type: 'button';
      action_id: string;
      text: PlainText;
      confirm?: {
        title: PlainText;
        text: PlainText;
        confirm: PlainText;
        deny: PlainText;
        style: 'danger';
      };
    }[];
  };
  type OriginBlock = {
    type: 'context';
    block_id: string;
    elements: [{ type: 'plain_text'; text: string }];
  };
  type ContextBlock = { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] };
  const blocks: (SectionBlock | ActionsBlock | OriginBlock | ContextBlock)[] = [
    { type: 'section', block_id: marker, text: { type: 'mrkdwn', text } },
  ];
  if (context.length > 0) {
    blocks.push({
      type: 'context',
      elements: context.map((value) => ({ type: 'mrkdwn', text: value })),
    });
  }
  if (originKey !== undefined) {
    const id = originMarkerId(originKey);
    if (id === null) throw new Error('origin marker too long');
    blocks.push({
      type: 'context',
      block_id: id,
      elements: [{ type: 'plain_text', text: '\u200b' }],
    });
  }
  if (actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actions.map((action) => ({
        type: 'button',
        action_id: action.id,
        text: plain(action.label, 75),
        ...(action.confirm === undefined
          ? {}
          : {
              confirm: {
                title: plain(action.label, 100),
                text: plain(action.confirm, 300),
                confirm: plain(action.label, 30),
                deny: plain('Cancel', 30),
                style: 'danger' as const,
              },
            }),
      })),
    });
  }
  return blocks;
}
