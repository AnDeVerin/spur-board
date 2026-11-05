import { interactionRefSchema, type InboundEvent } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { commandUsage, parseCommand } from '../src/commands.ts';
import { createSlackGateway } from '../src/index.ts';
import { MAX_PART_TEXT, renderText } from '../src/render.ts';
import { startFakeSlackApi, type FakeSlackApi } from './fake-api.ts';

const fakes: FakeSlackApi[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

describe('Slack board commands', () => {
  it('passes another command name through unparsed and parses the configured name', async () => {
    const fake = await startFakeSlackApi();
    fakes.push(fake);
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      appToken: 'xapp-test',
      command: '/ops',
      channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
      apiUrl: fake.url,
    });
    const events: InboundEvent[] = [];
    await gateway.start((event) => {
      events.push(event);
      return Promise.resolve();
    });
    try {
      const body = {
        user_id: 'U_OPERATOR',
        channel_id: 'C_ORCH',
        text: 'status',
      };
      await fake.emitEnvelope('slash_commands', {
        ...body,
        trigger_id: 'T-WRONG',
        command: '/other',
      });
      await fake.emitEnvelope('slash_commands', {
        ...body,
        trigger_id: 'T-RIGHT',
        command: '/ops',
      });
      const commands = events.filter((event) => event.kind === 'command');
      expect(commands).toMatchObject([
        { kind: 'command', name: '/other', dedupeKey: 'slack:T-WRONG' },
        {
          kind: 'command',
          name: '/ops',
          dedupeKey: 'slack:T-RIGHT',
          command: { kind: 'query', id: 'status.get', input: {} },
        },
      ]);
      expect(commands[0]).not.toHaveProperty('command');
    } finally {
      await gateway.stop();
    }
  });

  it('maps the three catalog forms and the empty status alias', () => {
    expect(parseCommand('', '/board')).toEqual({ kind: 'query', id: 'status.get', input: {} });
    expect(parseCommand('status', '/board')).toEqual({
      kind: 'query',
      id: 'status.get',
      input: {},
    });
    expect(parseCommand('task PROJ-123', '/board')).toEqual({
      kind: 'query',
      id: 'task.get',
      input: { task: 'PROJ-123' },
    });
    expect(parseCommand('task PROJ-123 history', '/board')).toEqual({
      kind: 'query',
      id: 'task.history',
      input: { task: 'PROJ-123' },
    });
  });

  it('derives usage and parsing from the same bindings for a configured name', () => {
    const usage = commandUsage('/ops');
    expect(usage).toBe('Usage:\n/ops status\n/ops task <KEY>\n/ops task <KEY> history');
    for (const input of [
      'unknown',
      'task',
      'task bad-key',
      'task PROJ-123 extra',
      'link PROJ-123 --pr https://example.test/pull/7',
      'unlink PROJ-123 --session web-7',
    ]) {
      expect(parseCommand(input, '/ops')).toEqual({ kind: 'usage', text: usage });
    }
    expect(parseCommand('task PROJ-123', '/ops')).toEqual({
      kind: 'query',
      id: 'task.get',
      input: { task: 'PROJ-123' },
    });
  });

  it('renders quoted agent text without expanding a Slack mention', () => {
    expect(
      renderText([{ kind: 'quote', children: [{ kind: 'text', text: '<!channel> *bold*' }] }]),
    ).toBe('> &lt;!channel&gt; *bold*');
  });

  it('posts quoted data as literal rich text', async () => {
    const fake = await startFakeSlackApi();
    fakes.push(fake);
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
      apiUrl: fake.url,
    });
    const interaction = interactionRefSchema.parse(
      JSON.stringify({ channel: 'C_ORCH', user: 'U_OPERATOR', triggerId: 'T2' }),
    );
    const quote = '<!channel> *bold* _italics_ https://example.test';
    expect(
      await gateway.respond(
        interaction,
        [
          {
            kind: 'paragraph',
            children: [{ kind: 'text', text: 'Block B12 (open, needs_input):' }],
          },
          { kind: 'quote', children: [{ kind: 'text', text: quote }] },
        ],
        { private: true },
      ),
    ).toBe('sent');
    const posted = fake.requests().find((request) => request.method === 'chat.postEphemeral');
    expect(posted?.params.text).toBe(`Block B12 (open, needs_input):\n\nQuote: ${quote}`);
    expect(posted?.params.mrkdwn).toBe('false');
    expect(posted?.params.parse).toBe('none');
    expect(posted?.params.link_names).toBe('false');
    expect(JSON.parse(posted?.params.blocks ?? '[]')).toEqual([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'Block B12 (open, needs_input):' }],
          },
          { type: 'rich_text_quote', elements: [{ type: 'text', text: quote }] },
        ],
      },
    ]);
  });

  it('bounds a history reply without tearing an escaped entity or its CLI pointer', async () => {
    const fake = await startFakeSlackApi();
    fakes.push(fake);
    const gateway = createSlackGateway({
      token: 'xoxb-test',
      channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
      apiUrl: fake.url,
      requestTimeoutMs: 500,
    });
    const pointer = '\n\nMore: board task history PROJ-123 (CLI)';
    const content = `${'x'.repeat(MAX_PART_TEXT - pointer.length - 2)}&${'y'.repeat(200)}`;
    const interaction = interactionRefSchema.parse(
      JSON.stringify({
        channel: 'C_ORCH',
        user: 'U_OPERATOR',
        triggerId: 'T1',
      }),
    );
    expect(
      await gateway.respond(
        interaction,
        [{ kind: 'paragraph', children: [{ kind: 'text', text: content }] }],
        { private: true, cliHint: 'board task history PROJ-123' },
      ),
    ).toBe('sent');
    const posted = fake.requests().find((request) => request.method === 'chat.postEphemeral');
    const text = posted?.params.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_PART_TEXT);
    expect(text.endsWith(pointer)).toBe(true);
    expect(posted?.params.blocks ?? '').toContain(
      '"text":"More: board task history PROJ-123 (CLI)"',
    );
    expect(text.slice(0, -pointer.length)).not.toMatch(/&(?:a|am|amp|amp;)$/);
    expect(text).not.toContain('y'.repeat(200));
  });
});
