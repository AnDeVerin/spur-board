import { describe, expect, it } from 'vitest';
import type { Board, DemoContext, ScenarioFakes } from '../src/scenarios/index.ts';
import { walkthrough } from '../src/scenarios/walkthrough.ts';

const TASK = 'stand-org/board#440';
const QUESTION = 'B7';

/**
 * The answer step on a fake board: `task.get` reports the question's state from `states`
 * in turn (the last one repeats), and `block.answer` runs `answer`; the IDs it called, in order.
 */
async function answerStep(states: string[], answer: () => Promise<unknown>) {
  const step = walkthrough.demo?.find(({ title }) => title === 'The answer');
  if (step === undefined) throw new Error('no step The answer');
  const calls: string[] = [];
  let reads = 0;
  // The question's state as the board holds it: each read takes the next of `states`, and a
  // scripted answer that succeeds closes it.
  let state = 'open';
  const board = {
    roles: { worker: 'w', orchestrator: 'o', curator: 'c' },
    async call(_role: string, id: string) {
      calls.push(id);
      if (id === 'task.get') {
        state = states[Math.min(reads, states.length - 1)] ?? state;
        reads += 1;
        return { blocks: [{ id: QUESTION, state }] };
      }
      if (id === 'block.answer') {
        const answered = await answer();
        state = 'unblocked';
        return answered;
      }
      if (id === 'status.get')
        return {
          tasks: [{ key: TASK, blocks: state === 'open' ? [{ id: QUESTION }] : [] }],
          items: [],
        };
      throw new Error(`unexpected ${id}`);
    },
    poll: () => Promise.resolve({}),
    async until(label: string, _ms: number, predicate: () => Promise<boolean>) {
      if (!(await predicate())) throw new Error(`${label} not reached`);
    },
  } as unknown as Board;
  const context: DemoContext = {
    board,
    fakes: {} as ScenarioFakes,
    entities: {},
    ids: { question: QUESTION },
  };
  await step.run(context);
  return calls;
}

const notOpen = () => Promise.reject(new Error('block.answer answered 409: block_not_open'));

describe('walkthrough answer step', () => {
  it('answers an open question', async () => {
    const calls = await answerStep(['open'], () => Promise.resolve({}));
    expect(calls.filter((id) => id === 'block.answer')).toHaveLength(1);
  });

  it('skips the answer when the presenter already answered', async () => {
    const calls = await answerStep(['unblocked'], notOpen);
    expect(calls).not.toContain('block.answer');
  });

  it('carries on when the web answer lands between the read and the scripted answer', async () => {
    const calls = await answerStep(['open', 'unblocked'], notOpen);
    expect(calls.slice(0, 3)).toEqual(['task.get', 'block.answer', 'task.get']);
  });

  it('rethrows a refused answer while the question is still open', async () => {
    await expect(answerStep(['open', 'open'], notOpen)).rejects.toThrow('block_not_open');
  });
});
