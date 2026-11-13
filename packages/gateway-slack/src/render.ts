import type { Action, Persona, RichText, RichTextInline } from '@spur-board/contracts';

/** Slack section mrkdwn is capped at 3000 characters; leave room for formatting. */
export const MAX_PART_TEXT = 2900;
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

export function markerFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const values: readonly unknown[] = blocks;
  for (const block of values) {
    if (typeof block !== 'object' || block === null || !('block_id' in block)) continue;
    const id = block.block_id;
    if (typeof id !== 'string' || !id.startsWith(MARKER_PREFIX)) continue;
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
  if (!Array.isArray(blocks)) return undefined;
  const values: readonly unknown[] = blocks;
  for (const block of values) {
    if (typeof block !== 'object' || block === null || !('block_id' in block)) continue;
    const id = block.block_id;
    if (typeof id !== 'string' || !id.startsWith(ORIGIN_PREFIX)) continue;
    try {
      return decodeURIComponent(id.slice(ORIGIN_PREFIX.length));
    } catch {
      return undefined;
    }
  }
  return markerFromBlocks(blocks);
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Slack applies `~` and `_` only within one line and not across edge spaces. */
function perLine(text: string, mark: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = line.trim();
      return value.length === 0 ? '' : `${mark}${escapeText(value)}${mark}`;
    })
    .join('\n');
}

function inline(value: RichTextInline): string {
  switch (value.kind) {
    case 'text':
      return escapeText(value.text);
    case 'emphasis':
      return `*${escapeText(value.text)}*`;
    case 'code':
      return `\`${value.text.replaceAll('`', '´')}\``;
    case 'strike':
      return perLine(value.text.replaceAll('~', '∼'), '~');
    case 'italic':
      return perLine(value.text, '_');
    case 'link':
      return `<${value.url.replace(/[<>|]/g, '')}|${escapeText(value.text).replaceAll('|', '¦')}>`;
    case 'mention':
      return `<@${value.user}>`;
  }
}

/**
 * Trailing context blocks become context elements after the section, each cut to fit one.
 * Without other visible content they stay paragraphs, so the section keeps text.
 */
export function splitContext(body: RichText): { body: RichText; context: string[] } {
  let end = body.length;
  while (end > 0 && body[end - 1]?.kind === 'context') end--;
  if (renderText(body.slice(0, end)).length === 0) return { body, context: [] };
  const context = body
    .slice(end)
    .map((block) => (block.kind === 'context' ? block.children.map(inline).join('') : ''))
    .filter((text) => text.length > 0)
    .map((text) => splitText(text)?.[0] ?? text.slice(0, MAX_PART_TEXT));
  return { body: body.slice(0, end), context };
}

export function renderText(body: RichText): string {
  return body
    .map((block) => {
      if (block.kind === 'code_block') {
        return `\`\`\`\n${block.text.replaceAll('```', "'''")}\n\`\`\``;
      }
      const value = block.children.map(inline).join('');
      return block.kind === 'quote'
        ? value
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : value;
    })
    .filter((value) => value.length > 0)
    .join('\n\n');
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
  const limit = MAX_PART_TEXT - (truncated ? suffix.length : 0);
  const text = `${fallback.length <= limit ? fallback : (splitText(fallback, limit)?.[0] ?? '')}${truncated ? suffix : ''}`;
  return { text, blocks: [{ type: 'rich_text' as const, elements }] };
}

/** Prefer a paragraph or word boundary; never cut a Slack entity or angle-bracket token. */
export function splitText(text: string, max = MAX_PART_TEXT): string[] | null {
  if (text.length === 0) return [];
  const parts: string[] = [];
  let remaining = text;
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
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export function messageBlocks(
  text: string,
  marker: string,
  actions: readonly Action[] = [],
  originKey?: string,
  context: readonly string[] = [],
) {
  type SectionBlock = {
    type: 'section';
    block_id: string;
    text: { type: 'mrkdwn'; text: string };
  };
  type ActionsBlock = {
    type: 'actions';
    elements: { type: 'button'; action_id: string; text: { type: 'plain_text'; text: string } }[];
  };
  type OriginBlock = {
    type: 'context';
    block_id: string;
    elements: [{ type: 'plain_text'; text: string }];
  };
  type ContextBlock = { type: 'context'; elements: [{ type: 'mrkdwn'; text: string }] };
  const blocks: (SectionBlock | ActionsBlock | OriginBlock | ContextBlock)[] = [
    { type: 'section', block_id: marker, text: { type: 'mrkdwn', text } },
    ...context.map((value): ContextBlock => ({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: value }],
    })),
  ];
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
        text: { type: 'plain_text', text: action.label },
      })),
    });
  }
  return blocks;
}
