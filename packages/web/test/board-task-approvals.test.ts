// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, quiet, type ChipTone } from '../src/ds/index.ts';
import { daemon, envelope, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, settle } from './board-harness.ts';

mountEachTest();

const chipClass = (tone: ChipTone, wrap = false) =>
  /class="([^"]*)"/.exec(
    renderToStaticMarkup(createElement(Chip, { tone, wrap, children: 'x' })),
  )?.[1];
/** Changed-entry chips wrap, so a long path name stays inside the row. */
const WATCHED = [chipClass('warn', true), 'Changed since the approval; watched'];
const NOT_WATCHED = [chipClass('ghost', true), 'Changed since the approval; not watched'];
/** A loud row is not quiet, so a not watched chip there takes the default tone, not ghost. */
const NOT_WATCHED_LOUD = [chipClass('default', true), 'Changed since the approval; not watched'];

const sha = (char: string) => char.repeat(40);
const counted = (commitsAfter: number, changedAfter: string[], watchedAfter: string[]) => ({
  onHead: false,
  commitsAfter,
  changedAfter,
  watchedAfter,
});
/** Eight approvals covering every state: stale watched and quiet, head, rewritten and the rest. */
const APPROVALS = [
  {
    author: 'dana',
    sha: sha('a'),
    ...counted(3, ['back/', 'docs/', 'front/'], ['back/', 'front/']),
  },
  { author: 'erin', sha: sha('b'), ...counted(2, ['docs/'], []) },
  { author: 'fay', sha: sha('c'), ...counted(0, [], []), onHead: true },
  { author: 'gus', sha: sha('d'), onHead: false, notCounted: 'history_rewritten' },
  { author: 'hal', sha: sha('e'), onHead: false, notCounted: 'pr_too_large' },
  { author: 'ivy', sha: sha('f'), onHead: false, notCounted: 'rate_limit' },
  { author: 'jo', sha: sha('1'), onHead: false },
  { author: 'kai', sha: sha('2'), ...counted(0, [], []) },
];
const pr = (ref: string, extra: Record<string, unknown> = {}) => ({
  kind: 'pr',
  ref,
  role: null,
  state: 'open',
  ...extra,
});

const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no task view');
  return found;
};
const titles = () =>
  [...dialog().querySelectorAll('section [id$="-title"]')].map((title) => title.textContent);
const section = () =>
  [...dialog().querySelectorAll('section')].find(
    (candidate) => candidate.querySelector('[id$="-title"]')?.textContent === 'Approvals',
  );
const rows = () => [...(section()?.querySelectorAll('li') ?? [])];
/** The "what" part of a row: its last child. */
const what = (row: Element) => row.lastElementChild;

/** Opens ex/repo#7 with `links` on its `task.get`. */
async function open(links: unknown[], extra: Record<string, unknown> = {}) {
  const d = daemon();
  d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ links, ...extra })));
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  mount(d);
  await settle();
}

describe('approvals in Task Now', () => {
  it('lists each approval with its commit and what changed since, tinting those to look at', async () => {
    await open(
      [pr('ex/repo#7', { approvals: APPROVALS }), { kind: 'session', ref: 's1', role: 'worker' }],
      {
        submission: null,
      },
    );
    const header = section()?.querySelector('[id$="-title"]');
    expect(header?.nextElementSibling?.textContent).toBe('8');
    expect(rows()).toHaveLength(8);
    expect(rows().map((row) => row.querySelector('b')?.textContent)).toEqual(
      APPROVALS.map(({ author }) => author),
    );
    expect(rows().map((row) => row.querySelector('code')?.textContent)).toEqual(
      APPROVALS.map((approval) => approval.sha.slice(0, 7)),
    );
    expect(rows().map((row) => row.querySelector('code')?.getAttribute('title'))).toEqual(
      APPROVALS.map((approval) => approval.sha),
    );
    expect(rows().map((row) => what(row)?.textContent)).toEqual([
      '3 commits since · changed: watched back/front/ · not watched docs/',
      '2 commits since · changed: not watched docs/',
      'on the head',
      'not counted history rewritten after the approval',
      'not counted the PR is too large to compare',
      'not counted GitHub rate limit',
      'not read yet',
      '0 commits since',
    ]);
    expect(
      rows().map((row) =>
        [...(what(row)?.querySelectorAll('span') ?? [])].map((chip) =>
          chip.title === '' ? [chip.className] : [chip.className, chip.title],
        ),
      ),
    ).toEqual([
      [WATCHED, WATCHED, NOT_WATCHED_LOUD],
      [NOT_WATCHED],
      [],
      [[chipClass('warn')]],
      [[chipClass('ghost')]],
      [[chipClass('ghost')]],
      [],
      [],
    ]);
    expect(rows().map((row) => row.hasAttribute('data-loud'))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    // Loud rows read at full brightness at rest; the others brighten on hover.
    expect(rows().map((row) => row.classList.contains(quiet))).toEqual(
      rows().map((row) => !row.hasAttribute('data-loud')),
    );
    expect(section()?.querySelector('[class*="ref"]')).toBeNull();
    expect(titles().indexOf('Approvals')).toBe(titles().indexOf('Why it is here') + 1);
    expect(titles().indexOf('Latest submission')).toBe(titles().indexOf('Approvals') + 1);
  });

  it('is absent when no pull request carries approvals', async () => {
    await open(taskGet().links);
    expect(section()).toBeUndefined();
    expect(titles()).toContain('Why it is here');
  });

  it('is absent for a merged pull request carrying approvals', async () => {
    await open([pr('ex/repo#7', { state: 'merged', approvals: APPROVALS })]);
    expect(section()).toBeUndefined();
  });

  it('starts each row with its PR ref when two pull requests carry approvals', async () => {
    const [first, second] = APPROVALS;
    await open([
      pr('ex/repo#7', { approvals: [first] }),
      pr('ex/repo#9', { state: 'merged', approvals: [second] }),
      pr('ex/other#3', { approvals: [second] }),
    ]);
    expect(rows().map((row) => row.firstElementChild?.firstElementChild?.textContent)).toEqual([
      'ex/repo#7',
      'ex/other#3',
    ]);
    expect(rows().map((row) => row.querySelector('b')?.textContent)).toEqual(['dana', 'erin']);
    expect(section()?.querySelectorAll('[class*="ref"]')).toHaveLength(2);
  });
});
