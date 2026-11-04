import { describe, expect, it } from 'vitest';
import { normalizeInteraction, normalizeMessage } from '../src/normalize.ts';

const bot = { userId: 'U_BOT', botId: 'B_BOT' };
const root = { ts: '1760000000.000001', blocks: [{ block_id: 'spur:open-key' }] };
const context = { bot, root, rootTs: root.ts };

describe('Slack inbound normalization', () => {
  it('gives duplicate top-level mentions the same event, including retries', () => {
    const message = {
      type: 'message',
      channel: 'C_ONE',
      ts: '1760000001.000002',
      text: 'please look <@U_BOT>',
      user: 'U_OPERATOR',
    };
    const regular = normalizeMessage('C_ONE', message, { bot, root: message });
    const mention = normalizeMessage(
      'C_ONE',
      { ...message, type: 'app_mention' },
      {
        bot,
        root: message,
      },
    );
    const retry = normalizeMessage(
      'C_ONE',
      { ...message, retry_attempt: 3 },
      {
        bot,
        root: message,
      },
    );
    expect(regular).toEqual(mention);
    expect(regular).toEqual(retry);
    expect(regular).toMatchObject([
      { kind: 'mention', dedupeKey: 'slack:C_ONE:1760000001.000002', author: 'U_OPERATOR' },
    ]);
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
      { kind: 'message', originKey: 'open-key', dedupeKey: 'slack:C_ONE:1760000002.000003' },
    ]);
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

  it('uses trigger IDs for command and action retries', () => {
    const command = {
      trigger_id: 'TRIGGER-1',
      user_id: 'U_OPERATOR',
      channel_id: 'C_ONE',
      text: 'status',
    };
    const action = {
      trigger_id: 'TRIGGER-2',
      user: { id: 'U_OPERATOR' },
      channel: { id: 'C_ONE' },
      message: { ts: root.ts, blocks: root.blocks },
      actions: [{ action_id: 'approve' }],
    };
    expect(normalizeInteraction('slash_commands', command)[0]?.dedupeKey).toBe('slack:TRIGGER-1');
    expect(normalizeInteraction('slash_commands', { ...command, retry_attempt: 2 })).toEqual(
      normalizeInteraction('slash_commands', command),
    );
    expect(normalizeInteraction('interactive', action)[0]?.dedupeKey).toBe('slack:TRIGGER-2');
  });
});
