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
  priorAddressees,
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

describe('block routing with a curator', () => {
  const base = {
    type: 'needs_input' as const,
    author: question.author,
    authorRole: 'worker' as const,
    column: 'dev' as const,
    orchestrator: 'qa',
    curator: 'cur',
    hasWorker: true,
  };
  const curatorAsks = { author: 'agent:cur/cur-1' as const, authorRole: 'curator' as const };

  it('keeps a question at a column orchestrator other than its asker', () => {
    expect(blockAddressee(base)).toBe('orchestrator:dev');
  });

  it('routes an orchestrator question to the curator, or the operator without one', () => {
    const asker = { ...base, author: 'agent:qa/qa-1' as const };
    expect(blockAddressee(asker)).toBe('curator');
    expect(blockAddressee({ ...asker, curator: null })).toBe('operator');
  });

  it('routes a question in a column with no orchestrator to the curator, or the operator', () => {
    expect(blockAddressee({ ...base, orchestrator: null })).toBe('curator');
    expect(blockAddressee({ ...base, orchestrator: null, curator: null })).toBe('operator');
  });

  it('keeps a column assigned to the operator at the operator', () => {
    expect(blockAddressee({ ...base, orchestrator: 'operator' })).toBe('operator');
  });

  it('never routes the curator its own question', () => {
    expect(blockAddressee({ ...base, ...curatorAsks })).toBe('operator');
    expect(blockAddressee({ ...base, ...curatorAsks, orchestrator: null })).toBe('operator');
    expect(blockAddressee({ ...base, ...curatorAsks, orchestrator: 'cur' })).toBe('operator');
  });

  it('leaves code, dependency, external and system blocks off the curator', () => {
    expect(blockAddressee({ ...base, type: 'code' })).toBe('worker');
    expect(blockAddressee({ ...base, type: 'dependency', orchestrator: null })).toBe('worker');
    expect(blockAddressee({ ...base, type: 'external', authorRole: 'orchestrator:dev' })).toBe(
      'orchestrator:dev',
    );
    expect(blockAddressee({ ...base, author: 'system', orchestrator: null })).toBe('worker');
    expect(
      blockAddressee({ ...base, author: 'system', orchestrator: null, hasWorker: false }),
    ).toBe('operator');
  });
});

describe('block escalation chain', () => {
  it('walks a question from the orchestrator to the curator to the operator', () => {
    expect(escalateBlock(question, true)).toEqual({ addressee: 'curator', changed: true });
    expect(escalateBlock({ ...question, addressee: 'curator' }, true)).toEqual({
      addressee: 'operator',
      changed: true,
    });
    expect(escalateBlock({ ...question, addressee: 'operator' }, true)).toEqual({
      addressee: 'operator',
      changed: false,
    });
  });

  it('moves a block already at the curator to the operator after the curator left config', () => {
    expect(escalateBlock({ ...question, addressee: 'curator' }, false)).toEqual({
      addressee: 'operator',
      changed: true,
    });
  });

  it.each(['code', 'dependency', 'external'] as const)(
    'skips the curator for a %s block',
    (type) => {
      expect(escalateBlock({ ...question, type }, true)).toEqual({
        addressee: 'operator',
        changed: true,
      });
      expect(priorAddressees('orchestrator:dev', 'operator', type, true)).toEqual([
        'orchestrator:dev',
      ]);
      expect(priorAddressees('orchestrator:dev', 'curator', type, true)).toEqual([]);
    },
  );

  it('moves a worker-addressed block straight to the operator', () => {
    const code = { ...question, type: 'code' as const, addressee: 'worker' as const };
    expect(escalateBlock(code, true)).toEqual({ addressee: 'operator', changed: true });
    expect(priorAddressees('worker', 'operator', 'code', true)).toEqual(['worker']);
  });

  it('lists the steps before the current addressee of a question', () => {
    expect(priorAddressees('orchestrator:dev', 'orchestrator:dev', 'needs_input', true)).toEqual(
      [],
    );
    expect(priorAddressees('orchestrator:dev', 'curator', 'needs_input', true)).toEqual([
      'orchestrator:dev',
    ]);
    expect(priorAddressees('orchestrator:dev', 'operator', 'needs_input', true)).toEqual([
      'orchestrator:dev',
      'curator',
    ]);
    expect(priorAddressees('curator', 'operator', 'needs_input', true)).toEqual(['curator']);
    expect(priorAddressees('orchestrator:dev', 'operator', 'needs_input', false)).toEqual([
      'orchestrator:dev',
    ]);
  });

  it('finds no steps when the current addressee is off the path', () => {
    expect(priorAddressees('operator', 'curator', 'needs_input', true)).toEqual([]);
    expect(priorAddressees('orchestrator:qa', 'orchestrator:dev', 'needs_input', true)).toEqual([]);
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
    expect(
      closeBlock(question, { mode: 'withdraw', isAuthor: true, reason: 'Elsewhere.' }),
    ).toEqual({ outcome: 'withdrawn', outcomeReason: 'Elsewhere.' });
    expect(() =>
      closeBlock(question, { mode: 'withdraw', isAuthor: false, reason: 'Elsewhere.' }),
    ).toThrow('Only the question author');
    expect(() =>
      closeBlock(code, { mode: 'withdraw', isAuthor: true, reason: 'Elsewhere.' }),
    ).toThrow('Only the question author');
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
