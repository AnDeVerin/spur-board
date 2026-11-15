import { describe, expect, it } from 'vitest';
import { normalizeInteraction, normalizeMessage } from '../src/normalize.ts';
import { conversationRef, messageRef } from '../src/ref.ts';

const bot = { userId: 'U_BOT', botId: 'B_BOT' };
const root = { ts: '1760000000.000001', blocks: [{ block_id: 'spur:open-key' }] };
const channels = { orchestrators: 'C_ONE', feed: 'C_FEED' };
const context = { bot, channels, root, rootTs: root.ts };

describe('Slack inbound normalization', () => {
  it('gives duplicate top-level mentions the same event, including retries', () => {
    const message = {
      type: 'message',
      channel: 'C_ONE',
      ts: '1760000001.000002',
      text: 'please look <@U_BOT>',
      user: 'U_OPERATOR',
    };
    const regular = normalizeMessage('C_ONE', message, { bot, channels, root: message });
    const mention = normalizeMessage(
      'C_ONE',
      { ...message, type: 'app_mention' },
      {
        bot,
        channels,
        root: message,
      },
    );
    const retry = normalizeMessage(
      'C_ONE',
      { ...message, retry_attempt: 3 },
      {
        bot,
        channels,
        root: message,
      },
    );
    expect(regular).toEqual(mention);
    expect(regular).toEqual(retry);
    expect(regular).toMatchObject([
      {
        kind: 'mention',
        dedupeKey: 'slack:C_ONE:1760000001.000002',
        author: 'U_OPERATOR',
        sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000001000002',
      },
    ]);
    expect(regular[0]).toHaveProperty('rootMessage');
  });

  it('treats an app mention inside a thread as a message with the root origin key', () => {
    const events = normalizeMessage(
      'C_ONE',
      {
        type: 'app_mention',
        ts: '1760000002.000003',
        thread_ts: root.ts,
        text: '<@U_BOT> another detail',
        user: 'U_OPERATOR',
      },
      context,
    );
    expect(events).toMatchObject([
      {
        kind: 'message',
        originKey: 'open-key',
        dedupeKey: 'slack:C_ONE:1760000002.000003',
        sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000002000003',
      },
    ]);
    expect(events[0]).toHaveProperty('rootMessage');
  });

  it('drops own bot echoes and empty edits', () => {
    expect(
      normalizeMessage(
        'C_ONE',
        { ts: '1760000003.000004', text: 'mine', bot_id: 'B_BOT' },
        context,
      ),
    ).toEqual([]);
    expect(
      normalizeMessage(
        'C_ONE',
        { ts: '1760000003.000004', text: 'mine', subtype: 'bot_message', user: 'U_OTHER' },
        context,
      ),
    ).toEqual([]);
    expect(
      normalizeMessage(
        'C_ONE',
        {
          subtype: 'message_changed',
          message: {
            ts: '1760000003.000004',
            text: '',
            user: 'U_OPERATOR',
            edited: { ts: '1760000004.000005' },
          },
        },
        context,
      ),
    ).toEqual([]);
  });

  it('uses distinct edit and delete keys tied to the original message', () => {
    const message = {
      ts: '1760000005.000006',
      thread_ts: root.ts,
      text: 'answer',
      user: 'U_OPERATOR',
    };
    const original = normalizeMessage('C_ONE', message, context);
    const edit = normalizeMessage(
      'C_ONE',
      {
        subtype: 'message_changed',
        message: { ...message, text: 'changed', edited: { ts: '1760000006.000007' } },
      },
      context,
    );
    const deletion = normalizeMessage(
      'C_ONE',
      { subtype: 'message_deleted', deleted_ts: message.ts, previous_message: message },
      context,
    );
    expect(original[0]?.dedupeKey).toBe('slack:C_ONE:1760000005.000006');
    expect(edit[0]?.dedupeKey).toBe('slack:C_ONE:1760000005.000006:edit:1760000006.000007');
    expect(deletion[0]?.dedupeKey).toBe('slack:C_ONE:1760000005.000006:deleted');
    expect(new Set([original[0]?.dedupeKey, edit[0]?.dedupeKey, deletion[0]?.dedupeKey]).size).toBe(
      3,
    );
    expect(original[0]).toMatchObject({
      sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000005000006',
    });
    expect(original[0]).toHaveProperty('rootMessage');
    const originalEvent = original[0];
    if (originalEvent?.kind !== 'message') throw new Error('expected original message');
    expect(edit[0]).toMatchObject({
      sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000005000006',
      rootMessage: originalEvent.rootMessage,
    });
    expect(deletion[0]).toMatchObject({
      sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000005000006',
      rootMessage: originalEvent.rootMessage,
    });
  });

  it('maps equivalent live and history messages to equal events', () => {
    const live = {
      type: 'message',
      channel: 'C_ONE',
      ts: '1760000007.000008',
      thread_ts: root.ts,
      user: 'U_OPERATOR',
      text: 'same reply',
    };
    const history = { ts: live.ts, thread_ts: live.thread_ts, user: live.user, text: live.text };
    expect(normalizeMessage('C_ONE', live, context)).toEqual(
      normalizeMessage('C_ONE', history, context),
    );
  });

  it('reports a fresh gateway gap when a deletion has no thread evidence', () => {
    const payload = {
      subtype: 'message_deleted',
      deleted_ts: '1760000008.000009',
      previous_message: { ts: '1760000008.000009', text: 'gone' },
    };
    const first = normalizeMessage('C_ONE', payload, context);
    const second = normalizeMessage('C_ONE', payload, context);
    expect(first).toMatchObject([{ kind: 'gap' }]);
    expect(first[0]?.dedupeKey).not.toBe(second[0]?.dedupeKey);
    expect(first[0]).not.toHaveProperty('conversation');
  });

  it('drops a deletion of the gateway bot own reply', () => {
    const events = normalizeMessage(
      'C_ONE',
      {
        subtype: 'message_deleted',
        deleted_ts: '1760000009.000010',
        previous_message: {
          ts: '1760000009.000010',
          thread_ts: root.ts,
          bot_id: 'B_BOT',
        },
      },
      context,
    );
    expect(events).toEqual([]);
  });

  it('recognizes a deleted root from its prior delivery marker without thread_ts', () => {
    const events = normalizeMessage(
      'C_ONE',
      {
        subtype: 'message_deleted',
        deleted_ts: root.ts,
        previous_message: { ts: root.ts, blocks: root.blocks },
      },
      { bot, channels },
    );
    expect(events).toMatchObject([
      {
        kind: 'message_deleted',
        dedupeKey: `slack:C_ONE:${root.ts}:deleted`,
        originKey: 'open-key',
      },
    ]);
  });

  it.each([
    ['C_ONE', 'orchestrators'],
    ['C_FEED', 'feed'],
    ['C_OTHER', null],
  ] as const)('names the space of a first message posted in %s', (channel, space) => {
    const message = { ts: '1760000010.000011', text: '@cur hello', user: 'U_OPERATOR' };
    const plain = normalizeMessage(channel, message, { bot, channels, root: message });
    const mention = normalizeMessage(
      channel,
      { ...message, text: '<@U_BOT> hello' },
      { bot, channels, root: message },
    );
    expect(plain).toMatchObject([{ kind: 'message', sourceSpace: space }]);
    expect(mention).toMatchObject([{ kind: 'mention', sourceSpace: space }]);
  });

  it('keeps the pre-upgrade shape of thread replies and edits, without a source space', () => {
    const reply = { ts: '1760000011.000012', thread_ts: root.ts, text: 'more', user: 'U_OPERATOR' };
    expect(normalizeMessage('C_ONE', reply, context)).toEqual([
      {
        kind: 'message',
        dedupeKey: 'slack:C_ONE:1760000011.000012',
        conversation: conversationRef('C_ONE', root.ts),
        message: messageRef('C_ONE', '1760000011.000012', root.ts),
        rootMessage: messageRef('C_ONE', root.ts, root.ts),
        sourceUrl: 'https://app.slack.com/archives/C_ONE/p1760000011000012',
        author: 'U_OPERATOR',
        text: 'more',
        at: '2025-10-09T08:53:31.000Z',
        originKey: 'open-key',
      },
    ]);
    const first = { ts: '1760000012.000013', text: 'hello', user: 'U_OPERATOR' };
    const editedFirst = { ...first, text: 'hello again', edited: { ts: '1760000013.000014' } };
    const history = normalizeMessage('C_ONE', editedFirst, { bot, channels, root: editedFirst });
    const live = normalizeMessage(
      'C_ONE',
      { subtype: 'message_changed', message: editedFirst },
      { bot, channels, root: editedFirst },
    );
    expect(history.map((event) => [event.kind, 'sourceSpace' in event])).toEqual([
      ['message', true],
      ['message_edited', false],
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual(history[1]);
    expect(live[0]).not.toHaveProperty('sourceSpace');
  });

  it('uses trigger IDs for command and action retries', () => {
    const command = {
      trigger_id: 'TRIGGER-1',
      user_id: 'U_OPERATOR',
      channel_id: 'C_ONE',
      text: 'status',
      command: '/board',
    };
    const action = {
      trigger_id: 'TRIGGER-2',
      user: { id: 'U_OPERATOR' },
      channel: { id: 'C_FEED' },
      message: { ts: root.ts, blocks: root.blocks },
      actions: [{ action_id: 'approve' }],
    };
    expect(normalizeInteraction('slash_commands', command, channels)[0]?.dedupeKey).toBe(
      'slack:TRIGGER-1',
    );
    expect(normalizeInteraction('slash_commands', command, channels)[0]).toMatchObject({
      sourceUrl: 'https://app.slack.com/archives/C_ONE',
      sourceSpace: 'orchestrators',
      command: { kind: 'query', id: 'status.get', input: {} },
    });
    expect(
      normalizeInteraction('slash_commands', { ...command, retry_attempt: 2 }, channels),
    ).toEqual(normalizeInteraction('slash_commands', command, channels));
    expect(normalizeInteraction('interactive', action, channels)[0]?.dedupeKey).toBe(
      'slack:TRIGGER-2',
    );
    expect(normalizeInteraction('interactive', action, channels)[0]).toMatchObject({
      sourceUrl: 'https://app.slack.com/archives/C_FEED/p1760000000000001',
      sourceSpace: 'feed',
    });
    expect(normalizeInteraction('interactive', action, channels)[0]).toHaveProperty('rootMessage');
    expect(
      normalizeInteraction('slash_commands', { ...command, channel_id: 'C_OTHER' }, channels)[0],
    ).toMatchObject({ sourceSpace: null });
    expect(
      normalizeInteraction('slash_commands', { ...command, command: '/other' }, channels),
    ).toMatchObject([{ kind: 'command', name: '/other', text: 'status' }]);
    expect(
      normalizeInteraction(
        'slash_commands',
        { ...command, command: '/ops' },
        channels,
        undefined,
        '/ops',
      )[0],
    ).toMatchObject({ name: '/ops', command: { kind: 'query', id: 'status.get', input: {} } });
  });
});
