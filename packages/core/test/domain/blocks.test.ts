import { describe, expect, it } from 'vitest';
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
