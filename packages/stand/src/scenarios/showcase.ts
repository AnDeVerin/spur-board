// The demo Board (`docs/contributing/demo.md`): an invented team's work in all ten columns of the
// `stand` project with the dispatcher on, each column in the state a demo walks through. The role
// sessions stay `working` throughout, so the board holds every ring and nothing moves while the
// stand clock runs. Seed with `pnpm stand seed showcase`, not `reset`: restored rows keep the old
// times. The seed runs in batched phases (all issues, then all links, all PRs, ...) to stay inside
// the detached `up` wait.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { REPO, STEP_MS, submit, take } from './dispatcher.ts';
import { issueKey, settledUnless, turnOn } from './helpers.ts';
import type { Board, Scenario } from './index.ts';

type Column =
  | 'todo'
  | 'triage'
  | 'ready-for-dev'
  | 'dev'
  | 'review'
  | 'product-review'
  | 'external-review'
  | 'qa'
  | 'ready-to-merge'
  | 'done';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PROJECT = 'stand-org/1';
/** The invented external reviewers; the operator's own login is `stand-agent`. */
const REVIEWERS = ['quill-mara', 'quill-teodor'] as const;

interface Planned {
  name: string;
  number: number;
  title: string;
  column: Column;
  /** How long before the seed the task entered its column. */
  enteredAgo: number;
  /** How long before the seed its first journal event happened; at least `enteredAgo`. */
  since: number;
}

/** The invented issue titles by number. */
const TITLES: Readonly<Record<number, string>> = {
  412: 'Let workspace admins rename a workspace',
  418: 'Show dates in the locale of the signed-in user',
  423: 'Export the invoice list as CSV',
  431: 'Mobile app closes when a photo upload is cancelled',
  433: 'Search takes over five seconds on large teams',
  405: 'Crop and resize uploaded profile pictures',
  408: 'Save the filters of the task list per user',
  395: 'Send a weekly summary email to project owners',
  388: 'Keep unsaved form drafts when the session expires',
  391: 'Add keyboard shortcuts to the calendar view',
  386: 'Redesign the empty state of the projects page',
  379: 'Support single sign-on with an OpenID provider',
  383: 'Retry failed webhook deliveries with backoff',
  374: 'Move file attachments to the new storage bucket',
  368: 'Paginate the activity feed',
  352: 'Dark mode for the settings pages',
  347: 'Shorten the onboarding checklist to three steps',
  339: 'Show the next billing date on the plan page',
  330: 'Record role changes in the audit log',
};

/** `[name, number, column, enteredAgo, since]` of every task. */
const PLAN: readonly [string, number, Column, number, number][] = [
  ['todo-rename', 412, 'todo', 6 * DAY, 6 * DAY],
  ['todo-locale', 418, 'todo', 2 * DAY + 4 * HOUR, 2 * DAY + 4 * HOUR],
  ['todo-export', 423, 'todo', 20 * HOUR, 20 * HOUR],
  ['triage-crash', 431, 'triage', 50 * MINUTE, 5 * HOUR],
  ['triage-slow', 433, 'triage', 3 * HOUR, 9 * HOUR],
  ['ready-avatars', 405, 'ready-for-dev', 5 * HOUR, 2 * DAY],
  ['ready-filters', 408, 'ready-for-dev', DAY, 3 * DAY],
  ['dev-live', 395, 'dev', 25 * MINUTE, 4 * HOUR],
  ['returned', 388, 'dev', 40 * MINUTE, 9 * HOUR],
  ['review-taken', 391, 'review', HOUR, 6 * HOUR],
  ['product-review-open', 386, 'product-review', 2 * HOUR, 8 * HOUR],
  ['external-waiting', 379, 'external-review', 4 * HOUR, DAY + 2 * HOUR],
  ['qa', 383, 'qa', 35 * MINUTE, 7 * HOUR],
  ['ready-stale', 374, 'ready-to-merge', 3 * HOUR, DAY + 6 * HOUR],
  ['done-flow', 368, 'done', 2 * HOUR, 11 * HOUR],
  ['done-dark-mode', 352, 'done', 9 * HOUR, DAY],
  ['done-onboarding', 347, 'done', DAY + 5 * HOUR, 2 * DAY],
  ['done-billing', 339, 'done', 3 * DAY, 4 * DAY],
  ['done-audit', 330, 'done', 5 * DAY, 6 * DAY],
];

/** Every task of the demo; the test pins these counts per column. */
export const SHOWCASE_TASKS: readonly Planned[] = PLAN.map(
  ([name, number, column, enteredAgo, since]) => {
    const title = TITLES[number];
    if (title === undefined) throw new Error(`showcase: no title for issue ${String(number)}`);
    return { name, number, title, column, enteredAgo, since };
  },
);

const numberOf = (name: string): number => {
  const planned = SHOWCASE_TASKS.find((task) => task.name === name);
  if (planned === undefined) throw new Error(`no showcase task ${name}`);
  return planned.number;
};
const numbersIn = (column: Column): number[] =>
  SHOWCASE_TASKS.filter((task) => task.column === column).map(({ number }) => number);

const DEV_LIVE = numberOf('dev-live');
const RETURNED = numberOf('returned');
const REVIEW_TAKEN = numberOf('review-taken');
const PRODUCT_REVIEW_OPEN = numberOf('product-review-open');
const EXTERNAL_WAITING = numberOf('external-waiting');
const QA = numberOf('qa');
const READY_STALE = numberOf('ready-stale');
const DONE_FLOW = numberOf('done-flow');
/** Linked to the worker role session; each passes Dev on a PR of its own. */
const FLOW = [
  DEV_LIVE,
  RETURNED,
  REVIEW_TAKEN,
  PRODUCT_REVIEW_OPEN,
  EXTERNAL_WAITING,
  QA,
  READY_STALE,
  DONE_FLOW,
];
/** Done by a merged PR and a closed issue alone, with no session. */
const DONE_PLAIN = numbersIn('done').filter((number) => number !== DONE_FLOW);
const FINDINGS = 3;

/** The head of PR #n: its number padded to 40 hex digits. */
const head = (number: number): string => String(number).padStart(40, 'c');
const oid = (name: string) => createHash('sha1').update(`showcase-${name}`).digest('hex');
/** The approved commit of `ready-stale`, three commits before its head. */
const APPROVED = oid('approved');
const STALE_COMMITS = [
  { oid: APPROVED, parents: [oid('base')], changed: [] },
  { oid: oid('c1'), parents: [APPROVED], changed: ['back/'] },
  { oid: oid('c2'), parents: [oid('c1')], changed: ['docs/'] },
  { oid: head(READY_STALE), parents: [oid('c2')], changed: ['front/'] },
];
const STALE_APPROVAL = {
  author: REVIEWERS[0],
  sha: APPROVED,
  onHead: false,
  commitsAfter: 3,
  changedAfter: ['back/', 'docs/', 'front/'],
  watchedAfter: ['back/', 'front/'],
};

const SHOWCASE_REMAP_NOTE =
  'journal times spread before the seed: no operation sets when a task entered its column (#894); block_unblocked events keep their time';

const ENTRY_KINDS = new Set(['task_moved', 'task_manually_moved', 'task_mirror_moved']);

/**
 * The index of the event the status read takes as the entry into `column`: the latest move to it,
 * or the task's first `task_added` while its `at` is the task's `created_at`
 * (`readStatusColumnEntries` in `packages/core/src/app/status-views.ts`).
 */
function entryIndex(
  events: readonly { kind: string; payload: string; at: string }[],
  column: string,
  createdAt: string,
): number {
  const firstAdded = events.findIndex(({ kind }) => kind === 'task_added');
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { kind, payload, at } = events[i] ?? { kind: '', payload: '{}', at: '' };
    const parsed = JSON.parse(payload) as { to?: unknown; column?: unknown; shadow?: unknown };
    if (kind === 'task_added' && i === firstAdded && at === createdAt && parsed.column === column)
      return i;
    if (parsed.to !== column) continue;
    if (kind === 'task_mirror_moved' && parsed.shadow != null) continue;
    if (ENTRY_KINDS.has(kind) || (kind === 'task_corrected' && parsed.shadow === false)) return i;
  }
  return -1;
}

/**
 * Spreads each task's journal over its plan: the events before the column entry from `since` to
 * `enteredAgo` before `now`, the entry at `enteredAgo`, and the later ones up to a fifth of
 * `enteredAgo` before `now`, all in id order. `created_at` moves with the first `task_added`.
 * `block_unblocked` keeps its time: the answered-via read joins it on `block.unblocked_at`.
 */
async function remapJournal(board: Board, now: number): Promise<void> {
  await board.direct(SHOWCASE_REMAP_NOTE, async (db) => {
    for (const { number, enteredAgo, since } of SHOWCASE_TASKS) {
      const task = await db
        .selectFrom('task')
        .select(['id', 'column', 'created_at'])
        .where('project', '=', 'stand')
        .where('key', '=', issueKey(number))
        .executeTakeFirstOrThrow();
      const events = await db
        .selectFrom('event')
        .select(['id', 'kind', 'payload', 'at'])
        .where('task_id', '=', task.id)
        .where('kind', '!=', 'block_unblocked')
        .orderBy('id')
        .execute();
      const entry = entryIndex(events, task.column, task.created_at);
      if (entry < 0) throw new Error(`no entry event of ${issueKey(number)} into ${task.column}`);
      const entryAt = now - enteredAgo;
      const start = now - since;
      const after = events.length - entry - 1;
      const times = events.map((_, i) =>
        i < entry
          ? start + ((entryAt - start) * i) / entry
          : i === entry
            ? entryAt
            : entryAt + ((enteredAgo * 0.8) / after) * (i - entry),
      );
      const firstAdded = events.findIndex(
        ({ kind, at }) => kind === 'task_added' && at === task.created_at,
      );
      for (const [i, event] of events.entries())
        await db
          .updateTable('event')
          .set({ at: new Date(Math.round(times[i] ?? now)).toISOString() })
          .where('id', '=', event.id)
          .executeTakeFirstOrThrow();
      if (firstAdded >= 0)
        await db
          .updateTable('task')
          .set({ created_at: new Date(Math.round(times[firstAdded] ?? now)).toISOString() })
          .where('id', '=', task.id)
          .executeTakeFirstOrThrow();
    }
  });
}

/** The key of the operator turn item on issue `number` with `reason`. */
async function operatorTurnItem(board: Board, number: number, reason: string): Promise<string> {
  const suffix = ` on ${issueKey(number)}: ${reason}`;
  let key: string | undefined;
  await board.until(`operator turn ${reason} on ${issueKey(number)}`, STEP_MS, async () => {
    const { items } = await board.call('operator', 'status.get', { project: 'stand' });
    key = items.find((item) => /^turn:\d+$/.test(item.key) && item.summary.endsWith(suffix))?.key;
    return key !== undefined;
  });
  if (key === undefined) throw new Error(`no operator turn ${reason} on ${issueKey(number)}`);
  return key;
}

/** The approvals of `ready-stale`'s PR that `status.get` lists. */
async function staleApprovals(board: Board): Promise<unknown> {
  const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
  return tasks.find(({ key }) => key === issueKey(READY_STALE))?.prSummary?.[0]?.approvals;
}

const key = (name: string): string => issueKey(numberOf(name));
const ask = (board: Board, number: number, text: string) =>
  board.call('worker', 'block.ask', { task: issueKey(number), text }, randomUUID());

export const showcase: Scenario = {
  name: 'showcase',
  summary: `The demo Board: ${String(SHOWCASE_TASKS.length)} invented tasks in all ten columns with the dispatcher on: a live Dev task with a question to the operator, a QA return with findings, conductor turns in Review and Product Review, External Review waiting, a QA turn, a stale approval in Ready to Merge, Done, and a red default branch.`,
  config: {
    stand: {
      // No quietAfterMs anywhere: the backdated journal would raise external-quiet: at once.
      columns: [
        { id: 'todo' },
        { id: 'triage' },
        {
          id: 'ready-for-dev',
          source: { type: 'tracker', project: PROJECT, field: 'Status', value: 'Ready' },
        },
        { id: 'dev' },
        { id: 'review', orchestrator: 'stand-qa' },
        { id: 'product-review', orchestrator: 'stand-qa' },
        { id: 'external-review' },
        { id: 'qa', orchestrator: 'stand-qa' },
        { id: 'ready-to-merge', orchestrator: 'operator' },
        { id: 'done' },
      ],
      dispatcher: { mode: 'on' },
      approvalWatch: ['back/', 'front/'],
    },
  },
  async seed(board, fakes, clock) {
    const at = new Date(clock.now()).toISOString();
    for (const { number, title } of SHOWCASE_TASKS)
      await fakes.github('issue-open', { repo: REPO, number, title });
    for (const number of numbersIn('ready-for-dev'))
      await fakes.github('issue-project-status', { repo: REPO, number, status: 'Ready' });
    // The tracker and the mirror poll side by side: the second poll reads the Project after the
    // first one created the tasks.
    await board.poll();
    await board.poll();
    for (const number of numbersIn('triage'))
      await board.call(
        'operator',
        'task.move',
        {
          mode: 'manual',
          task: issueKey(number),
          column: 'triage',
          reason: 'Reported by support; needs a repro first.',
        },
        randomUUID(),
      );

    for (const number of FLOW)
      await board.call('operator', 'link.add', {
        mode: 'session',
        task: issueKey(number),
        session: board.roles.worker,
        reason: 'Demo worker session',
      });
    await board.poll();
    const dev = new Map<number, string>();
    for (const number of FLOW) {
      const turn = await turnOn(board, 'worker', number, 'dev: no_pr', STEP_MS);
      await take(board, 'worker', turn);
      dev.set(number, turn);
    }

    for (const number of DONE_PLAIN) await fakes.github('create', { repo: REPO, number });
    for (const number of FLOW) {
      const stale = number === READY_STALE;
      await fakes.github('create', {
        repo: REPO,
        number,
        seed: {
          headRefOid: head(number),
          ...(stale
            ? {
                commits: STALE_COMMITS,
                reviews: [
                  {
                    author: { __typename: 'User', login: REVIEWERS[0] },
                    state: 'APPROVED',
                    commit: { oid: APPROVED },
                    submittedAt: at,
                  },
                ],
              }
            : {}),
        },
      });
    }
    // Read pending first, so History lists the checks turning green; dev-live keeps them pending.
    await board.poll();
    for (const number of FLOW)
      if (number !== DEV_LIVE) await fakes.github('ci-green', { repo: REPO, number });
    for (const number of DONE_PLAIN) {
      await fakes.github('merge', { repo: REPO, number });
      await fakes.github('issue-close', { repo: REPO, number });
    }
    // Fake verbs can move updatedAt a millisecond ahead when a fixed clock is injected.
    await board.shiftClock(10);
    await board.poll();

    const { block: question } = await ask(
      board,
      DEV_LIVE,
      'Should the summary skip projects with no activity that week?',
    );
    await board.call('operator', 'comment.add', {
      task: issueKey(DEV_LIVE),
      block: question.id,
      text: 'Checking with the account team; most owners asked for a short email.',
    });
    await board.call(
      'worker',
      'comment.add',
      {
        task: issueKey(DEV_LIVE),
        block: question.id,
        text: 'Until then the draft skips them and lists the count at the bottom.',
      },
      randomUUID(),
    );
    const { block: answered } = await ask(
      board,
      READY_STALE,
      'Copy the old attachments in the background or during the next deploy?',
    );
    await board.call(
      'operator',
      'block.answer',
      { block: answered.id, text: 'In the background, in batches of 500.' },
      randomUUID(),
    );
    await board.call(
      'operator',
      'block.followup',
      { block: answered.id, text: 'Keep the old bucket read-only for a week after the copy.' },
      randomUUID(),
    );
    for (const number of FLOW)
      if (number !== DEV_LIVE) await submit(board, 'worker', dev.get(number) ?? '', head(number));

    for (const number of FLOW.slice(1)) {
      const turn = await turnOn(
        board,
        'orchestrator',
        number,
        'review: no_review_on_head',
        STEP_MS,
      );
      await take(board, 'orchestrator', turn);
      if (number !== REVIEW_TAKEN) await submit(board, 'orchestrator', turn, head(number));
    }
    for (const number of FLOW.slice(1).filter((n) => n !== REVIEW_TAKEN)) {
      const turn = await turnOn(
        board,
        'orchestrator',
        number,
        'product-review: no_review_on_head',
        STEP_MS,
      );
      if (number === PRODUCT_REVIEW_OPEN) continue;
      await take(board, 'orchestrator', turn);
      await submit(board, 'orchestrator', turn, head(number));
    }
    for (const [i, number] of [QA, DONE_FLOW, RETURNED].entries())
      await fakes.github('review', {
        repo: REPO,
        number,
        state: 'APPROVED',
        author: REVIEWERS[i % REVIEWERS.length],
      });
    await board.poll();
    let code = '';
    for (const number of [QA, READY_STALE, DONE_FLOW, RETURNED]) {
      const turn = await turnOn(board, 'orchestrator', number, 'qa: no_submit_on_head', STEP_MS);
      if (number === QA) continue;
      await take(board, 'orchestrator', turn);
      if (number === RETURNED) {
        const { block } = await board.call(
          'orchestrator',
          'task.return',
          {
            turn,
            reason: 'The draft is lost after a forced sign-out; see the three QA notes.',
            findings: FINDINGS,
          },
          randomUUID(),
        );
        code = block.id;
      } else await submit(board, 'orchestrator', turn, head(number));
    }
    await turnOn(board, 'worker', RETURNED, 'dev: no_submit_on_head', STEP_MS);
    await board.call('operator', 'comment.add', {
      task: issueKey(RETURNED),
      text: 'Support saw this twice this week; please keep the fix small.',
    });

    const turn = await operatorTurnItem(board, READY_STALE, 'ready-to-merge: not_merged');
    await operatorTurnItem(board, DONE_FLOW, 'ready-to-merge: not_merged');
    await fakes.github('merge', { repo: REPO, number: DONE_FLOW });
    await fakes.github('issue-close', { repo: REPO, number: DONE_FLOW });
    await board.shiftClock(10);
    // PR commits are read only once core asks for them: poll until the facts arrive.
    let polls = 0;
    await board.until('stale approval and done-flow merged', STEP_MS * 2, async () => {
      await board.poll();
      polls++;
      const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
      return (
        polls >= 2 &&
        tasks.find((task) => task.key === issueKey(DONE_FLOW))?.column === 'done' &&
        isDeepStrictEqual(await staleApprovals(board), [STALE_APPROVAL])
      );
    });

    await fakes.github('branch', { repo: REPO, state: 'red' });
    await board.poll();
    await remapJournal(board, clock.now());
    return {
      tasks: Object.fromEntries(SHOWCASE_TASKS.map(({ name, number }) => [name, issueKey(number)])),
      prs: Object.fromEntries(
        SHOWCASE_TASKS.filter(({ column }) =>
          ['todo', 'triage', 'ready-for-dev'].every((free) => free !== column),
        ).map(({ name, number }) => [name, `${REPO}#${String(number)}`]),
      ),
      blocks: { question: question.id, answered: answered.id, code },
      items: { red: `default-branch:github:stand:${REPO}`, turn },
      sessions: { worker: board.roles.worker, conductor: board.roles.orchestrator },
    };
  },
  async settled({ board, entities }) {
    const { tasks, items } = await board.call('operator', 'status.get', {
      project: 'stand',
      detail: true,
    });
    const problems: string[] = [];
    const row = (name: string) => tasks.find((task) => task.key === key(name));
    for (const { name, column } of SHOWCASE_TASKS) {
      const at = row(name)?.column;
      if (at !== column) problems.push(`${key(name)} in ${at ?? 'nothing'}, not ${column}`);
    }
    const devLive = row('dev-live');
    if (devLive?.turn?.addressee !== 'worker' || devLive.turn.taken === null)
      problems.push('dev-live has no taken worker turn');
    if (!(devLive?.blocks ?? []).some((block) => block.addressee === 'operator'))
      problems.push('dev-live has no block to the operator');
    const returned = row('returned');
    if (returned?.returned?.from !== 'qa' || returned.returned.findings !== FINDINGS)
      problems.push(`returned ${JSON.stringify(returned?.returned)}, not from qa with findings`);
    if (returned?.turn?.addressee !== 'worker' || returned.turn.taken !== null)
      problems.push('returned has no untaken worker turn');
    const review = row('review-taken')?.turn;
    if (review?.addressee !== 'orchestrator:review' || review.taken === null)
      problems.push('review-taken has no taken conductor turn');
    const product = row('product-review-open')?.turn;
    if (product?.column !== 'product-review' || product.taken !== null)
      problems.push('product-review-open has no untaken Product Review turn');
    if (row('external-waiting')?.turn != null) problems.push('external-waiting has a turn');
    const qa = row('qa')?.turn;
    if (qa?.column !== 'qa' || qa.taken !== null) problems.push('qa has no untaken QA turn');
    if (row('ready-stale')?.turn?.column !== 'ready-to-merge')
      problems.push('ready-stale has no Ready to Merge turn');
    const approvals = await staleApprovals(board);
    if (!isDeepStrictEqual(approvals, [STALE_APPROVAL]))
      problems.push(`ready-stale approvals ${JSON.stringify(approvals)}`);
    const red = entities.items?.['red'] ?? '';
    if (!items.some((item) => item.key === red)) problems.push(`no item ${red}`);
    return settledUnless(problems);
  },
};
