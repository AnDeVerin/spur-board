// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardUpdate } from '../src/board/update.ts';
import { block, daemon, deferred, envelope, taskGet } from './board-fixtures.ts';
import { mount, mounted, mountEachTest, settle } from './board-harness.ts';
import {
  button,
  field,
  memorySession,
  submit,
  typeText,
  updateAlert,
  versioned,
} from './board-update-fixtures.ts';

mountEachTest();

const PAGE = '1.0.0';
const NEXT = '2.0.0';
/** How long a deferred reload waits for a send, `DEFER_LIMIT_MS` in `src/board/update.ts`. */
const WAIT_LIMIT = 15_000;
const ANSWER = JSON.stringify(['answer', 'ex/repo#7', 'B12']);
const COMMENT = JSON.stringify(['comment', 'ex/repo#7', null]);

/**
 * Every way the page leaves for a new version. `auto` and `settle` reload by themselves; the
 * others are a user's Reload or Retry now. `sends`: an answer send is in flight before the update.
 */
const PATHS = {
  // No send: the mismatch itself fires.
  auto: { auto: true, sends: false, before: undefined },
  // The answer send defers the reload, then settles.
  settle: { auto: true, sends: true, before: { mode: 'deferred', keepsDrafts: true } },
  // The answer send never settles; after the wait the user presses Reload.
  timeout: { auto: false, sends: true, before: { mode: 'blocked', keepsDrafts: true } },
  // The page already reloaded once for NEXT; the user presses Reload.
  'loop guard': { auto: false, sends: false, before: { mode: 'blocked', keepsDrafts: true } },
  // The answer send defers the reload; the user presses Retry now.
  retry: { auto: false, sends: true, before: { mode: 'deferred', keepsDrafts: true } },
} as const;

type Path = keyof typeof PATHS;
/**
 * `quota`: `setItem('board-drafts')` throws. `getter`: the session getter throws from the leave
 * on; a getter that throws from page load is covered in board-update.test.ts.
 */
type Outcome = 'ok' | 'quota' | 'getter';
type Mode = Pick<BoardUpdate, 'mode' | 'keepsDrafts'>;

interface Row {
  path: Path;
  storage: Outcome;
  /** An unsent comment is typed; a send in flight is unsent text as well. */
  text: boolean;
  /** Reloads right after the leave. 0: a Reload click after the warning then reloads once. */
  reloads: 0 | 1;
  after: Mode;
  /** `board-drafts` after the leave: the fields kept, none when nothing was written. */
  drafts: ('answer' | 'comment')[];
}

const reloading: Mode = { mode: 'reloading', keepsDrafts: true };
const kept: Mode = { mode: 'blocked', keepsDrafts: true };
const lost: Mode = { mode: 'blocked', keepsDrafts: false };
const deferredMode: Mode = { mode: 'deferred', keepsDrafts: true };

const rows: Row[] = [
  { path: 'auto', storage: 'ok', text: true, reloads: 1, after: reloading, drafts: ['comment'] },
  { path: 'auto', storage: 'ok', text: false, reloads: 1, after: reloading, drafts: [] },
  { path: 'auto', storage: 'quota', text: true, reloads: 0, after: lost, drafts: [] },
  // Nothing to keep: `board-drafts` is never written, so the quota never bites.
  { path: 'auto', storage: 'quota', text: false, reloads: 1, after: reloading, drafts: [] },
  { path: 'auto', storage: 'getter', text: true, reloads: 0, after: lost, drafts: [] },
  // The automatic reload never goes without the marker, text or not.
  { path: 'auto', storage: 'getter', text: false, reloads: 0, after: lost, drafts: [] },
  { path: 'settle', storage: 'ok', text: true, reloads: 1, after: reloading, drafts: ['comment'] },
  { path: 'settle', storage: 'ok', text: false, reloads: 1, after: reloading, drafts: [] },
  { path: 'settle', storage: 'quota', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'settle', storage: 'quota', text: false, reloads: 1, after: reloading, drafts: [] },
  { path: 'settle', storage: 'getter', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'settle', storage: 'getter', text: false, reloads: 0, after: lost, drafts: [] },
  // timeout and retry have no row without text: the send in flight is unsent text.
  {
    path: 'timeout',
    storage: 'ok',
    text: true,
    reloads: 1,
    after: kept,
    drafts: ['answer', 'comment'],
  },
  { path: 'timeout', storage: 'quota', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'timeout', storage: 'getter', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'loop guard', storage: 'ok', text: true, reloads: 1, after: kept, drafts: ['comment'] },
  { path: 'loop guard', storage: 'ok', text: false, reloads: 1, after: kept, drafts: [] },
  { path: 'loop guard', storage: 'quota', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'loop guard', storage: 'quota', text: false, reloads: 1, after: kept, drafts: [] },
  { path: 'loop guard', storage: 'getter', text: true, reloads: 0, after: lost, drafts: [] },
  // The user asked and nothing is lost: it reloads.
  { path: 'loop guard', storage: 'getter', text: false, reloads: 1, after: kept, drafts: [] },
  {
    path: 'retry',
    storage: 'ok',
    text: true,
    reloads: 1,
    after: deferredMode,
    drafts: ['answer', 'comment'],
  },
  { path: 'retry', storage: 'quota', text: true, reloads: 0, after: lost, drafts: [] },
  { path: 'retry', storage: 'getter', text: true, reloads: 0, after: lost, drafts: [] },
];

/** Opens task ex/repo#7 with question B12; `loop guard` serves NEXT with its marker set. */
async function arrange({ path, storage, text }: Row) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const guard = path === 'loop guard';
  let version = guard ? NEXT : PAGE;
  const session = memorySession({
    values: guard ? { 'board-reload-target': NEXT } : {},
    ...(storage === 'quota' ? { setKey: 'board-drafts' } : {}),
  });
  history.replaceState(null, '', '/?open=ex%2Frepo%237');
  const d = daemon();
  d.routes['task.get'] = () => Promise.resolve(envelope(taskGet({ blocks: [block()] })));
  const reload = vi.fn();
  mount({ ...d, fetcher: versioned(d.fetcher, () => version).fetch }, {}, () => 0, {
    version: PAGE,
    session: session.session,
    reload,
  });
  await settle();
  const accepted = d.routes['block.answer'];
  const sent = deferred();
  if (PATHS[path].sends) {
    d.routes['block.answer'] = () => sent.promise;
    typeText(field(0), 'an answer');
    submit(field(0));
    await settle();
  }
  if (text) typeText(field(1), 'a comment');
  /** The daemon restarts on NEXT: the stream drops and reconnects after 0.5 s. */
  const update = async () => {
    version = NEXT;
    d.endStream();
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(500));
    await settle();
  };
  if (PATHS[path].sends) await update();
  if (path === 'timeout') await act(() => vi.advanceTimersByTimeAsync(WAIT_LIMIT));
  const settleSend = async () => {
    sent.resolve(await accepted({}));
    await settle();
  };
  return { session, reload, update, settleSend };
}

describe('leaving for a new version', () => {
  it.each(rows)('$path, storage $storage, text $text: reloads $reloads', async (row) => {
    const { session, reload, update, settleSend } = await arrange(row);
    const before = PATHS[row.path].before;
    expect(mounted().snapshot().update).toEqual(
      before === undefined ? undefined : { version: NEXT, ...before },
    );
    const initial = mounted().snapshot().update;
    // Each new update object is one publish of the version check.
    const published: unknown[] = [];
    const unsubscribe = mounted().subscribe(() => {
      const current = mounted().snapshot().update;
      if (current !== (published.at(-1) ?? initial)) published.push(current);
    });
    if (row.storage === 'getter') session.fails.getter = true;

    if (row.path === 'auto') await update();
    else if (row.path === 'settle') await settleSend();
    else if (row.path === 'retry')
      act(() => {
        mounted().retry();
      });
    else
      act(() => {
        button('Reload').click();
      });

    expect(reload).toHaveBeenCalledTimes(row.reloads);
    expect(mounted().snapshot().update).toEqual({ version: NEXT, ...row.after });
    const changed = mounted().snapshot().update !== initial;
    // The automatic reload publishes its outcome; a user's leave publishes only the warning.
    expect(published).toHaveLength(changed ? 1 : 0);
    expect(changed).toBe(PATHS[row.path].auto || row.reloads === 0);
    const warning = 'Unsent text cannot be kept: copy it before reloading.';
    expect(updateAlert()?.textContent.includes(warning) ?? false).toBe(row.reloads === 0);
    const drafts = session.values.get('board-drafts');
    if (row.drafts.length === 0) expect(drafts).toBeUndefined();
    else
      expect(JSON.parse(drafts ?? '{}')).toEqual(
        Object.fromEntries(
          row.drafts.map((name) =>
            name === 'answer' ? [ANSWER, 'an answer'] : [COMMENT, 'a comment'],
          ),
        ),
      );
    if (row.storage === 'ok') expect(session.values.get('board-reload-target')).toBe(NEXT);

    if (row.reloads === 0) {
      // The warning is shown and the button is live: the next Reload goes, saved or not.
      expect(button('Reload').getAttribute('aria-busy')).not.toBe('true');
      act(() => {
        button('Reload').click();
      });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(button('Reloading').getAttribute('aria-busy')).toBe('true');
      expect(published).toHaveLength(1);
    }
    unsubscribe();
  });
});
