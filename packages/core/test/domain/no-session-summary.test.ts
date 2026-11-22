import { describe, expect, it } from 'vitest';
import {
  noSessionSummary,
  parseNoSessionSummary,
  type NoSessionSummary,
} from '../../src/domain/fromYou.ts';

const RING = '2026-11-18T13:06:00.000Z';
const recorded = (spur: string, extra: Partial<NoSessionSummary> = {}): NoSessionSummary => ({
  project: 'first',
  column: 'review',
  spur,
  turn: 524,
  ringAt: RING,
  ...extra,
});

describe('no-session summary', () => {
  it.each([
    ['a plain Spur project', recorded('first-orch')],
    ['a Spur project holding "; "', recorded('QA; West')],
    [
      'a Spur project holding an oldest clause',
      recorded('QA; oldest T9 since 2026-11-18T12:00:00.000Z'),
    ],
    ['a hyphenated column', recorded('orbit-qa', { column: 'ready-to-merge', turn: 1 })],
  ])('reads back what it wrote for %s', (_, summary) => {
    const text = noSessionSummary(summary);
    expect(parseNoSessionSummary(text)).toEqual(summary);
  });

  it('writes the stored wording', () => {
    expect(noSessionSummary(recorded('first-orch'))).toBe(
      `first review: turns wait for a live session of Spur project first-orch; oldest T524 since ${RING}`,
    );
  });

  it.each([
    [
      'a summary without the oldest clause',
      'first review: turns wait for a live session of Spur project first-orch',
    ],
    [
      'a ring time that is not a date',
      'first review: turns wait for a live session of Spur project first-orch; oldest T5 since not-a-date',
    ],
    ['other text', 'first review: something else happened'],
  ])('reads nothing from %s', (_, text) => {
    expect(parseNoSessionSummary(text)).toBeUndefined();
  });
});
