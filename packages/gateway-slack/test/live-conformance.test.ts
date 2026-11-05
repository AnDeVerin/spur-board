import { userIdSchema } from '@spur-board/contracts';
import { describe, expect, it, vi } from 'vitest';
import { parseRef } from '../src/ref.ts';
import { startFakeSlackApi } from './fake-api.ts';
import { runLiveConformance, type LivePrompt } from './live-conformance.ts';

vi.setConfig({ testTimeout: 15_000 });

const operator = userIdSchema.parse('U_OPERATOR');

function instructionToken(instruction: string): string {
  const found = /live-[a-f0-9-]+:[a-z-]+/.exec(instruction)?.[0];
  if (found === undefined) throw new Error('test prompt omitted its marker');
  return found;
}

describe('live conformance runner against the local Slack API', () => {
  it('reports every automated and guided case with history-only recovery', async () => {
    const fake = await startFakeSlackApi();
    let recoveryStart = 0;
    let recoveryEnd = 0;
    let mentionInstruction = '';
    const prompt: LivePrompt = async (id, instruction, context) => {
      if (id === 'guided-mention') mentionInstruction = instruction;
      if (id === 'recovery') {
        recoveryStart = fake.requests().length;
        await fake.platform.inject({
          kind: 'message',
          conversation: context.conversation,
          author: operator,
          text: instructionToken(instruction),
        });
      } else if (id === 'guided-reply' || id === 'guided-mention') {
        const text =
          id === 'guided-mention'
            ? `<@U_BOT> ${instructionToken(instruction)}`
            : instructionToken(instruction);
        const sent = await fake.platform.inject({
          kind: 'message',
          conversation: context.conversation,
          author: operator,
          text,
        });
        if (id === 'guided-mention') {
          const ref = parseRef(sent.message ?? '');
          if (ref === null) throw new Error('fake mention has no reference');
          await fake.emitEnvelope('events_api', {
            event: {
              type: 'app_mention',
              channel: ref.channel,
              ts: ref.ts,
              thread_ts: ref.threadTs,
              text,
              user: operator,
            },
          });
        }
      } else if (id === 'guided-edit') {
        if (context.message === undefined) throw new Error('guided edit has no message');
        await fake.platform.inject({
          kind: 'edit',
          message: context.message,
          text: instructionToken(instruction),
        });
      } else if (id === 'guided-button') {
        if (context.message === undefined) throw new Error('guided button has no message');
        await fake.platform.inject({
          kind: 'action',
          message: context.message,
          actionId: 'live_check',
          author: operator,
        });
      } else if (id === 'guided-slash') {
        await fake.emitEnvelope('slash_commands', {
          trigger_id: 'T_LIVE',
          channel_id: 'C_FEED',
          user_id: operator,
          text: instructionToken(instruction),
        });
      }
    };
    try {
      const report = await runLiveConformance({
        token: 'xoxb-test',
        appToken: 'xapp-test',
        channel: 'C_FEED',
        operator,
        apiUrl: fake.url,
        prompt,
        beforeCase: async (id) => {
          if (id === 'multipart') {
            await fake.platform.rateLimitNext(20);
          }
          if (id === 'bot-posts') recoveryEnd = fake.requests().length;
        },
      });
      expect(report.results).toHaveLength(10);
      expect(report.results.map((result) => result.status)).toEqual(Array(10).fill('pass'));
      expect(report.rateLimit.status).toBe('pass');
      expect(
        fake
          .requests()
          .slice(recoveryStart, recoveryEnd)
          .some((request) => request.method === 'conversations.replies'),
      ).toBe(true);
      expect(fake.requests().filter((request) => request.method === 'chat.update')).toHaveLength(1);
      expect(mentionInstruction).toContain('Reply in thread');
      expect(mentionInstruction).toContain('select the app from autocomplete');
      expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.stringify(report)).not.toContain('C_FEED');
      expect(JSON.stringify(report)).not.toContain('xoxb-test');
    } finally {
      await fake.close();
    }
  });

  it('records a timed-out guided case without dropping its declared result', async () => {
    const fake = await startFakeSlackApi();
    try {
      const report = await runLiveConformance({
        token: 'xoxb-test',
        appToken: 'xapp-test',
        channel: 'C_FEED',
        operator,
        apiUrl: fake.url,
        caseIds: ['delivery', 'guided-reply'],
        promptTimeoutMs: 20,
        prompt: async (_id, _instruction, _context, signal) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        },
      });
      expect(report.results.map((result) => [result.id, result.status])).toEqual([
        ['delivery', 'pass'],
        ['guided-reply', 'fail'],
      ]);
      expect(report.results[1]?.observation).toMatch(/timed out/);
    } finally {
      await fake.close();
    }
  });

  it('reports rate-limit not run when no incidental 429 occurs', async () => {
    const fake = await startFakeSlackApi();
    try {
      const report = await runLiveConformance({
        token: 'xoxb-test',
        appToken: 'xapp-test',
        channel: 'C_FEED',
        operator,
        apiUrl: fake.url,
        caseIds: ['delivery'],
        prompt: async () => {},
      });
      expect(report.results.map((result) => [result.id, result.status])).toEqual([
        ['delivery', 'pass'],
      ]);
      expect(report.rateLimit.status).toBe('not-run');
      expect(fake.requests().filter((request) => request.method === 'chat.update')).toHaveLength(1);
      expect(
        fake.requests().filter((request) => request.method === 'chat.postMessage'),
      ).toHaveLength(3);
    } finally {
      await fake.close();
    }
  });

  it('runs only the guided mention while creating its root thread', async () => {
    const fake = await startFakeSlackApi();
    let instruction = '';
    try {
      const report = await runLiveConformance({
        token: 'xoxb-test',
        appToken: 'xapp-test',
        channel: 'C_FEED',
        operator,
        apiUrl: fake.url,
        caseIds: ['guided-mention'],
        prompt: async (_id, text, context) => {
          instruction = text;
          await fake.platform.inject({
            kind: 'message',
            conversation: context.conversation,
            author: operator,
            text: `<@U_BOT> ${instructionToken(text)}`,
          });
        },
      });
      expect(report.results.map((result) => [result.id, result.status])).toEqual([
        ['guided-mention', 'pass'],
      ]);
      expect(report.rateLimit.status).toBe('not-run');
      expect(instruction).toContain('select the app from autocomplete');
      expect(
        fake.requests().filter((request) => request.method === 'chat.postMessage'),
      ).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });
});
