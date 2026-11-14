import type { RichText, RichTextInline } from '@spur-board/contracts';

function inline(value: RichTextInline): string {
  if (value.kind === 'mention') return `<@${value.user}>`;
  if (value.kind !== 'text') throw new Error(`${value.kind} is not measured`);
  return value.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * The length of `body` as the Slack gateway writes plain text and mention paragraphs and quotes:
 * `&`, `<` and `>` become entities, a quote line gets `> `, blocks join with a blank line.
 */
export function renderedLength(body: RichText): number {
  return body
    .map((block) => {
      if (block.kind === 'code_block') throw new Error('code_block is not measured');
      const value = block.children.map(inline).join('');
      return block.kind === 'quote'
        ? value
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : value;
    })
    .join('\n\n').length;
}
