import { afterEach, describe, expect, it } from 'vitest';
import { userIdSchema } from '@spur-board/contracts';
import {
  MAX_PART_TEXT,
  markerFromBlocks,
  originKeyFromBlocks,
  renderText,
  splitText,
} from '../src/render.ts';
import { body, closeFakes, request, setup } from './support/deliver.ts';

afterEach(closeFakes);

describe('rendering and surface', () => {
  it('splits long mrkdwn without cutting entities or links', () => {
    const link = '<https://example.com|open>';
    const encoded = renderText(body(`${'x'.repeat(MAX_PART_TEXT - 2)}<${'y'.repeat(30)}`));
    const entityParts = splitText(encoded);
    expect(entityParts).not.toBeNull();
    expect(entityParts?.join('')).toBe(encoded);
    expect(entityParts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(
      true,
    );
    expect(entityParts?.some((part) => part.includes('&lt;'))).toBe(true);
    const linkParts = splitText(`${'x'.repeat(MAX_PART_TEXT - 8)}${link}${'z'.repeat(30)}`);
    expect(linkParts?.join('')).toBe(`${'x'.repeat(MAX_PART_TEXT - 8)}${link}${'z'.repeat(30)}`);
    expect(linkParts?.some((part) => part.includes(link))).toBe(true);
    expect(linkParts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(true);
  });

  it('splits a long unbroken input into nonempty sections', () => {
    const text = 'x'.repeat(MAX_PART_TEXT * 2 + 17);
    const parts = splitText(text);
    expect(parts?.join('')).toBe(text);
    expect(parts?.every((part) => part.length > 0 && part.length <= MAX_PART_TEXT)).toBe(true);
  });

  it.each([
    ['orchestrator', ':compass:'],
    ['curator', ':classical_building:'],
    ['worker', ':hammer:'],
    ['board', ':clipboard:'],
  ] as const)('sets persona %s username and icon', async (role, icon) => {
    const { fake, gateway } = await setup();
    await gateway.deliver({ ...request(role), persona: { name: 'Custom name', role } });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.username).toBe('Custom name');
    expect(posted?.params.icon_emoji).toBe(icon);
  });

  it('uses the persona icon over the role icon', async () => {
    const { fake, gateway } = await setup();
    await gateway.deliver({
      ...request('persona-icon'),
      persona: { name: 'Cur Bot', role: 'curator', icon: ':owl:' },
    });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    expect(posted?.params.username).toBe('Cur Bot');
    expect(posted?.params.icon_emoji).toBe(':owl:');
  });

  it('renders mrkdwn and buttons while keeping the marker out of visible text', async () => {
    const { fake, gateway } = await setup();
    await gateway.deliver({
      ...request('button-key'),
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'choose' },
            { kind: 'text', text: ' ' },
            { kind: 'link', url: 'https://example.com', text: 'open' },
          ],
        },
      ],
      actions: [{ id: 'approve', label: 'Approve' }],
    });
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const blocks: unknown = JSON.parse(posted?.params.blocks ?? 'null');
    expect(markerFromBlocks(blocks)).toBe('button-key');
    expect(posted?.params.text).toContain('*choose*');
    expect(posted?.params.text).not.toContain('button-key');
    expect(JSON.stringify(blocks)).toContain('approve');
  });

  it('renders a resolved edit as struck summary and resolved line without buttons', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver({
      ...request('resolved-key'),
      actions: [{ id: 'item.close', label: 'Close' }],
    });
    if (opened.status !== 'delivered') throw new Error('open failed');
    const edited = await gateway.deliver({
      ...request('resolved-key-edit'),
      target: { kind: 'edit', message: opened.message },
      body: [
        {
          kind: 'paragraph',
          children: [{ kind: 'link', url: 'https://example.com/7', text: 'o/r#7' }],
        },
        { kind: 'quote', children: [{ kind: 'strike', text: 'Review <PR> 7' }] },
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: '✓ Resolved by ' },
            { kind: 'mention', user: userIdSchema.parse('U1') },
            { kind: 'text', text: ' at 21:16' },
          ],
        },
      ],
    });
    expect(edited.status).toBe('delivered');
    const update = fake.requests().find((entry) => entry.method === 'chat.update');
    expect(update?.params.text).toContain('> ~Review &lt;PR&gt; 7~');
    expect(update?.params.text).toContain('✓ Resolved by <@U1> at 21:16');
    const blocks: unknown = JSON.parse(update?.params.blocks ?? 'null');
    expect(JSON.stringify(blocks)).not.toContain('"actions"');
    const messages = await fake.platform.messages();
    expect(messages.find((m) => m.message === opened.message)?.actions).toEqual([]);
  });

  it('renders a confirm dialog on a confirmed action', async () => {
    const { fake, gateway } = await setup();
    const label = `Revoke ${'d'.repeat(120)}`;
    const opened = await gateway.deliver({
      ...request('confirm-key'),
      actions: [
        { id: 'token:7:revoke', label, confirm: 'q'.repeat(400) },
        { id: 'item:7:close', label: 'Close' },
      ],
    });
    if (opened.status !== 'delivered') throw new Error('open failed');
    await gateway.deliver({
      ...request('confirm-key-edit'),
      target: { kind: 'edit', message: opened.message },
      actions: [{ id: 'token:7:revoke', label: 'Revoke', confirm: 'Revoke desk?' }],
    });
    type Button = {
      action_id: string;
      text: { text: string };
      confirm?: {
        title: { text: string };
        text: { type: string; text: string };
        confirm: { text: string };
        deny: { text: string };
        style: string;
      };
    };
    const buttons = (method: string): Button[] => {
      const call = fake.requests().find((entry) => entry.method === method);
      const blocks = JSON.parse(call?.params.blocks ?? '[]') as {
        type: string;
        elements?: Button[];
      }[];
      return blocks.find((block) => block.type === 'actions')?.elements ?? [];
    };
    const [revoke, close] = buttons('chat.postMessage');
    expect(revoke?.action_id).toBe('token:7:revoke');
    expect(revoke?.text.text.length).toBeLessThanOrEqual(75);
    expect(revoke?.confirm?.title.text.length).toBeLessThanOrEqual(100);
    expect(revoke?.confirm?.title.text.startsWith('Revoke ddd')).toBe(true);
    expect(revoke?.confirm?.text).toEqual({ type: 'plain_text', text: `${'q'.repeat(299)}…` });
    expect(revoke?.confirm?.confirm.text.length).toBeLessThanOrEqual(30);
    expect(revoke?.confirm?.confirm.text.endsWith('…')).toBe(true);
    expect(revoke?.confirm?.deny.text).toBe('Cancel');
    expect(revoke?.confirm?.style).toBe('danger');
    expect(close).not.toHaveProperty('confirm');
    expect(buttons('chat.update')).toEqual([
      {
        type: 'button',
        action_id: 'token:7:revoke',
        text: { type: 'plain_text', text: 'Revoke' },
        confirm: {
          title: { type: 'plain_text', text: 'Revoke' },
          text: { type: 'plain_text', text: 'Revoke desk?' },
          confirm: { type: 'plain_text', text: 'Revoke' },
          deny: { type: 'plain_text', text: 'Cancel' },
          style: 'danger',
        },
      },
    ]);
  });

  it('shows the actions of an edit that carries them', async () => {
    const { fake, gateway } = await setup();
    const opened = await gateway.deliver(request('card-key'));
    if (opened.status !== 'delivered') throw new Error('open failed');
    const edited = await gateway.deliver({
      ...request('card-key-edit'),
      target: { kind: 'edit', message: opened.message },
      actions: [{ id: 'token:7:revoke', label: 'Revoke' }],
    });
    expect(edited.status).toBe('delivered');
    const update = fake.requests().find((entry) => entry.method === 'chat.update');
    expect(JSON.stringify(JSON.parse(update?.params.blocks ?? 'null'))).toContain('"actions"');
    const messages = await fake.platform.messages();
    expect(messages.find((m) => m.message === opened.message)?.actions).toEqual(['token:7:revoke']);
  });

  it('strikes each line apart, trims it and replaces a tilde inside', () => {
    expect(
      renderText([{ kind: 'quote', children: [{ kind: 'strike', text: ' a~b \n\n  c ' }] }]),
    ).toBe('> ~a∼b~\n> \n> ~c~');
  });

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

  it('fails a marker longer than Block Kit allows without an HTTP request', async () => {
    const { fake, gateway } = await setup();
    expect(await gateway.deliver(request('x'.repeat(260)))).toEqual({
      status: 'failed',
      permanent: true,
      scope: 'message',
      reason: 'marker_too_long',
    });
    expect(fake.requests()).toHaveLength(0);
  });

  it('fails an overlong multipart root origin marker before an HTTP request', async () => {
    const { fake, gateway } = await setup();
    expect(
      await gateway.deliver(request('x'.repeat(244), 'x'.repeat(MAX_PART_TEXT + 100))),
    ).toEqual({
      status: 'failed',
      permanent: true,
      scope: 'message',
      reason: 'marker_too_long',
    });
    expect(fake.requests()).toHaveLength(0);
  });

  it('accepts the adjacent valid multipart root origin marker length', async () => {
    const { fake, gateway } = await setup();
    const key = 'x'.repeat(243);
    expect((await gateway.deliver(request(key, 'x'.repeat(MAX_PART_TEXT + 100)))).status).toBe(
      'delivered',
    );
    const posted = fake.requests().find((entry) => entry.method === 'chat.postMessage');
    const blocks: unknown = JSON.parse(posted?.params.blocks ?? 'null');
    expect(originKeyFromBlocks(blocks)).toBe(key);
  });

  it('exports only createSlackGateway from the package root', async () => {
    expect(Object.keys(await import('../src/index.ts'))).toEqual(['createSlackGateway']);
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
