// The demo walkthrough (`docs/contributing/demo-walkthrough.md`): the showcase Board plus one new
// task in Todo, which `pnpm stand demo next` carries to Done one visible change at a time. Every
// step goes through the fakes and the public API and ends once the board shows its new state;
// none restarts the daemon, and the showcase cards never move.
import { createHash, randomUUID } from 'node:crypto';
import { REPO, STEP_MS, submit, take } from './dispatcher.ts';
import { issueKey, settledUnless, turnOn } from './helpers.ts';
import type { Board, DemoContext, DemoStep, Scenario } from './index.ts';
import { REVIEWERS, showcase } from './showcase.ts';

/** The demo task: issue and PR 440, the only issue the showcase does not seed. */
const NUMBER = 440;
const TITLE = 'Let users pin favourite projects to the sidebar';
const TASK = issueKey(NUMBER);
const PR = { repo: REPO, number: NUMBER };
/** The PR's first head, and the head after the changes Review asked for. */
const HEAD_A = createHash('sha1').update('walkthrough-a').digest('hex');
const HEAD_B = createHash('sha1').update('walkthrough-b').digest('hex');
const APPROVER = REVIEWERS[1];
const FINDINGS = 2;
const QUESTION =
  'Should pinned projects follow the user to other devices, or stay in this browser?';

type Status = Awaited<ReturnType<typeof status>>;
type Row = Status['tasks'][number];

const status = (board: Board) => board.call('operator', 'status.get', { project: 'stand' });

/** The demo task's `status.get` row, if the board has it. */
async function row(board: Board): Promise<Row | undefined> {
  return (await status(board)).tasks.find(({ key }) => key === TASK);
}

/**
 * Waits until the demo task's row passes `holds`, which also gets the board's item keys; `poll`
 * polls before each look, so a tick raises or clears the items a change brings.
 */
async function until(
  board: Board,
  label: string,
  holds: (task: Row, items: string[]) => boolean,
  { poll = false }: { poll?: boolean } = {},
): Promise<void> {
  await board.until(`${TASK} ${label}`, STEP_MS, async () => {
    if (poll) await board.poll();
    const { tasks, items } = await status(board);
    const task = tasks.find(({ key }) => key === TASK);
    return (
      task !== undefined &&
      holds(
        task,
        items.map(({ key }) => key),
      )
    );
  });
}

/** The operator item of block `B<n>`. */
const blockItem = (block: string): string => `operator-block:${block.slice(1)}`;

const checks = (task: Row) => task.prSummary?.[0]?.checks;
const green = (task: Row): boolean => {
  const seen = checks(task);
  return seen !== undefined && seen.pass > 0 && seen.pending === 0 && seen.fail === 0;
};
const taken = (task: Row, column: string): boolean =>
  task.column === column && task.turn?.column === column && task.turn.taken !== null;

/** The ID `ids[name]` an earlier step recorded; throws when that step has not run. */
function id(context: Pick<DemoContext, 'ids'>, name: string): string {
  const value = context.ids[name];
  if (value === undefined) throw new Error(`no ${name} recorded: run the steps in order`);
  return value;
}

/** Takes the role's open turn on the demo task with `reason` and records it as `ids[name]`. */
async function takeTurn(
  context: DemoContext,
  role: 'worker' | 'orchestrator',
  reason: string,
  name: string,
): Promise<string> {
  const turn = await turnOn(context.board, role, NUMBER, reason, STEP_MS);
  await take(context.board, role, turn);
  context.ids[name] = turn;
  return turn;
}

const TASK_VIEW = encodeURIComponent(TASK);

const STEPS: readonly DemoStep[] = [
  {
    title: 'Ready for Dev',
    narration:
      'Issue 440 is marked Ready in the GitHub Project, and the Board mirrors it into Ready for Dev.',
    async run({ board, fakes }) {
      await fakes.github('issue-project-status', { ...PR, status: 'Ready' });
      await until(board, 'in ready-for-dev', (task) => task.column === 'ready-for-dev', {
        poll: true,
      });
    },
  },
  {
    title: 'Dev',
    narration:
      'A worker session is linked to the task: it moves to Dev, and the worker takes its turn.',
    async run(context) {
      const { board } = context;
      await board.call('operator', 'link.add', {
        mode: 'session',
        task: TASK,
        session: board.roles.worker,
        reason: 'Demo worker session',
      });
      await board.poll();
      await takeTurn(context, 'worker', 'dev: no_pr', 'dev');
      await until(board, 'with a taken worker turn in dev', (task) => taken(task, 'dev'));
    },
  },
  {
    title: 'A question to the operator',
    narration:
      'The worker is unsure about the scope and asks the operator; the question waits on the card.',
    open: (context) => `block%3A${id(context, 'question')}`,
    async run(context) {
      const { board } = context;
      const { block } = await board.call(
        'worker',
        'block.ask',
        { task: TASK, text: QUESTION },
        randomUUID(),
      );
      context.ids['question'] = block.id;
      await until(
        board,
        'with a question to the operator',
        (task, items) =>
          task.blocks.some((open) => open.id === block.id && open.addressee === 'operator') &&
          items.includes(blockItem(block.id)),
        { poll: true },
      );
    },
  },
  {
    title: 'The answer',
    narration:
      'The operator answers from the Board; the question closes and the worker carries on.',
    open: () => 'inbox',
    async run(context) {
      const { board } = context;
      const question = id(context, 'question');
      // The presenter may have answered in the web UI already.
      const { blocks } = await board.call('operator', 'task.get', { task: TASK });
      if (blocks.find((block) => block.id === question)?.state === 'open')
        await board.call(
          'operator',
          'block.answer',
          { block: question, text: 'Keep them per user on the server, so they follow the user.' },
          randomUUID(),
        );
      await until(
        board,
        'with the question answered',
        (task, items) =>
          task.blocks.every((open) => open.id !== question) && !items.includes(blockItem(question)),
        { poll: true },
      );
    },
  },
  {
    title: 'A pull request',
    narration:
      'The worker opens pull request 440; the Board links it by its branch and shows the checks running.',
    open: () => TASK_VIEW,
    async run({ board, fakes }) {
      await fakes.github('create', { ...PR, seed: { headRefOid: HEAD_A } });
      await until(board, 'with pending checks', (task) => (checks(task)?.pending ?? 0) > 0, {
        poll: true,
      });
    },
  },
  {
    title: 'Review',
    narration:
      'The checks pass and the worker submits the head; the task moves to Review and the conductor takes it.',
    async run(context) {
      const { board, fakes } = context;
      await fakes.github('ci-green', PR);
      await until(board, 'with green checks', green, { poll: true });
      await submit(board, 'worker', id(context, 'dev'), HEAD_A);
      await takeTurn(context, 'orchestrator', 'review: no_review_on_head', 'review');
      await until(board, 'with a taken Review turn', (task) => taken(task, 'review'));
    },
  },
  {
    title: 'Changes requested',
    narration:
      'Review finds two problems and returns the task to Dev, with a code block for the worker.',
    open: () => TASK_VIEW,
    async run(context) {
      const { board } = context;
      const { block } = await board.call(
        'orchestrator',
        'task.return',
        {
          turn: id(context, 'review'),
          reason: 'Pins are lost on sign-out, and the sidebar does not scroll past ten pins.',
          findings: FINDINGS,
        },
        randomUUID(),
      );
      context.ids['code'] = block.id;
      await turnOn(board, 'worker', NUMBER, 'dev: no_submit_on_head', STEP_MS);
      await until(
        board,
        'returned to dev',
        (task) =>
          task.column === 'dev' &&
          task.returned?.from === 'review' &&
          task.blocks.some((open) => open.id === block.id),
      );
    },
  },
  {
    title: 'A new head',
    narration:
      'The worker pushes a fix and submits the new head; the code block closes and Review starts again.',
    async run(context) {
      const { board, fakes } = context;
      const dev = await takeTurn(context, 'worker', 'dev: no_submit_on_head', 'dev');
      await fakes.github('push', { ...PR, sha: HEAD_B });
      await board.poll();
      await fakes.github('ci-green', PR);
      await until(board, 'with green checks on the new head', green, { poll: true });
      await submit(board, 'worker', dev, HEAD_B);
      await takeTurn(context, 'orchestrator', 'review: no_review_on_head', 'review');
      const code = id(context, 'code');
      await until(
        board,
        'back in Review',
        (task) => taken(task, 'review') && task.blocks.every((open) => open.id !== code),
      );
    },
  },
  {
    title: 'Product Review',
    narration: 'Review passes the new head, and the conductor takes the Product Review turn.',
    async run(context) {
      const { board } = context;
      await submit(board, 'orchestrator', id(context, 'review'), HEAD_B);
      await takeTurn(context, 'orchestrator', 'product-review: no_review_on_head', 'product');
      await until(board, 'with a taken Product Review turn', (task) =>
        taken(task, 'product-review'),
      );
    },
  },
  {
    title: 'External Review',
    narration:
      'Product Review passes too; the task waits in External Review for an outside approval, with no turn.',
    open: () => TASK_VIEW,
    async run(context) {
      const { board } = context;
      await submit(board, 'orchestrator', id(context, 'product'), HEAD_B);
      await until(
        board,
        'in external-review',
        (task) => task.column === 'external-review' && task.turn === null,
      );
    },
  },
  {
    title: 'Approved',
    narration: `${APPROVER} approves the pull request on GitHub; the task moves on to QA and the conductor takes it.`,
    async run(context) {
      const { board, fakes } = context;
      await fakes.github('review', { ...PR, state: 'APPROVED', author: APPROVER });
      await board.poll();
      await takeTurn(context, 'orchestrator', 'qa: no_submit_on_head', 'qa');
      await until(
        board,
        'in QA with the approval',
        (task) =>
          taken(task, 'qa') &&
          (task.prSummary?.[0]?.reviewsOnHead.approved ?? []).includes(APPROVER),
      );
    },
  },
  {
    title: 'Ready to Merge',
    narration:
      'QA passes; the task is Ready to Merge, and the operator gets the merge turn in the inbox.',
    open: () => 'inbox',
    async run(context) {
      const { board } = context;
      await submit(board, 'orchestrator', id(context, 'qa'), HEAD_B);
      await until(
        board,
        "with the operator's merge turn",
        (task, items) =>
          task.column === 'ready-to-merge' &&
          task.turn?.addressee === 'operator' &&
          items.includes(`turn:${task.turn.id.slice(1)}`),
      );
    },
  },
  {
    title: 'Done',
    narration:
      'The pull request is merged and the issue closed; the task lands in Done with a wrap-up turn for the worker.',
    open: () => TASK_VIEW,
    async run({ board, fakes }) {
      await fakes.github('merge', PR);
      await fakes.github('issue-close', PR);
      // Fake verbs can move updatedAt a millisecond ahead when a fixed clock is injected.
      await board.shiftClock(10);
      await until(board, 'in done', (task) => task.column === 'done', { poll: true });
      await turnOn(board, 'worker', NUMBER, 'done: wrap up', STEP_MS);
    },
  },
];

export const walkthrough: Scenario = {
  name: 'walkthrough',
  summary: `The showcase Board plus issue ${String(NUMBER)} in Todo, which pnpm stand demo next carries to Done in ${String(STEPS.length)} steps: Ready for Dev, Dev, a question, a PR, Review, a return, a new head, Product Review, External Review, an approval, QA, Ready to Merge and Done.`,
  ...(showcase.config === undefined ? {} : { config: showcase.config }),
  async seed(board, fakes, clock) {
    const entities = await showcase.seed(board, fakes, clock);
    await fakes.github('issue-open', { ...PR, title: TITLE });
    await until(board, 'in todo', (task) => task.column === 'todo', { poll: true });
    return { ...entities, tasks: { ...entities.tasks, demo: TASK } };
  },
  async settled(context) {
    const shown = await showcase.settled(context);
    if (!shown.ok) return shown;
    return settledUnless((await row(context.board)) === undefined ? [`no task ${TASK}`] : []);
  },
  demo: STEPS,
};
