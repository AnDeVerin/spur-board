// The course-check scenarios: Review's course check holds the task on a block to the curator, or
// to the addressee its courseCheckTo names.
import { sendsTo, settledUnless, STAND_SPUR_PROJECTS } from './helpers.ts';
import type { Board, Scenario, ScenarioFakes } from './index.ts';
import {
  check,
  entities,
  flow,
  giveBack,
  ISSUE,
  items,
  STEP_MS,
  take,
  toReview,
  turnOf,
} from './dispatcher.ts';

const courseItem = async (board: Board) =>
  (await items(board)).find(({ key }) => /^course-check:\d+:review$/.test(key));

/** The flow task's open blocks, as the operator sees them. */
const openBlocks = async (board: Board) =>
  (await board.call('operator', 'task.get', { task: ISSUE })).blocks.filter(
    ({ state }) => state === 'open',
  );

/**
 * Review's course check is 1 and stand-curator is the curator; `to` is Review's courseCheckTo.
 * The conductor's return holds the task in Dev on a block to `addressee`, rung to `rung`'s session
 * and not to the other's; the waiting worker gets no turn and no ring.
 */
function courseCheckScenario(input: {
  name: string;
  summary: string;
  to?: string;
  addressee: string;
  rung: 'curator' | 'orchestrator';
}): Scenario {
  const { addressee, rung } = input;
  const quiet = rung === 'curator' ? 'orchestrator' : 'curator';
  return {
    name: input.name,
    summary: input.summary,
    config: flow(
      { courseCheck: 1, ...(input.to === undefined ? {} : { courseCheckTo: input.to }) },
      [...STAND_SPUR_PROJECTS, { name: 'stand-curator', role: 'curator' }],
    ),
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
            block.addressee === addressee,
        )?.id;
        code = blocks.find((block) => block.type === 'code')?.id;
        key = (await courseItem(board))?.key;
        return course !== undefined && key !== undefined;
      });
      // Both wait, so only the course check holds the worker's rings.
      await fakes.spur('session', { id: board.roles.worker, state: 'waiting' });
      await fakes.spur('session', { id: board.roles[rung], state: 'waiting' });
      await board.poll();
      await board.until(`${rung} rung`, STEP_MS, async () => {
        const sent = await sendsTo(fakes, board.roles[rung], `block ${course ?? ''}:`);
        return sent.length > 0;
      });
      await board.wait('outbox-drained');
      return entities(board, {
        ...(course === undefined
          ? {}
          : { blocks: { course, ...(code === undefined ? {} : { code }) } }),
        ...(key === undefined ? {} : { items: { course: key } }),
      });
    },
    async settled({ board, fakes, entities: named }) {
      const problems = await check(board, { column: 'dev' });
      const course = named.blocks?.['course'] ?? '';
      // The seed waits for the addressee's ring: a restore-reset starts the fake Spur's sends empty.
      const worker = await sendsTo(fakes, board.roles.worker, `${ISSUE} `);
      if (worker.length > 0) problems.push(`the worker was rung: ${worker.join('; ')}`);
      const other = await sendsTo(fakes, board.roles[quiet], `block ${course}:`);
      if (other.length > 0) problems.push(`the ${quiet} was rung: ${other.join('; ')}`);
      const { why } = await board.call('operator', 'task.get', { task: ISSUE, why: true });
      if (why?.heldBy?.includes(course) !== true)
        problems.push(`heldBy is ${why?.heldBy?.join(', ') ?? 'absent'}, not ${course}`);
      const item = await courseItem(board);
      if (item === undefined || item.key !== named.items?.['course'])
        problems.push(`no item ${named.items?.['course'] ?? 'course-check'}`);
      const block = (await openBlocks(board)).find(({ id }) => id === course);
      if (block?.addressee !== addressee) problems.push(`no open ${addressee} block`);
      for (const part of ['Handle the empty list.', '/pull/1', '/issues/1'])
        if (block?.reason.includes(part) !== true) problems.push(`no ${part} in the block reason`);
      if ((await turnOf(board, 'worker')) !== undefined) problems.push('a worker turn');
      return settledUnless(problems);
    },
  };
}

export const dispatchCourseCheck = courseCheckScenario({
  name: 'dispatch-course-check',
  summary: `Review's course check is 1 and stand-curator is the curator: the conductor's return holds ${ISSUE} in Dev on a curator block, rung to the curator; the waiting worker gets no turn and no ring.`,
  addressee: 'curator',
  rung: 'curator',
});

export const dispatchCourseCheckTo = courseCheckScenario({
  name: 'dispatch-course-check-to',
  summary: `Review's course check is 1 with courseCheckTo stand-qa, and stand-curator is the curator: the conductor's return holds ${ISSUE} in Dev on a block to the Review conductor, rung to it and not to the curator; the waiting worker gets no turn and no ring.`,
  to: 'stand-qa',
  addressee: 'orchestrator:review',
  rung: 'orchestrator',
});
