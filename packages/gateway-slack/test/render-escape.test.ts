import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  interactionRefSchema,
  userIdSchema,
  type DeliverRequest,
  type RichText,
  type RichTextBlock,
  type RichTextInline,
} from '@spur-board/contracts';
import type { FakeSlackApi } from '@spur-board/gateway-slack/testing';
import { messageBlocks, renderText, splitContext, type Mrkdwn } from '../src/render.ts';
import { body, closeFakes, request, setup } from './support/deliver.ts';

afterEach(closeFakes);

/** Each title, how mrkdwn shows it, and its `&<>` entities alone (code block, code after its backtick swap, respond fallback). */
const titles = [
  ['a < b', 'a &lt; b', 'a &lt; b'],
  ['a > b', 'a &gt; b', 'a &gt; b'],
  ['a & b', 'a &amp; b', 'a &amp; b'],
  ['<!channel>', '&lt;!channel&gt;', '&lt;!channel&gt;'],
  ['<@U123>', '&lt;@U123&gt;', '&lt;@U123&gt;'],
  ['*bold*', '∗bold∗', '*bold*'],
  ['a `b` c', 'a ´b´ c', 'a `b` c'],
  [
    '<script>reason</script> <!here> *bold*',
    '&lt;script&gt;reason&lt;/script&gt; &lt;!here&gt; ∗bold∗',
    '&lt;script&gt;reason&lt;/script&gt; &lt;!here&gt; *bold*',
  ],
] as const;

const operator = userIdSchema.parse('U1');
const taskUrl = 'https://example.test/T1';
/** The board's own control sequences: the task link and the operator mention. */
const boardTokens = /<https:\/\/example\.test\/T1\|[^<>|]*>|<@U1>/g;

/** Top-level text, section text and context elements of every post and update. */
function mrkdwnOf(fake: FakeSlackApi): string[] {
  return fake
    .requests()
    .filter((entry) => entry.method === 'chat.postMessage' || entry.method === 'chat.update')
    .flatMap((entry) => {
      const blocks = JSON.parse(entry.params.blocks ?? '[]') as {
        type: string;
        text?: { type: string; text: string };
        elements?: { type: string; text?: string }[];
      }[];
      return [
        entry.params.text ?? '',
        ...blocks.flatMap((block) => [
          ...(block.text?.type === 'mrkdwn' ? [block.text.text] : []),
          ...(block.elements ?? []).flatMap((element) =>
            element.type === 'mrkdwn' && element.text !== undefined ? [element.text] : [],
          ),
        ]),
      ];
    });
}

function expectNoRawMarkup(values: readonly string[]): void {
  for (const value of values) {
    expect(value.replace(boardTokens, '').replace(/^> /gm, ''), value).not.toMatch(/[<>]/);
  }
}

/** The buttons of the first call of `method` that carries any. */
function buttonsOf(fake: FakeSlackApi, method: string): unknown {
  return fake
    .requests()
    .filter((entry) => entry.method === method)
    .flatMap(
      (entry) => JSON.parse(entry.params.blocks ?? '[]') as { type: string; elements?: unknown }[],
    )
    .find((block) => block.type === 'actions')?.elements;
}

type KindCase = (title: string, shown: string, entities: string) => [RichText, string];
const paragraph = (child: RichTextInline): RichText => [{ kind: 'paragraph', children: [child] }];

/** One row per RichText kind; a new kind fails `tsc` until it has a row. */
const kindCases = {
  text: (title, shown) => [paragraph({ kind: 'text', text: title }), shown],
  emphasis: (title, shown) => [paragraph({ kind: 'emphasis', text: title }), `*${shown}*`],
  code: (title, _shown, entities) => [
    paragraph({ kind: 'code', text: title }),
    `\`${entities.replaceAll('`', '´')}\``,
  ],
  strike: (title, shown) => [paragraph({ kind: 'strike', text: title }), `~${shown}~`],
  italic: (title, shown) => [paragraph({ kind: 'italic', text: title }), `_${shown}_`],
  link: (title, shown) => [
    paragraph({ kind: 'link', url: taskUrl, text: title }),
    `<${taskUrl}|${shown}>`,
  ],
  mention: (title, shown) => [
    paragraph({ kind: 'mention', user: userIdSchema.parse(title) }),
    `@${shown}`,
  ],
  paragraph: (title, shown) => [paragraph({ kind: 'text', text: title }), shown],
  quote: (title, shown) => [
    [{ kind: 'quote', children: [{ kind: 'text', text: title }] }],
    `> ${shown}`,
  ],
  context: (title, shown) => [
    [...body('Line'), { kind: 'context', children: [{ kind: 'text', text: title }] }],
    shown,
  ],
  code_block: (title, _shown, entities) => [
    [{ kind: 'code_block', text: title }],
    `\`\`\`\n${entities}\n\`\`\``,
  ],
} satisfies Record<RichTextInline['kind'] | RichTextBlock['kind'], KindCase>;

const kindRows = Object.entries(kindCases).flatMap(([kind, make]) =>
  titles.map(([title, shown, entities]) => [kind, title, ...make(title, shown, entities)] as const),
);

describe('outside text stays literal', () => {
  it.each(kindRows)('renders %s holding %j literally', async (_kind, _title, rich, expected) => {
    const { fake, gateway } = await setup();
    expect((await gateway.deliver({ ...request('kind'), body: rich })).status).toBe('delivered');
    const values = mrkdwnOf(fake);
    expect(values.some((value) => value.includes(expected))).toBe(true);
    expectNoRawMarkup(values);
  });

  it.each(titles)('renders %j literally in every line kind', async (title, shown, entities) => {
    const { fake, gateway } = await setup();
    const persona = { name: 'Board', role: 'board' } as const;
    const deliver = async (req: Omit<DeliverRequest, 'maybeSent' | 'persona'>) => {
      const result = await gateway.deliver({ ...req, maybeSent: false, persona });
      if (result.status !== 'delivered') throw new Error(`${req.key} failed`);
      return result;
    };
    const renderBody = (key: string, text: string): RichText => [
      { kind: 'paragraph', children: [{ kind: 'text', text: key }] },
      { kind: 'quote', children: [{ kind: 'text', text }] },
    ];
    const open = { kind: 'open', space: 'feed', title: 'Line' } as const;
    const lines: { name: string; expected: string[]; context?: string }[] = [];

    const feed = await deliver({ key: 'feed', target: open, body: renderBody('T1', title) });
    const conversation = feed.conversation;
    if (conversation === undefined) throw new Error('open returned no conversation');
    lines.push({ name: 'feed line', expected: [`T1\n\n> ${shown}`] });

    const actions = [
      { id: 'item:7:retry', label: 'Retry' },
      { id: 'item:7:close', label: 'Close' },
    ];
    const linked = await deliver({
      key: 'link',
      target: open,
      body: [
        { kind: 'paragraph', children: [{ kind: 'link', url: taskUrl, text: 'T1' }] },
        { kind: 'quote', children: [{ kind: 'text', text: title }] },
      ],
      actions,
    });
    lines.push({ name: 'link feed line', expected: [`<${taskUrl}|T1>\n\n> ${shown}`] });
    expect(buttonsOf(fake, 'chat.postMessage')).toMatchObject([
      { text: { type: 'plain_text', text: 'Retry' } },
      { text: { type: 'plain_text', text: 'Close' } },
    ]);

    await deliver({
      key: 'resolved',
      target: { kind: 'edit', message: linked.message },
      body: [
        { kind: 'paragraph', children: [{ kind: 'link', url: taskUrl, text: 'T1' }] },
        { kind: 'quote', children: [{ kind: 'strike', text: title }] },
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: '✓ Resolved by ' },
            { kind: 'mention', user: operator },
            { kind: 'text', text: ' at 21:16' },
          ],
        },
      ],
    });
    lines.push({
      name: 'resolved edit',
      expected: [`> ~${shown}~`, '✓ Resolved by <@U1> at 21:16'],
    });

    const confirm = `Revoke ${title}?`;
    await deliver({
      key: 'token-card',
      target: { kind: 'edit', message: feed.message },
      body: [
        { kind: 'paragraph', children: [{ kind: 'text', text: `Operator token ${title}` }] },
        { kind: 'paragraph', children: [{ kind: 'text', text: `Folder: ${title}` }] },
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: 'Revoked by ' },
            { kind: 'mention', user: operator },
            { kind: 'text', text: ' at 21:16' },
          ],
        },
      ],
      actions: [{ id: 'token:7:revoke', label: 'Revoke', confirm }],
    });
    lines.push({
      name: 'token card edit',
      expected: [`Operator token ${shown}\n\nFolder: ${shown}`, 'Revoked by <@U1> at 21:16'],
    });

    await deliver({
      key: 'exchange',
      target: open,
      body: [
        {
          kind: 'paragraph',
          children: [
            { kind: 'link', url: taskUrl, text: 'T1' },
            { kind: 'text', text: ` ${title}` },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Question:' },
            { kind: 'text', text: ` ${title}` },
          ],
        },
        {
          kind: 'paragraph',
          children: [
            { kind: 'emphasis', text: 'Answer:' },
            { kind: 'text', text: ` ${title}` },
          ],
        },
        { kind: 'paragraph', children: [{ kind: 'italic', text: title }] },
        {
          kind: 'context',
          children: [
            { kind: 'text', text: `B1 · asked by ${title} · answered by cur/s2 · unblocked` },
          ],
        },
      ],
    });
    lines.push({
      name: 'exchange line',
      expected: [
        `<${taskUrl}|T1> ${shown}\n\n*Question:* ${shown}\n\n*Answer:* ${shown}\n\n_${shown}_`,
      ],
      context: `B1 · asked by ${shown} · answered by cur/s2 · unblocked`,
    });

    await deliver({
      key: 'reply',
      target: { kind: 'reply', conversation },
      body: renderBody('T1', `reply ${title}`),
    });
    lines.push({ name: 'thread reply', expected: [`T1\n\n> reply ${shown}`] });

    await deliver({
      key: 'close',
      target: { kind: 'close', conversation },
      body: renderBody('T1', `closed ${title}`),
    });
    lines.push({ name: 'closing line', expected: [`T1\n\n> closed ${shown}`] });

    const calls = fake
      .requests()
      .filter((entry) => entry.method === 'chat.postMessage' || entry.method === 'chat.update');
    expect(calls).toHaveLength(lines.length);
    for (const [index, line] of lines.entries()) {
      const call = calls[index];
      const blocks = JSON.parse(call?.params.blocks ?? '[]') as {
        type: string;
        text?: { text: string };
        elements?: { type: string; text?: string }[];
      }[];
      const section = blocks.find((block) => block.type === 'section')?.text?.text;
      const context = blocks
        .filter((block) => block.type === 'context')
        .flatMap((block) => block.elements ?? [])
        .filter((element) => element.type === 'mrkdwn')
        .map((element) => element.text);
      expect(section, line.name).toBe(call?.params.text);
      for (const fragment of line.expected) expect(section, line.name).toContain(fragment);
      expect(context, line.name).toEqual(line.context === undefined ? [] : [line.context]);
    }
    expectNoRawMarkup(mrkdwnOf(fake));
    expect(buttonsOf(fake, 'chat.update')).toMatchObject([
      { text: { text: 'Revoke' }, confirm: { text: { type: 'plain_text', text: confirm } } },
    ]);

    const interaction = interactionRefSchema.parse(
      JSON.stringify({ channel: 'C_ORCH', user: 'U_OPERATOR', triggerId: 'T1' }),
    );
    expect(
      await gateway.respond(
        interaction,
        [
          { kind: 'paragraph', children: [{ kind: 'text', text: `Open block B1 (external):` }] },
          { kind: 'quote', children: [{ kind: 'text', text: title }] },
        ],
        { private: true, cliHint: 'board task T1' },
      ),
    ).toBe('sent');
    const reply = fake.requests().find((entry) => entry.method === 'chat.postEphemeral');
    expect(reply?.params.text).toBe(`Open block B1 (external):\n\nQuote: ${entities}`);
    expect(reply?.params.blocks).toContain(JSON.stringify({ type: 'text', text: title }));
  });

  it('types mrkdwn so a raw string cannot reach a mrkdwn field', () => {
    expectTypeOf<string>().not.toExtend<Mrkdwn>();
    expectTypeOf(messageBlocks).parameter(0).toEqualTypeOf<Mrkdwn>();
    expectTypeOf(messageBlocks).parameter(4).toEqualTypeOf<readonly Mrkdwn[] | undefined>();
    expectTypeOf(splitContext).returns.toEqualTypeOf<{ body: RichText; context: Mrkdwn[] }>();
  });

  it.each([
    ['my_snake_case', paragraph({ kind: 'text', text: 'my_snake_case' }), 'my_snake_case'],
    ['2*3*4', paragraph({ kind: 'text', text: '2*3*4' }), '2*3*4'],
    ['_web_/worker', paragraph({ kind: 'text', text: '_web_/worker' }), 'ˍwebˍ/worker'],
    [
      'a link URL with & and <>',
      paragraph({ kind: 'link', url: 'https://example.test/T1?a=1&b=<x>', text: 'T1' }),
      '<https://example.test/T1?a=1&amp;b=x|T1>',
    ],
    [
      'a mention id with >',
      paragraph({ kind: 'mention', user: userIdSchema.parse('U1>') }),
      '@U1&gt;',
    ],
    [
      'marks in a bare URL',
      paragraph({ kind: 'text', text: 'https://example.test/~u/_x' }),
      'https://example.test/~u/_x',
    ],
    [
      'a URL then a bold run',
      paragraph({ kind: 'text', text: 'see https://example.test/a?b=1&c=2 *now*' }),
      'see https://example.test/a?b=1&amp;c=2 ∗now∗',
    ],
    [
      'a mark at a node edge',
      [
        {
          kind: 'paragraph',
          children: [
            { kind: 'text', text: 'a*' },
            { kind: 'text', text: 'b' },
          ],
        },
      ],
      'a∗b',
    ],
    ['a dunder name', paragraph({ kind: 'text', text: '__init__' }), 'ˍˍinitˍˍ'],
    ['a path', paragraph({ kind: 'text', text: '/srv/_config.yml' }), '/srv/ˍconfig.yml'],
    ['marks in italic', paragraph({ kind: 'italic', text: '_*x*_' }), '_ˍ∗x∗ˍ_'],
    ['stars in emphasis', paragraph({ kind: 'emphasis', text: 'a*b' }), '*a∗b*'],
    ['backticks inside a word', paragraph({ kind: 'text', text: 'x`y`z' }), 'x´y´z'],
    [
      'outside backticks and a code hint on one line',
      [
        {
          kind: 'quote',
          children: [
            { kind: 'text', text: 'x `y` ' },
            { kind: 'code', text: 'board token list' },
          ],
        },
      ],
      '> x ´y´ `board token list`',
    ],
    [
      'a backtick in a bare URL',
      paragraph({ kind: 'text', text: 'https://e.test/`a`' }),
      'https://e.test/´a´',
    ],
  ] satisfies [string, RichText, string][])('renders %s', (_name, rich, expected) => {
    expect(renderText(rich)).toBe(expected);
  });
});
