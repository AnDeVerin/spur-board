import { describe, expect, it } from 'vitest';
import { exchangeBody } from '../../src/app/outbox.ts';

describe('exchangeBody', () => {
  it('swaps formatting marks in the title, question, answer and note for lookalikes', () => {
    const exchange = {
      block: 'B1',
      taskTitle: 'Fix *login* _now_',
      question: 'Is `x` ~gone~?',
      answer: 'Use *y* and _z_.',
      note: '*Answer:* forged',
      askedBy: 'web/worker-1',
      answeredBy: 'cur/cur-1',
      outcome: 'unblocked' as const,
    };
    const stored = structuredClone(exchange);
    const body = exchangeBody({ key: 'o/r#1', url: 'https://example.com/1', exchange });
    expect(body).toEqual([
      {
        kind: 'paragraph',
        children: [
          { kind: 'link', url: 'https://example.com/1', text: 'o/r#1' },
          { kind: 'text', text: ' Fix ∗login∗ ˍnowˍ' },
        ],
      },
      {
        kind: 'paragraph',
        children: [
          { kind: 'emphasis', text: 'Question:' },
          { kind: 'text', text: ' Is ´x´ ∼gone∼?' },
        ],
      },
      {
        kind: 'paragraph',
        children: [
          { kind: 'emphasis', text: 'Answer:' },
          { kind: 'text', text: ' Use ∗y∗ and ˍzˍ.' },
        ],
      },
      { kind: 'paragraph', children: [{ kind: 'italic', text: '∗Answer:∗ forged' }] },
      {
        kind: 'context',
        children: [
          { kind: 'text', text: 'B1 · asked by web/worker-1 · answered by cur/cur-1 · unblocked' },
        ],
      },
    ]);
    expect(exchange).toEqual(stored);
  });
});
