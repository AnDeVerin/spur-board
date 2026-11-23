import { describe, expect, it } from 'vitest';
import { whyRows } from '../src/board/task-model.ts';
import { condition, gate, parsedTask } from './board-fixtures.ts';

const NOW = Date.parse('2026-11-15T14:00:00.000Z');
const COLUMNS: Parameters<typeof whyRows>[1] = [
  { id: 'todo' },
  { id: 'dev' },
  { id: 'external-review' },
  { id: 'done' },
];
const SIX = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
const awaiting = (waiting?: unknown[]) =>
  parsedTask({
    column: 'external-review',
    gates: [
      gate('external-review', [
        condition('approved', 'met'),
        condition('review_rule_satisfied', 'failed', 'awaiting_required_reviewers'),
      ]),
    ],
    ...(waiting === undefined ? {} : { waiting }),
  });
const ruleRow = (value: ReturnType<typeof awaiting>) =>
  whyRows(value, COLUMNS, NOW).find((row) => row.key === 'review rule satisfied');

describe('why rows for awaited reviewers', () => {
  it('a failed review rule names every awaited reviewer, without +N', () => {
    const waiting = [
      {
        reason: 'awaiting_required_reviewers',
        head: 'a'.repeat(40),
        text: `awaiting required reviewers: ${SIX.join(', ')}`,
        reviewers: SIX,
      },
    ];
    expect(ruleRow(awaiting(waiting))).toEqual({
      key: 'review rule satisfied',
      value: 'awaiting required reviewers: n1, n2, n3, n4, n5, n6',
      status: 'fail',
    });
  });

  it('without a waiting entry the reason stands alone', () => {
    expect(ruleRow(awaiting())).toEqual({
      key: 'review rule satisfied',
      value: 'awaiting required reviewers',
      status: 'fail',
    });
  });
});
