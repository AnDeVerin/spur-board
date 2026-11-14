import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PART_TEXT, renderText } from '../src/render.ts';
import { body, closeFakes, request, setup } from './deliver-setup.ts';

afterEach(closeFakes);

describe('context elements and italic', () => {
  it('renders a question and answer line as a section and a context element', async () => {
    const { fake, gateway } = await setup();
    const delivered = await gateway.deliver({
      ...request('curator-answer'),
      persona: { name: 'Cur Bot', role: 'curator', icon: ':owl:' },
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'link', url: 'https://example.com/T1', text: 'T1' },
            { kind: 'text', text: ' Fix login' },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Question:' },
            { kind: 'text', text: ' Q?' },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Answer:' },
            { kind: 'text', text: ' A.' },
          ],
        },
        { kind: 'paragraph', children: [{ kind: 'italic', text: 'Checked.' }] },
        {
          kind: 'context',
          children: [{ kind: 'text', text: 'B1 · asked by p/s1 · answered by cur/s2 · unblocked' }],
        },
      ],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const text =
      '<https://example.com/T1|T1> Fix login\n\n*Question:* Q?\n\n*Answer:* A.\n\n_Checked._';
    expect(posted?.params.text).toBe(text);
    expect(posted?.params.text).not.toContain('asked by');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      { type: 'section', block_id: 'spur:curator-answer', text: { type: 'mrkdwn', text } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'B1 · asked by p/s1 · answered by cur/s2 · unblocked' }],
      },
    ]);
  });

  it('renders a context element on an edit', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver(request('edit-context'));
    if (opened.status !== 'delivered') throw new Error('open failed');
    const edited = await gateway.deliver({
      ...request('edit-context-edit', 'Answered'),
      target: { kind: 'edit', message: opened.message },
      body: [
        ...body('Answered'),
        { kind: 'context', children: [{ kind: 'text', text: 'B1 · unblocked' }] },
      ],
    });
    expect(edited.status).toBe('delivered');
    const update = fake.requests().find((entry) => entry.method === 'chat.update');
    expect(update?.params.text).toBe('Answered');
    expect(JSON.parse(update?.params.blocks ?? 'null')).toEqual([
      {
        type: 'section',
        block_id: 'spur:edit-context-edit',
        text: { type: 'mrkdwn', text: 'Answered' },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'B1 · unblocked' }] },
    ]);
  });

  it('puts the context element on the first part of a multipart post only', async () => {
    const { fake, gateway } = await setup();
    const long = 'x'.repeat(MAX_PART_TEXT + 100);
    const delivered = await gateway.deliver({
      ...request('multi-context'),
      body: [...body(long), { kind: 'context', children: [{ kind: 'text', text: 'B1' }] }],
    });
    expect(delivered.status).toBe('delivered');
    const posts = fake.requests().filter((entry) => entry.method === 'chat.postMessage');
    expect(posts.map((entry): unknown => JSON.parse(entry.params.blocks ?? 'null'))).toEqual([
      [
        {
          type: 'section',
          block_id: 'spur:multi-context%231',
          text: { type: 'mrkdwn', text: long.slice(0, MAX_PART_TEXT) },
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'B1' }] },
        {
          type: 'context',
          block_id: 'spur-origin:multi-context',
          elements: [{ type: 'plain_text', text: '​' }],
        },
      ],
      [
        {
          type: 'section',
          block_id: 'spur:multi-context%232',
          text: { type: 'mrkdwn', text: long.slice(MAX_PART_TEXT) },
        },
      ],
    ]);
  });

  it('renders a body of only context blocks as section text', async () => {
    const { fake, gateway } = await setup();
    const delivered = await gateway.deliver({
      ...request('context-only'),
      body: [{ kind: 'context', children: [{ kind: 'text', text: 'B1 · unblocked' }] }],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.text).toBe('B1 · unblocked');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      {
        type: 'section',
        block_id: 'spur:context-only',
        text: { type: 'mrkdwn', text: 'B1 · unblocked' },
      },
    ]);
  });

  it('renders italic per line inside underscores', () => {
    expect(
      renderText([{ kind: 'paragraph', children: [{ kind: 'italic', text: ' a<b \n\n  c ' }] }]),
    ).toBe('_a&lt;b_\n\n_c_');
  });

  it('keeps underscores inside italic text from closing the span', () => {
    expect(
      renderText([
        { kind: 'paragraph', children: [{ kind: 'italic', text: 'checked _again_ today' }] },
      ]),
    ).toBe('_checked ˍagainˍ today_');
  });

  it('puts many context blocks into one context block of at most ten elements', async () => {
    const { fake, gateway } = await setup();
    const values = Array.from({ length: 50 }, (_, index) => `c${String(index + 1)}`);
    const delivered = await gateway.deliver({
      ...request('many-context'),
      body: [
        ...body('Line'),
        ...values.map((text) => ({
          kind: 'context' as const,
          children: [{ kind: 'text' as const, text }],
        })),
      ],
    });
    expect(delivered.status).toBe('delivered');
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(JSON.parse(posted?.params.blocks ?? 'null')).toEqual([
      { type: 'section', block_id: 'spur:many-context', text: { type: 'mrkdwn', text: 'Line' } },
      {
        type: 'context',
        elements: [
          ...values.slice(0, 9).map((text) => ({ type: 'mrkdwn', text })),
          { type: 'mrkdwn', text: values.slice(9).join('\n') },
        ],
      },
    ]);
  });

  it('keeps a context longer than one element as section text', async () => {
    const { fake, gateway } = await setup();
    const long = Array.from({ length: 1100 }, (_, index) => `w${String(index % 10)}`).join(' ');
    expect(long.length).toBeGreaterThan(MAX_PART_TEXT);
    const delivered = await gateway.deliver({
      ...request('long-context'),
      body: [...body('Line'), { kind: 'context', children: [{ kind: 'text', text: long }] }],
    });
    expect(delivered.status).toBe('delivered');
    const blocks = postedBlocks(fake.requests());
    expect(blocks.some((block) => block.type === 'context' && !block.block_id)).toBe(false);
    const sections = blocks.filter((block) => block.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    const joined = sections.map((block) => block.text?.text ?? '').join(' ');
    expect(joined.replace(/\s+/g, ' ')).toBe(`Line ${long}`);
  });

  it('keeps many contexts as section text when the joined tenth element overflows', async () => {
    const { fake, gateway } = await setup();
    const values = Array.from({ length: 40 }, (_, index) => String(index).padEnd(100, 'c'));
    const delivered = await gateway.deliver({
      ...request('overflow-context'),
      body: [
        ...body('Line'),
        ...values.map((text) => ({
          kind: 'context' as const,
          children: [{ kind: 'text' as const, text }],
        })),
      ],
    });
    expect(delivered.status).toBe('delivered');
    const blocks = postedBlocks(fake.requests());
    expect(blocks.some((block) => block.type === 'context' && !block.block_id)).toBe(false);
    const all = blocks
      .filter((block) => block.type === 'section')
      .map((block) => block.text?.text ?? '')
      .join('\n\n');
    expect(all).toBe(['Line', ...values].join('\n\n'));
  });
});

type PostedBlock = { type: string; block_id?: string; text?: { text: string } };

/** Every block of every posted part, in order. */
function postedBlocks(
  requests: readonly { method: string; params: { blocks?: string } }[],
): PostedBlock[] {
  return requests
    .filter((entry) => entry.method === 'chat.postMessage')
    .flatMap((entry) => JSON.parse(entry.params.blocks ?? '[]') as PostedBlock[]);
}
