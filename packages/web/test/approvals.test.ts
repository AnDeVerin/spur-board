import { browserOperations } from '@spur-board/contracts/browser';
import { describe, expect, it } from 'vitest';
import { approvalState } from '../src/board/approvals.ts';
import { markers, prStatus } from '../src/board/card.ts';
import type { BoardRow } from '../src/board/model.ts';
import { prLink, prSummary, row, status } from './board-fixtures.ts';

const SHA = 'a'.repeat(40);
const HEAD = 'f'.repeat(40);

/** A Ready to Merge row (or `column`) whose first PR summary carries `approvals`. */
function card(
  approvals: unknown[] | undefined,
  summary: Record<string, unknown> = {},
  column = 'ready-to-merge',
): BoardRow {
  const raw = row('ex/repo#7', column, {
    links: { ticket: null, prs: [prLink(1)], sessions: [] },
    prSummary: [prSummary({ ...(approvals === undefined ? {} : { approvals }), ...summary })],
  });
  const [parsed] = browserOperations['status.get'].output.parse(status([raw])).tasks;
  if (parsed === undefined) throw new Error('no row');
  return parsed;
}

const approval = (author: string, extra: Record<string, unknown> = {}) => ({
  author,
  sha: SHA,
  onHead: false,
  ...extra,
});
const onHead = (author = 'fay') =>
  approval(author, {
    sha: HEAD,
    onHead: true,
    commitsAfter: 0,
    changedAfter: [],
    watchedAfter: [],
  });
const staleWatched = approval('dana', {
  commitsAfter: 3,
  changedAfter: ['back/', 'docs/', 'front/'],
  watchedAfter: ['back/', 'front/'],
});
const staleQuiet = approval('erin', {
  commitsAfter: 2,
  changedAfter: ['docs/'],
  watchedAfter: [],
});
const SIX = ['api/', 'back/', 'docs/', 'front/', 'infra/', 'web/'];

/** The reviews cell as `[tone, text, suffix, title, label]`. */
function reviews(target: BoardRow) {
  const shown = prStatus(target);
  if (shown.kind !== 'cells') throw new Error(`no cells: ${shown.kind}`);
  const { tone, text, suffix, title, label } = shown.cells[3];
  return [tone, text, suffix, title, label];
}
/** The first marker as `[tone, icon, text, title]`, or null when it is not an approval chip. */
function chip(target: BoardRow) {
  const [first] = markers(target, null);
  if (first?.icon !== 'person') return null;
  return [first.tone, first.icon, first.text, first.title];
}

const STALE_TITLE = 'Approved 3 commits ago; changed since: back/, docs/, front/';
const STALE_CHIP = [
  'warn',
  'person',
  'approved before back/ front/',
  `dana approved ${SHA}; 3 commits since changed back/, front/.`,
];
const REWRITTEN_TITLE =
  'Changes since the approval not counted: history rewritten after the approval';

describe('approval freshness on a Ready to Merge card', () => {
  it.each([
    ['on the head', [onHead()], ['ok', '1', undefined, 'Approved on the head'], null],
    ['stale, watched', [staleWatched], ['pend', '1', '+3', STALE_TITLE], STALE_CHIP],
    [
      'stale, quiet',
      [staleQuiet],
      ['ok', '1', '+2', 'Approved 2 commits ago; changed since: docs/'],
      null,
    ],
    [
      'multi',
      [
        approval('dana', { commitsAfter: 4, changedAfter: ['back/'], watchedAfter: ['back/'] }),
        onHead(),
      ],
      ['pend', '2', '+4', 'Approved 4 commits ago; changed since: back/'],
      [
        'warn',
        'person',
        'approved before back/',
        `dana approved ${SHA}; 4 commits since changed back/.`,
      ],
    ],
    [
      'rewritten',
      [approval('gus', { notCounted: 'history_rewritten' })],
      ['pend', '1', '?', REWRITTEN_TITLE],
      [
        'warn',
        'person',
        'approval: history rewritten',
        'The history was rewritten after the approval; what changed since is not counted.',
      ],
    ],
    [
      'too large',
      [approval('hal', { notCounted: 'pr_too_large' })],
      ['ok', '1', '?', 'Changes since the approval not counted: the PR is too large to compare'],
      null,
    ],
    [
      'rate limit',
      [approval('ivy', { notCounted: 'rate_limit' })],
      ['ok', '1', '?', 'Changes since the approval not counted: GitHub rate limit'],
      null,
    ],
    [
      'not read yet',
      [approval('jo')],
      ['ok', '1', '?', 'Changes since the approval not read yet'],
      null,
    ],
    [
      'off the head after merges only',
      [approval('kai', { commitsAfter: 0, changedAfter: [], watchedAfter: [] })],
      ['ok', '1', '+0', 'Approved 0 commits ago; changed since: nothing'],
      null,
    ],
    [
      'six watched entries',
      [approval('dana', { commitsAfter: 1, changedAfter: SIX, watchedAfter: SIX })],
      ['pend', '1', '+1', `Approved 1 commit ago; changed since: ${SIX.join(', ')}`],
      [
        'warn',
        'person',
        'approved before api/ back/ +4',
        `dana approved ${SHA}; 1 commit since changed ${SIX.join(', ')}.`,
      ],
    ],
  ])('%s', (_, approvals, [tone, text, suffix, title], expected) => {
    const target = card(approvals);
    expect(reviews(target)).toEqual([
      tone,
      text,
      suffix,
      title,
      `Approvals: ${String(text)}; ${String(title)}`,
    ]);
    expect(chip(target)).toEqual(expected);
  });

  it.each([
    [
      'two long entries',
      ['deployment-config/', 'integration-tests/'],
      'deployment-config/ integration-tests/',
    ],
    [
      'one entry without a break',
      ['a-very-long-top-level-directory-name/'],
      'a-very-long-top-level-directory-name/',
    ],
    [
      'long entries past the cap',
      ['deployment-config/', 'integration-tests/', 'web/'],
      'deployment-config/ integration-tests/ +1',
    ],
  ])('a loud chip over %s wraps and names each entry in full', (_, entries, names) => {
    const [first] = markers(
      card([approval('dana', { commitsAfter: 1, changedAfter: entries, watchedAfter: entries })]),
      null,
    );
    expect([first?.text, first?.wrap]).toEqual([`approved before ${names}`, true]);
  });

  it('any approval asking for a look sets the tone and the chip, in either order', () => {
    for (const approvals of [
      [staleQuiet, staleWatched],
      [staleWatched, staleQuiet],
    ]) {
      const target = card(approvals);
      expect(reviews(target)).toEqual([
        'pend',
        '2',
        '+3',
        STALE_TITLE,
        `Approvals: 2; ${STALE_TITLE}`,
      ]);
      expect(chip(target)).toEqual(STALE_CHIP);
    }
  });

  it('changes requested keep the cell as before and the chip still shows', () => {
    const target = card([staleWatched], {
      reviewsOnHead: { approved: [], changesRequested: ['eve'] },
    });
    expect(reviews(target)).toEqual([
      'bad',
      '1',
      undefined,
      undefined,
      'Reviews on the head: 1 changes requested',
    ]);
    expect(chip(target)).toEqual(STALE_CHIP);
  });

  it('unconfirmed cells turn neutral with the suffix kept; the chip stays warn', () => {
    const target = card([staleWatched], { unconfirmed: true });
    expect(reviews(target)).toEqual([
      'neutral',
      '1',
      '+3',
      `${STALE_TITLE}, not confirmed`,
      `Approvals: 1; ${STALE_TITLE}, not confirmed`,
    ]);
    expect(chip(target)).toEqual(STALE_CHIP);
  });

  it('outside Ready to Merge or without approval facts the cell is as before', () => {
    const today = ['ok', '1', undefined, undefined, 'Reviews on the head: 1 approved'];
    const approved = { reviewsOnHead: { approved: ['fay'], changesRequested: [] } };
    const dev = card([staleWatched], approved, 'dev');
    expect(reviews(dev)).toEqual(today);
    expect(chip(dev)).toBeNull();
    expect(markers(dev, null)).toEqual([]);
    const none = card(undefined, approved);
    expect(reviews(none)).toEqual(today);
    expect(markers(none, null)).toEqual([]);
  });

  it('approvalState names the kind, whether it is loud and the watched entries', () => {
    expect(approvalState(staleWatched)).toMatchObject({
      kind: 'stale',
      loud: true,
      watched: ['back/', 'front/'],
    });
    expect(approvalState(staleQuiet)).toMatchObject({ kind: 'stale', loud: false, watched: [] });
    expect(approvalState(onHead())).toMatchObject({ kind: 'fresh', loud: false });
    expect(approvalState(approval('jo'))).toMatchObject({ kind: 'unread', loud: false });
    expect(approvalState(approval('gus', { notCounted: 'history_rewritten' }))).toMatchObject({
      kind: 'rewritten',
      loud: true,
    });
    expect(approvalState(approval('hal', { notCounted: 'pr_too_large' }))).toMatchObject({
      kind: 'uncounted',
      loud: false,
    });
  });
});
