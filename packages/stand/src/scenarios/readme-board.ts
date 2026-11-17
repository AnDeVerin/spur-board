// The Board in the README screenshots (`docs/images/board-dark.png` and `board-light.png`): real
// closed spur-board issues, verbatim titles, spread over To Do, Dev, Review, Ready to Merge and
// Done with the dispatcher on. Recipe: seed `readme-board`, open the stand webUrl in gstack browse
// at a 1680x440 viewport, set localStorage `board-theme` to dark then light, `screenshot
// --viewport` each, and shrink each to a 256-colour palette with ffmpeg (`palettegen`,
// `paletteuse=dither=none`, `-pred mixed`).
import { randomUUID } from 'node:crypto';
import { flow, REPO, STEP_MS, submit, take } from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Board, Scenario, ScenarioFakes } from './index.ts';

type Column = 'todo' | 'dev' | 'review' | 'ready-to-merge' | 'done';

const TASKS: readonly { number: number; title: string; column: Column }[] = [
  {
    number: 627,
    title: 'docs(web): split web-ui.md by screen before it hits its size cap',
    column: 'todo',
  },
  {
    number: 631,
    title: 'docs(agents): role guides name every doc the skill sync keeps (web-ui* too)',
    column: 'todo',
  },
  {
    number: 621,
    title: 'feat(core,web): inbox items carry a url; task-less web rows open it',
    column: 'dev',
  },
  {
    number: 620,
    title: 'feat(core): a red default branch is an operator inbox item',
    column: 'review',
  },
  {
    number: 611,
    title: 'feat(web): count tasks in unconfigured columns instead of hiding them',
    column: 'ready-to-merge',
  },
  {
    number: 558,
    title: 'feat(web): board screen with header, columns and stale states',
    column: 'done',
  },
  {
    number: 559,
    title: 'feat(web): task card with PR status, turn line and markers',
    column: 'done',
  },
  {
    number: 560,
    title: 'feat(web): task view with the "Why it is here" section',
    column: 'done',
  },
  {
    number: 561,
    title: 'feat(web): task view blocks and comments with the two write actions',
    column: 'done',
  },
  { number: 562, title: 'feat(web): task view history tab', column: 'done' },
  { number: 563, title: 'feat(web): operator inbox panel across projects', column: 'done' },
  { number: 564, title: 'feat(web): status bar and services panel', column: 'done' },
];

const numbersIn = (column: Column): number[] =>
  TASKS.filter((task) => task.column === column).map(({ number }) => number);
const DEV = numbersIn('dev')[0] ?? 0;
const REVIEW = numbersIn('review')[0] ?? 0;
const READY = numbersIn('ready-to-merge')[0] ?? 0;
const sha = (number: number): string => String(number).padStart(40, 'a');

/** Waits for the role's open turn on issue `number` whose reason is `reason`; its id. */
async function turnOn(
  board: Board,
  role: 'worker' | 'orchestrator',
  number: number,
  reason: string,
): Promise<string> {
  const task = issueKey(number);
  let id: string | undefined;
  await board.until(`${role} turn ${reason} on ${task}`, STEP_MS, async () => {
    const { turns } = await board.call(role, 'inbox.get', {});
    id = turns.find((turn) => turn.task === task && turn.reason === reason)?.id;
    return id !== undefined;
  });
  if (id === undefined) throw new Error(`no ${role} turn ${reason} on ${task}`);
  return id;
}

/** Links the worker role session to issue `number`, then takes its Dev turn; the turn id. */
async function takeDev(board: Board, number: number): Promise<string> {
  await board.call('operator', 'link.add', {
    mode: 'session',
    task: issueKey(number),
    session: board.roles.worker,
    reason: 'Stand README board',
  });
  await board.poll();
  const turn = await turnOn(board, 'worker', number, 'dev: no_pr');
  await take(board, 'worker', turn);
  return turn;
}

/** PR `number` at its own head, linked by its branch `stand-<number>`; green unless told not. */
async function openPr(fakes: ScenarioFakes, board: Board, number: number, green: boolean) {
  await fakes.github('create', { repo: REPO, number, seed: { headRefOid: sha(number) } });
  if (green) await fakes.github('ci-green', { repo: REPO, number });
  await board.poll();
}

/** Dev with a green PR, submitted by the worker: Review with the conductor's turn; its id. */
async function toReview(board: Board, fakes: ScenarioFakes, number: number): Promise<string> {
  const dev = await takeDev(board, number);
  await openPr(fakes, board, number, true);
  await submit(board, 'worker', dev, sha(number));
  return turnOn(board, 'orchestrator', number, 'review: no_review_on_head');
}

const taskNames = (): Record<string, string> =>
  Object.fromEntries(
    TASKS.map(({ number, column }) => [`${column}-${String(number)}`, issueKey(number)]),
  );

export const readmeBoard: Scenario = {
  name: 'readme-board',
  summary: `The README Board: ${String(TASKS.length)} closed spur-board issues in To Do, Dev (a taken turn, CI pending, a question to the operator), Review (the conductor's turn), Ready to Merge (the operator's turn) and Done.`,
  config: flow(),
  async seed(board, fakes) {
    for (const { number, title } of TASKS)
      await fakes.github('issue-open', { repo: REPO, number, title });
    await board.poll();
    // Done in the pr-finality order: PRs linked by branch while open, then merged and closed.
    const done = numbersIn('done');
    for (const number of done) await fakes.github('create', { repo: REPO, number });
    await board.poll();
    for (const number of done) {
      await fakes.github('merge', { repo: REPO, number });
      await fakes.github('issue-close', { repo: REPO, number });
    }
    // Fake verbs can move updatedAt a millisecond ahead when a fixed clock is injected.
    await board.shiftClock(10);
    await board.poll();
    const review = await toReview(board, fakes, READY);
    await take(board, 'orchestrator', review);
    await submit(board, 'orchestrator', review, sha(READY));
    await take(board, 'orchestrator', await toReview(board, fakes, REVIEW));
    await takeDev(board, DEV);
    await openPr(fakes, board, DEV, false);
    const { block } = await board.call(
      'worker',
      'block.ask',
      { task: issueKey(DEV), text: 'Should a task-less row open its url in a new tab?' },
      randomUUID(),
    );
    return {
      tasks: taskNames(),
      prs: Object.fromEntries(
        TASKS.filter(({ column }) => column !== 'todo').map(({ number }) => [
          String(number),
          `${REPO}#${String(number)}`,
        ]),
      ),
      blocks: { question: block.id },
      sessions: { worker: board.roles.worker, conductor: board.roles.orchestrator },
    };
  },
  async settled({ board }) {
    const { tasks } = await board.call('operator', 'status.get', {
      project: 'stand',
      detail: true,
    });
    const problems: string[] = [];
    for (const { number, column } of TASKS) {
      const key = issueKey(number);
      const row = tasks.find((task) => task.key === key);
      if (row === undefined) {
        problems.push(`no row ${key}`);
        continue;
      }
      if (row.column !== column) problems.push(`${key} in ${row.column}, not ${column}`);
      const turn = row.turn;
      if (column === 'todo' && turn !== null) problems.push(`${key} has a turn`);
      if (column === 'dev') {
        if (turn?.addressee !== 'worker' || turn.taken === null)
          problems.push(`${key} has no taken worker turn`);
        if (!row.blocks.some((item) => item.addressee === 'operator'))
          problems.push(`${key} has no block to the operator`);
      }
      if (column === 'review' && turn?.addressee !== 'orchestrator:review')
        problems.push(`${key} turn to ${turn?.addressee ?? 'nobody'}, not the conductor`);
      if (column === 'ready-to-merge' && turn?.column !== 'ready-to-merge')
        problems.push(`${key} has no Ready to Merge turn`);
    }
    return settledUnless(problems);
  },
};
