import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  conversationRefSchema,
  messageRefSchema,
  userIdSchema,
} from '@spur-board/contracts';
import { createFakeGateway } from '@spur-board/gateway-testkit';
import { describe, expect, it } from 'vitest';
import { createInbound, openStore } from '../../src/index.ts';
import {
  acknowledgeComment,
  answerBlock,
  blockAddressee,
  closeBlock,
  editComment,
  escalateBlock,
  type CurrentBlock,
} from '../../src/domain/blocks/blocks.ts';

const question: CurrentBlock = {
  type: 'needs_input',
  state: 'open',
  outcome: null,
  unblockedBy: null,
  author: 'agent:web/worker-1',
  addressee: 'orchestrator:dev',
};

describe('block routing', () => {
  const base = {
    author: question.author,
    authorRole: 'worker' as const,
    column: 'dev' as const,
    orchestrator: 'qa',
    hasWorker: true,
  };

  it('routes questions to the column orchestrator, except its own or an unassigned column', () => {
    expect(blockAddressee({ ...base, type: 'needs_input' })).toBe('orchestrator:dev');
    expect(blockAddressee({ ...base, type: 'needs_input', author: 'agent:qa/qa-1' })).toBe(
      'operator',
    );
    expect(blockAddressee({ ...base, type: 'needs_input', orchestrator: null })).toBe('operator');
    expect(blockAddressee({ ...base, type: 'needs_input', orchestrator: 'operator' })).toBe(
      'operator',
    );
  });

  it('routes dependency and external blocks to their author role, and code to worker', () => {
    expect(blockAddressee({ ...base, type: 'dependency' })).toBe('worker');
    expect(blockAddressee({ ...base, type: 'external', authorRole: 'orchestrator:dev' })).toBe(
      'orchestrator:dev',
    );
    expect(blockAddressee({ ...base, type: 'code' })).toBe('worker');
  });

  it('routes a system block to the executor fallback', () => {
    expect(blockAddressee({ ...base, type: 'code', author: 'system' })).toBe('orchestrator:dev');
    expect(blockAddressee({ ...base, type: 'code', author: 'system', orchestrator: null })).toBe(
      'worker',
    );
    expect(
      blockAddressee({
        ...base,
        type: 'code',
        author: 'system',
        orchestrator: null,
        hasWorker: false,
      }),
    ).toBe('operator');
  });
});

describe('block transitions', () => {
  it('escalates once and a second escalation is a no-op', () => {
    expect(escalateBlock(question)).toEqual({ addressee: 'operator', changed: true });
    expect(escalateBlock({ ...question, addressee: 'operator' })).toEqual({
      addressee: 'operator',
      changed: false,
    });
  });

  it('rejects a wrong-type answer and reports closure details on later actions', () => {
    expect(() => {
      answerBlock({ ...question, type: 'code' });
    }).toThrow('Only a question');
    const closed = {
      ...question,
      state: 'unblocked' as const,
      outcome: 'done' as const,
      unblockedBy: 'operator' as const,
    };
    for (const action of [
      () => {
        answerBlock(closed);
      },
      () => closeBlock(closed, { mode: 'done' }),
      () => closeBlock(closed, { mode: 'reason', reason: 'done elsewhere' }),
    ])
      expect(action).toThrow('done by operator');
  });

  it('accepts done with or without a reference and restricts withdrawal to its author', () => {
    const code = { ...question, type: 'code' as const };
    expect(closeBlock(code, { mode: 'done' })).toEqual({ outcome: 'done', outcomeReason: null });
    expect(closeBlock(code, { mode: 'done', ref: 'commit-1' })).toEqual({
      outcome: 'done',
      outcomeReason: 'commit-1',
    });
    expect(closeBlock(question, { mode: 'withdraw', actor: question.author })).toEqual({
      outcome: 'withdrawn',
      outcomeReason: null,
    });
    expect(() => closeBlock(question, { mode: 'withdraw', actor: 'agent:web/worker-2' })).toThrow(
      'Only the question author',
    );
    expect(() => closeBlock(code, { mode: 'withdraw', actor: question.author })).toThrow(
      'Only the question author',
    );
  });
});

describe('comment revisions', () => {
  it('keeps an old acknowledgement when an edit becomes a clarification', () => {
    expect(editComment(1, null)).toEqual({ revision: 2, clarification: false });
    expect(editComment(2, 2)).toEqual({ revision: 3, clarification: true });
    expect(() => acknowledgeComment(3, 2)).toThrow('revision is 3');
    expect(acknowledgeComment(3, 3)).toBe(3);
  });
});

describe('conversation block ownership', () => {
  it('answers the matching block and treats a later closed-thread message as its clarification', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'block-conversation-')), 'board.db');
    const store = openStore(file);
    try {
      const at = '2026-11-03T10:00:00.000Z';
      const gateway = createFakeGateway({ profile: 'slack-like' });
      const config = configSchema.parse({
        projects: [
          {
            id: 'proj',
            tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
            repos: ['o/r'],
            operatorGithubLogin: 'operator',
            spurProjects: [{ name: 'web', role: 'worker' }],
          },
        ],
        operator: { slack: 'operator' },
        digest: { tz: 'UTC' },
      });
      await store.transaction(async (trx) => {
        await trx
          .insertInto('task')
          .values({
            project: 'proj',
            tracker_kind: 'github-issues',
            tracker_id: '101',
            key: 'o/r#101',
            membership: 'active',
            archive_reason: null,
            column: 'dev',
            shadow_column: null,
            created_at: at,
          })
          .execute();
        for (const id of [1, 2]) {
          await trx
            .insertInto('block')
            .values({
              id,
              task_id: 1,
              type: 'needs_input',
              reason: `Question ${String(id)}`,
              author: 'system',
              addressee_role: 'operator',
              target_column: null,
              state: 'open',
              outcome: null,
              outcome_reason: null,
              repeat_of: null,
              unblocked_by: null,
              unblocked_at: null,
              created_at: at,
            })
            .execute();
          await trx
            .insertInto('conversation')
            .values({
              gateway: gateway.kind,
              ref: conversationRefSchema.parse(`thread-${String(id)}`),
              space: 'orchestrators',
              task_id: 1,
              block_id: id,
              purpose: 'block',
              state: 'open',
              root_message_ref: messageRefSchema.parse(`root-${String(id)}`),
              after_message_ref: null,
              created_at: at,
              closed_at: null,
            })
            .execute();
        }
      });
      const inbound = createInbound({
        store,
        gateway,
        config,
        clock: { now: () => Date.parse(at) },
      });
      const event = (key: string, ref: string) => ({
        kind: 'message' as const,
        dedupeKey: key,
        conversation: conversationRefSchema.parse('thread-2'),
        message: messageRefSchema.parse(ref),
        rootMessage: messageRefSchema.parse('root-2'),
        sourceUrl: 'https://example.test/answer',
        author: userIdSchema.parse('operator'),
        text: key,
        at,
      });
      await inbound.sink(event('answer', 'reply-1'));
      await inbound.sink(event('clarification', 'reply-2'));
      expect(
        await store.db.selectFrom('block').select(['id', 'state']).orderBy('id').execute(),
      ).toEqual([
        { id: 1, state: 'open' },
        { id: 2, state: 'unblocked' },
      ]);
      expect(
        await store.db.selectFrom('comment').select(['block_id', 'text']).orderBy('id').execute(),
      ).toEqual([
        { block_id: 2, text: 'answer' },
        { block_id: 2, text: 'clarification' },
      ]);
      expect(
        await store.db.selectFrom('conversation').select(['ref', 'state']).orderBy('ref').execute(),
      ).toEqual([
        { ref: 'thread-1', state: 'open' },
        { ref: 'thread-2', state: 'closed' },
      ]);
      const closes = await store.db
        .selectFrom('outbox')
        .select(['kind', 'payload'])
        .where('kind', '=', 'conversation.close')
        .execute();
      expect(closes).toHaveLength(1);
      expect(JSON.parse(closes[0]?.payload ?? '{}')).toMatchObject({
        blockId: 2,
        targetConversation: 'thread-2',
        text: 'resolved: done (operator)',
      });
    } finally {
      await store.close();
    }
  });
});
