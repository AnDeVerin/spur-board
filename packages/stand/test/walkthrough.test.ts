import { describe, expect, it } from 'vitest';
import type { Board, DemoContext, ScenarioFakes } from '../src/scenarios/index.ts';
import { walkthrough } from '../src/scenarios/walkthrough.ts';

const TASK = 'stand-org/board#440';
const QUESTION = 'B7';
const ITEM = 'operator-block:7';

/** When the presenter's web answer lands, if at all. */
type Landing =
  | 'never'
  /** While the question step waits for the block and its item. */
  | 'asking'
  /** After the question step settled, before the answer step starts. */
  | 'between-steps'
  /** Between the answer step's read of the task and its scripted `block.answer`. */
  | 'after-read';

const step = (title: string) => {
  const found = walkthrough.demo?.find((candidate) => candidate.title === title);
  if (found === undefined) throw new Error(`no step ${title}`);
  return found;
};

/**
 * Runs the question and answer steps on a fake board holding one question. A web answer closes
 * it at `landing`; the board raises the question's item on the first poll while it is open.
 * `refuse` makes the scripted answer fail although the question is open. The IDs called, in order.
 */
async function questionSteps(landing: Landing, { refuse = false } = {}): Promise<string[]> {
  const calls: string[] = [];
  let state: 'none' | 'open' | 'unblocked' = 'none';
  let item = false;
  let landed = false;
  const webAnswer = () => {
    state = 'unblocked';
    item = false;
    landed = true;
  };
  const board = {
    roles: { worker: 'w', orchestrator: 'o', curator: 'c' },
    async call(_role: string, id: string) {
      calls.push(id);
      if (id === 'block.ask') {
        state = 'open';
        return { block: { id: QUESTION } };
      }
      if (id === 'status.get') {
        if (landing === 'asking' && !landed) webAnswer();
        return {
          tasks: [
            {
              key: TASK,
              blocks: state === 'open' ? [{ id: QUESTION, addressee: 'operator' }] : [],
            },
          ],
          items: item ? [{ key: ITEM }] : [],
        };
      }
      if (id === 'task.get') {
        const read = { blocks: [{ id: QUESTION, state }] };
        if (landing === 'after-read' && !landed) webAnswer();
        return read;
      }
      if (id === 'block.answer') {
        await Promise.resolve();
        if (refuse || state !== 'open')
          throw new Error('block.answer answered 409: block_not_open');
        state = 'unblocked';
        item = false;
        return {};
      }
      throw new Error(`unexpected ${id}`);
    },
    poll() {
      if (state === 'open') item = true;
      return Promise.resolve({});
    },
    // A few looks, as the real wait makes many: enough for one poll to raise the item.
    async until(label: string, _ms: number, predicate: () => Promise<boolean>) {
      for (let look = 0; look < 5; look += 1) if (await predicate()) return;
      throw new Error(`${label} not reached`);
    },
  } as unknown as Board;
  const context: DemoContext = { board, fakes: {} as ScenarioFakes, entities: {}, ids: {} };
  await step('A question to the operator').run(context);
  expect(context.ids['question']).toBe(QUESTION);
  if (landing === 'between-steps') webAnswer();
  calls.push('|');
  await step('The answer').run(context);
  expect(state).toBe('unblocked');
  expect(item).toBe(false);
  return calls.slice(calls.indexOf('|') + 1);
}

describe('walkthrough question and answer steps', () => {
  it.each([
    ['never', 1],
    ['asking', 0],
    ['between-steps', 0],
    ['after-read', 1],
  ] as const)(
    'settle both steps when the web answer lands %s, with %i scripted answer(s)',
    async (landing, answers) => {
      const calls = await questionSteps(landing);
      expect(calls.filter((id) => id === 'block.answer')).toHaveLength(answers);
    },
  );

  it('re-reads the task after a refused answer when the web answer landed after its read', async () => {
    const calls = await questionSteps('after-read');
    expect(calls.slice(0, 3)).toEqual(['task.get', 'block.answer', 'task.get']);
  });

  it('rethrows a refused answer while the question is still open', async () => {
    await expect(questionSteps('never', { refuse: true })).rejects.toThrow('block_not_open');
  });
});
