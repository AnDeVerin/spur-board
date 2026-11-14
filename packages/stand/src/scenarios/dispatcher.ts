// The dispatcher flow scenarios: the `stand` project runs `dispatcher.mode: on` on a short board,
// and each seed stops right after the dispatcher's first decision under test.
import { randomUUID } from 'node:crypto';
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Board, Scenario, ScenarioEntities, ScenarioFakes } from './index.ts';

const REPO = 'stand-org/board';
const ISSUE = issueKey(1);
const PR = `${REPO}#1`;
const A = 'a'.repeat(40);
const STEP_MS = 15_000;

/**
 * To Do, Dev, Review by the stand-qa conductor, Ready to Merge by the operator, Done. `review`
 * sets Review's cycle limit and course check, and `spurProjects` replaces the stand project's.
 */
const flow = (
  review: { cycleLimit?: number; courseCheck?: number } = {},
  spurProjects?: object[],
) => ({
  stand: {
    columns: [
      { id: 'todo' },
      { id: 'dev' },
      { id: 'review', orchestrator: 'stand-qa', ...review },
      { id: 'ready-to-merge', orchestrator: 'operator' },
      { id: 'done' },
    ],
    dispatcher: { mode: 'on' as const },
    ...(spurProjects === undefined ? {} : { spurProjects }),
  },
});

type Agent = 'worker' | 'orchestrator';
type Turn = Awaited<ReturnType<typeof inbox>>['turns'][number];

const inbox = (board: Board, role: Agent) => board.call(role, 'inbox.get', {});

/** The role's open turn on the flow task, if any. */
async function turnOf(board: Board, role: Agent): Promise<Turn | undefined> {
  return (await inbox(board, role)).turns.find(({ task }) => task === ISSUE);
}

/** Waits for the role's open turn on the flow task whose reason is `reason`. */
async function awaitTurn(board: Board, role: Agent, reason: string): Promise<Turn> {
  let found: Turn | undefined;
  await board.until(`${role} turn ${reason}`, STEP_MS, async () => {
    found = await turnOf(board, role);
    return found?.reason === reason;
  });
  if (found === undefined) throw new Error(`no ${role} turn ${reason}`);
  return found;
}

async function column(board: Board): Promise<string | undefined> {
  const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
  return tasks.find(({ key }) => key === ISSUE)?.column;
}

async function items(board: Board) {
  return (await board.call('operator', 'status.get', { project: 'stand' })).items;
}

const take = (board: Board, role: Agent, turn: string) =>
  board.call(role, 'inbox.ack', { entries: [{ id: turn }] }, randomUUID());

const submit = (board: Board, role: Agent, turn: string, sha: string) =>
  board.call(role, 'task.submit', { turn, sha }, randomUUID());

const giveBack = (board: Board, turn: string) =>
  board.call(
    'orchestrator',
    'task.return',
    { turn, reason: 'Handle the empty list.' },
    randomUUID(),
  );

/** Opens issue 1 and links the worker role session: Dev with the turn `dev: no_pr`. */
async function begin(board: Board, fakes: ScenarioFakes): Promise<Turn> {
  await openIssues(fakes, 1);
  await board.poll();
  await board.call('operator', 'link.add', {
    mode: 'session',
    task: ISSUE,
    session: board.roles.worker,
    reason: 'Stand dispatcher flow',
  });
  await board.poll();
  return awaitTurn(board, 'worker', 'dev: no_pr');
}

/** PR #1 at head A, linked by its branch `stand-1`; green unless `green` is false. */
async function openPr(
  board: Board,
  fakes: ScenarioFakes,
  options: { green?: boolean; seed?: Record<string, unknown> } = {},
): Promise<void> {
  await fakes.github('create', { repo: REPO, number: 1, seed: { headRefOid: A, ...options.seed } });
  if (options.green !== false) await fakes.github('ci-green', { repo: REPO, number: 1 });
  await board.poll();
}

/** The worker took T1, opened a green PR and submitted A: Review with the conductor's turn. */
async function toReview(board: Board, fakes: ScenarioFakes): Promise<Turn> {
  const dev = await begin(board, fakes);
  await take(board, 'worker', dev.id);
  await openPr(board, fakes);
  await submit(board, 'worker', dev.id, A);
  return awaitTurn(board, 'orchestrator', 'review: no_review_on_head');
}

/** The conductor took and submitted Review on A: Ready to Merge with the operator's turn item. */
async function toReadyToMerge(board: Board, fakes: ScenarioFakes): Promise<string> {
  const review = await toReview(board, fakes);
  await take(board, 'orchestrator', review.id);
  await submit(board, 'orchestrator', review.id, A);
  return operatorItem(board, 'ready-to-merge: not_merged');
}

/** The key of the operator turn item `turn:<id>` on the flow task with `reason`. */
async function operatorItem(board: Board, reason: string): Promise<string> {
  let key: string | undefined;
  await board.until(`operator turn ${reason}`, STEP_MS, async () => {
    key = (await items(board)).find(
      (item) => /^turn:\d+$/.test(item.key) && item.summary.endsWith(` on ${ISSUE}: ${reason}`),
    )?.key;
    return key !== undefined;
  });
  if (key === undefined) throw new Error(`no operator turn ${reason}`);
  return key;
}

function entities(board: Board, extra: ScenarioEntities = {}): ScenarioEntities {
  return {
    tasks: { flow: ISSUE },
    prs: { flow: PR },
    sessions: { worker: board.roles.worker, conductor: board.roles.orchestrator },
    ...extra,
  };
}

/** The problems of the flow task's column and the role's turn against what is expected. */
async function check(
  board: Board,
  expected: { column: string; role?: Agent; reason?: string; taken?: boolean },
): Promise<string[]> {
  const problems: string[] = [];
  const at = await column(board);
  if (at !== expected.column) problems.push(`task in ${at ?? 'nothing'}, not ${expected.column}`);
  if (expected.role === undefined) return problems;
  const turn = await turnOf(board, expected.role);
  if (turn === undefined || turn.reason !== expected.reason)
    problems.push(`${expected.role} turn ${turn?.reason ?? 'none'}, not ${expected.reason ?? ''}`);
  else if (expected.taken !== undefined && (turn.taken !== null) !== expected.taken)
    problems.push(`${expected.role} turn ${expected.taken ? 'untaken' : 'taken'}`);
  return problems;
}

export const dispatchHappyPath: Scenario = {
  name: 'dispatch-happy-path',
  summary: `${ISSUE} passes Dev and Review on head A and waits in Ready to Merge on the operator's turn item.`,
  config: flow(),
  async seed(board, fakes) {
    const turn = await toReadyToMerge(board, fakes);
    return entities(board, { items: { turn } });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, { column: 'ready-to-merge' });
    const turn = named.items?.['turn'];
    const item = (await items(board)).find(({ key }) => key === turn);
    if (item?.summary.endsWith(': ready-to-merge: not_merged') !== true)
      problems.push(`no item ${turn ?? 'turn'} ready-to-merge: not_merged`);
    return settledUnless(problems);
  },
};

export const dispatchReviewLoop: Scenario = {
  name: 'dispatch-review-loop',
  summary: `The conductor returns ${ISSUE} from Review: Dev with a code block and the worker's turn.`,
  config: flow(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    const { block } = await giveBack(board, review.id);
    await awaitTurn(board, 'worker', 'dev: no_submit_on_head');
    return entities(board, { blocks: { code: block.id } });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, {
      column: 'dev',
      role: 'worker',
      reason: 'dev: no_submit_on_head',
    });
    const { blocks } = await board.call('operator', 'task.get', { task: ISSUE });
    const code = blocks.find(({ id }) => id === named.blocks?.['code']);
    if (code?.state !== 'open' || code.addressee !== 'worker' || code.type !== 'code')
      problems.push('no open code block for the worker');
    return settledUnless(problems);
  },
};

export const dispatchCiRedAfterSubmit: Scenario = {
  name: 'dispatch-ci-red-after-submit',
  summary: `The worker submits ${ISSUE} while CI runs, then CI turns red: Dev with the turn dev: checks_red.`,
  config: flow(),
  async seed(board, fakes) {
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    await openPr(board, fakes, { green: false });
    const submitted = await submit(board, 'worker', dev.id, A);
    if (submitted.task.column !== 'dev')
      throw new Error(`an early submit moved the task to ${submitted.task.column}`);
    if ((await turnOf(board, 'worker')) !== undefined) throw new Error('an early submit turned');
    await fakes.github('ci-red', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'worker', 'dev: checks_red');
    return entities(board);
  },
  async settled({ board }) {
    return settledUnless(
      await check(board, {
        column: 'dev',
        role: 'worker',
        reason: 'dev: checks_red',
        taken: false,
      }),
    );
  },
};

export const dispatchConflictInReview: Scenario = {
  name: 'dispatch-conflict-in-review',
  summary: `PR #1 conflicts while the conductor holds the Review turn of ${ISSUE}; the task waits in Review.`,
  config: flow(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await fakes.github('conflict', { repo: REPO, number: 1 });
    await board.poll();
    return entities(board);
  },
  async settled({ board }) {
    return settledUnless(
      await check(board, {
        column: 'review',
        role: 'orchestrator',
        reason: 'review: no_review_on_head',
        taken: true,
      }),
    );
  },
};

export const dispatchConflictInReadyToMerge: Scenario = {
  name: 'dispatch-conflict-in-ready-to-merge',
  summary: `PR #1 conflicts in Ready to Merge: ${ISSUE} goes to Dev at once with the worker's turn.`,
  config: flow(),
  async seed(board, fakes) {
    const turn = await toReadyToMerge(board, fakes);
    await fakes.github('conflict', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'worker', 'dev: conflict, no_submit_on_head');
    return entities(board, { items: { turn } });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, {
      column: 'dev',
      role: 'worker',
      reason: 'dev: conflict, no_submit_on_head',
      taken: false,
    });
    const turn = named.items?.['turn'];
    if ((await items(board)).some(({ key }) => key === turn))
      problems.push(`item ${turn ?? 'turn'} is not cleared`);
    return settledUnless(problems);
  },
};

export const dispatchReentrySameHead: Scenario = {
  name: 'dispatch-reentry-same-head',
  summary: `An external comment in Ready to Merge sends ${ISSUE} to Dev with the comment handed to the worker.`,
  config: flow(),
  async seed(board, fakes) {
    await toReadyToMerge(board, fakes);
    await fakes.github('comment', { repo: REPO, number: 1 });
    await board.poll();
    await awaitTurn(board, 'worker', 'dev: external_comments, no_submit_on_head');
    return entities(board);
  },
  async settled({ board }) {
    const reason = 'dev: external_comments, no_submit_on_head';
    const problems = await check(board, { column: 'dev', role: 'worker', reason });
    const handed = (await turnOf(board, 'worker'))?.handed ?? [];
    if (handed.length !== 1 || handed[0]?.kind !== 'comment')
      problems.push(`the turn hands ${JSON.stringify(handed)}, not one comment`);
    return settledUnless(problems);
  },
};

/** Comments by the agent account before the stand clock, oldest first, as `pageBack` needs. */
const agentHistory = (now: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    author: { __typename: 'User', login: 'stand-agent' },
    createdAt: new Date(now - (count - i) * 60_000).toISOString(),
  }));

export const dispatchExternalComment: Scenario = {
  name: 'dispatch-external-comment',
  summary: `During the worker's Dev turn on ${ISSUE}, a reviewer, a bot and the agent account post on PR #1 (150 older comments); the turn hands nothing yet.`,
  config: flow(),
  async seed(board, fakes, clock) {
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    await openPr(board, fakes, { seed: { comments: agentHistory(clock.now(), 150) } });
    const pr = { repo: REPO, number: 1 };
    await fakes.github('comment', pr);
    await fakes.github('review', { ...pr, state: 'COMMENTED' });
    await fakes.github('comment', { ...pr, bot: true });
    await fakes.github('comment', { ...pr, author: 'stand-agent' });
    await board.poll();
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, { column: 'dev', role: 'worker', reason: 'dev: no_pr' });
    const turn = await turnOf(board, 'worker');
    // A seed starts on a fresh database, so the worker's first turn is T1.
    if (turn?.id !== 'T1') problems.push(`open turn ${turn?.id ?? 'none'}, not T1`);
    if (turn !== undefined && turn.handed.length > 0) problems.push('the turn hands feedback');
    if (turn !== undefined && turn.taken === null) problems.push('the turn is untaken');
    return settledUnless(problems);
  },
};

/** The history comment the reviewer wrote, among the agent account's. */
const OLD_EXTERNAL = 10;

export const dispatchLongCommentHistory: Scenario = {
  name: 'dispatch-long-comment-history',
  summary: `PR #1 of ${ISSUE} has 650 older comments, comment ${String(OLD_EXTERNAL)} by a reviewer; the first poll reads only the newest 300, so Dev waits on the comment history.`,
  config: flow(),
  async seed(board, fakes, clock) {
    const dev = await begin(board, fakes);
    await take(board, 'worker', dev.id);
    const comments = agentHistory(clock.now(), 650).map((comment, i) =>
      i === OLD_EXTERNAL
        ? { ...comment, author: { __typename: 'User', login: 'stand-reviewer' } }
        : comment,
    );
    await openPr(board, fakes, { seed: { comments } });
    return entities(board);
  },
  async settled({ board }) {
    const problems = await check(board, {
      column: 'dev',
      role: 'worker',
      reason: 'dev: no_pr',
      taken: true,
    });
    const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
    const dev = why?.gates.find(({ column: id }) => id === 'dev');
    const history = dev?.conditions.find(({ condition }) => condition === 'comment_history_read');
    if (history?.state !== 'waiting')
      problems.push(`comment_history_read is ${history?.state ?? 'missing'}, not waiting`);
    return settledUnless(problems);
  },
};

export const dispatchDeadExecutor: Scenario = {
  name: 'dispatch-dead-executor',
  summary: `The worker role session is killed while ${ISSUE} is in Review; the conductor's return gives the operator a turn item.`,
  config: flow(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await fakes.spur('session', { id: board.roles.worker, status: 'killed', state: 'killed' });
    await board.poll();
    await take(board, 'orchestrator', review.id);
    await giveBack(board, review.id);
    const turn = await operatorItem(board, 'dev: no_submit_on_head');
    return entities(board, { items: { turn } });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, { column: 'dev' });
    const turn = named.items?.['turn'];
    const id = turn?.replace('turn:', 'T') ?? '';
    const item = (await items(board)).find(({ key }) => key === turn);
    if (item?.summary !== `turn ${id} on ${ISSUE}: dev: no_submit_on_head`)
      problems.push(`no item ${turn ?? 'turn'}: ${item?.summary ?? 'none'}`);
    if ((await turnOf(board, 'orchestrator')) !== undefined) problems.push('a conductor turn');
    return settledUnless(problems);
  },
};

const GITHUB_SOURCE = `github:stand:${REPO}`;

export const dispatchSourceBlind: Scenario = {
  name: 'dispatch-source-blind',
  summary: `GitHub answers 401 while ${ISSUE} is in Review; the conductor's return leaves Dev with no turn.`,
  config: flow(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await fakes.github('fail', { mode: 'auth' });
    await board.poll();
    await giveBack(board, review.id);
    return entities(board, { sources: { blind: GITHUB_SOURCE } });
  },
  async settled({ board }) {
    const problems = await check(board, { column: 'dev' });
    const { sources } = await board.call('operator', 'status.get', {});
    const state = sources.find(({ source }) => source === GITHUB_SOURCE);
    if (state?.blindReason !== 'auth')
      problems.push(`${GITHUB_SOURCE} is blind for ${state?.blindReason ?? 'nothing'}`);
    for (const role of ['worker', 'orchestrator'] as const)
      if ((await turnOf(board, role)) !== undefined) problems.push(`a ${role} turn`);
    if ((await items(board)).some(({ key }) => key.startsWith('turn:')))
      problems.push('a turn item');
    return settledUnless(problems);
  },
};

const cycleItem = async (board: Board) =>
  (await items(board)).find(({ key }) => /^cycle-limit:\d+:review$/.test(key));

export const dispatchCycleLimit: Scenario = {
  name: 'dispatch-cycle-limit',
  summary: `Review's cycle limit is 1: the conductor's return holds ${ISSUE} in Dev on an operator block, with no turn.`,
  config: flow({ cycleLimit: 1 }),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await giveBack(board, review.id);
    let key: string | undefined;
    await board.until('cycle-limit item', STEP_MS, async () => {
      key = (await cycleItem(board))?.key;
      return key !== undefined;
    });
    return entities(board, key === undefined ? {} : { items: { limit: key } });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, { column: 'dev' });
    const item = await cycleItem(board);
    if (item === undefined || item.key !== named.items?.['limit'])
      problems.push(`no item ${named.items?.['limit'] ?? 'cycle-limit'}`);
    const { blocks } = await board.call('operator', 'task.get', { task: ISSUE });
    if (!blocks.some(({ state, addressee }) => state === 'open' && addressee === 'operator'))
      problems.push('no open operator block');
    if ((await turnOf(board, 'worker')) !== undefined) problems.push('a worker turn');
    return settledUnless(problems);
  },
};

const courseItem = async (board: Board) =>
  (await items(board)).find(({ key }) => /^course-check:\d+:review$/.test(key));

/** The flow task's open blocks, as the operator sees them. */
const openBlocks = async (board: Board) =>
  (await board.call('operator', 'task.get', { task: ISSUE })).blocks.filter(
    ({ state }) => state === 'open',
  );

export const dispatchCourseCheck: Scenario = {
  name: 'dispatch-course-check',
  summary: `Review's course check is 1 and stand-qa is also the curator: the conductor's return holds ${ISSUE} in Dev on a curator block, with no turn.`,
  config: flow({ courseCheck: 1 }, [
    { name: 'stand-worker', role: 'worker' },
    { name: 'stand-qa', role: 'curator' },
  ]),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await giveBack(board, review.id);
    let course: string | undefined;
    let code: string | undefined;
    let key: string | undefined;
    await board.until('course-check block', STEP_MS, async () => {
      const blocks = await openBlocks(board);
      course = blocks.find(
        (block) =>
          block.type === 'needs_input' &&
          block.author === 'system' &&
          block.addressee === 'curator',
      )?.id;
      code = blocks.find((block) => block.type === 'code')?.id;
      key = (await courseItem(board))?.key;
      return course !== undefined && key !== undefined;
    });
    return entities(board, {
      ...(course === undefined
        ? {}
        : { blocks: { course, ...(code === undefined ? {} : { code }) } }),
      ...(key === undefined ? {} : { items: { course: key } }),
    });
  },
  async settled({ board, entities: named }) {
    const problems = await check(board, { column: 'dev' });
    const item = await courseItem(board);
    if (item === undefined || item.key !== named.items?.['course'])
      problems.push(`no item ${named.items?.['course'] ?? 'course-check'}`);
    const block = (await openBlocks(board)).find(({ id }) => id === named.blocks?.['course']);
    if (block?.addressee !== 'curator') problems.push('no open curator block');
    for (const part of ['Handle the empty list.', '/pull/1', '/issues/1'])
      if (block?.reason.includes(part) !== true) problems.push(`no ${part} in the block reason`);
    if ((await turnOf(board, 'worker')) !== undefined) problems.push('a worker turn');
    return settledUnless(problems);
  },
};
