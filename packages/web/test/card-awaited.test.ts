import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import { awaitedMarker, markers } from '../src/board/card.ts';
import type { BoardRow } from '../src/board/model.ts';
import { row, status } from './board-fixtures.ts';

/** A fixture row parsed as `status.get` returns it. */
function typed(raw: Record<string, unknown>): BoardRow {
  const [parsed] = browserOperations['status.get'].output.parse(status([raw])).tasks;
  if (parsed === undefined) throw new Error('no row');
  return parsed;
}
const SIX = ['owner-a', 'web-owners', 'carol', 'dana', 'erin', 'frank'];
const card = (awaitedReviewers: string[], column = 'external-review', extra = {}) =>
  typed(row('ex/repo#7', column, { awaitedReviewers, ...extra }));
const chip = { tone: 'default', icon: 'person', wrap: true };

describe('task card awaited reviewers', () => {
  it.each([
    [['owner-a'], 'waiting for owner-a'],
    [['owner-a', 'web-owners'], 'waiting for owner-a, web-owners'],
    [['owner-a', 'web-owners', 'carol'], 'waiting for owner-a, web-owners +1'],
    [SIX, 'waiting for owner-a, web-owners +4'],
  ])('%j shows %s and names every one in the tooltip and label', (names, text) => {
    expect(awaitedMarker(card(names))).toEqual({
      ...chip,
      text,
      title: `Waiting for ${names.join(', ')}`,
      label: `waiting for ${names.join(', ')}`,
    });
  });

  it('shows outside External Review never, nor without a list', () => {
    for (const column of ['dev', 'ready-to-merge'])
      expect(awaitedMarker(card(['owner-a'], column))).toBeNull();
    expect(awaitedMarker(typed(row('ex/repo#7', 'external-review')))).toBeNull();
  });

  it('comes first among the markers, before an operator block', () => {
    const blocked = card(['owner-a'], 'external-review', {
      openBlocks: 1,
      blocks: [{ id: 'B5', addressee: 'operator', session: null }],
    });
    expect(markers(blocked, null).map((marker) => marker.text)).toEqual([
      'waiting for owner-a',
      'B5 → you',
    ]);
  });
});
