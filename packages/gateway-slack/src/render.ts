import type { Action, Persona, RichText, RichTextInline } from '@spur-board/contracts';

/** Slack section mrkdwn is capped at 3000 characters; leave room for formatting. */
export const MAX_PART_TEXT = 2900;
const MARKER_PREFIX = 'spur:';
const ORIGIN_PREFIX = 'spur-origin:';

const roleIcons: Record<Persona['role'], string> = {
  orchestrator: ':compass:',
  worker: ':hammer:',
  board: ':clipboard:',
};

export function iconFor(persona: Persona): string {
  return roleIcons[persona.role];
}

export function markerId(key: string): string | null {
  try {
    const id = `${MARKER_PREFIX}${encodeURIComponent(key)}`;
    return id.length <= 255 ? id : null;
  } catch {
    return null;
  }
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

function inline(value: RichTextInline): string {
  switch (value.kind) {
    case 'text':
      return escapeText(value.text);
    case 'emphasis':
      return `*${escapeText(value.text)}*`;
    case 'code':
      return `\`${value.text.replaceAll('`', '´')}\``;
    case 'link':
      return `<${value.url.replace(/[<>|]/g, '')}|${escapeText(value.text).replaceAll('|', '¦')}>`;
    case 'mention':
      return `<@${value.user}>`;
  }
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
  const blocks: (SectionBlock | ActionsBlock | OriginBlock)[] = [
    { type: 'section', block_id: marker, text: { type: 'mrkdwn', text } },
  ];
  if (originKey !== undefined) {
    const id = `${ORIGIN_PREFIX}${encodeURIComponent(originKey)}`;
    if (id.length > 255) throw new Error('origin marker too long');
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
