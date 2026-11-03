import type { Action, Persona, RichText, RichTextInline } from '@spur-board/contracts';

/** Slack section mrkdwn is capped at 3000 characters; leave room for formatting. */
export const MAX_PART_TEXT = 2900;
const MARKER_PREFIX = 'spur:';

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

/** Prefer a paragraph or word boundary, then cut a single oversize run if necessary. */
export function splitText(text: string, max = MAX_PART_TEXT): string[] {
  if (text.length === 0) return [];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const paragraph = remaining.lastIndexOf('\n\n', max);
    const space = remaining.lastIndexOf(' ', max);
    const cut = paragraph > max / 3 ? paragraph + 2 : space > max / 3 ? space + 1 : max;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export function messageBlocks(text: string, marker: string, actions: readonly Action[] = []) {
  type SectionBlock = {
    type: 'section';
    block_id: string;
    text: { type: 'mrkdwn'; text: string };
  };
  type ActionsBlock = {
    type: 'actions';
    elements: { type: 'button'; action_id: string; text: { type: 'plain_text'; text: string } }[];
  };
  const blocks: (SectionBlock | ActionsBlock)[] = [
    { type: 'section', block_id: marker, text: { type: 'mrkdwn', text } },
  ];
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
