import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const QUESTION = 'Which version should the client target?';

/** The worker asks the operator a question on a todo task; it stops before the answer. */
export const questionToOperator: Scenario = {
  name: 'question-to-operator',
  summary: 'A worker question on issue 1, open and posted to the operator in Slack.',
  async seed(board, fakes) {
    await openIssues(fakes, 1);
    // An idle worker, so the answer rings it: the board holds rings to a working session.
    await fakes.spur('session', { id: board.roles.worker, state: 'waiting' });
    await board.poll();
    const { block } = await board.call(
      'worker',
      'block.ask',
      { task: issueKey(1), text: QUESTION },
      'question-to-operator',
    );
    await board.wait('outbox-drained');
    return {
      tasks: { question: issueKey(1) },
      blocks: { question: block.id },
      sessions: { asker: board.roles.worker },
    };
  },
  async settled({ board, fakes, entities }) {
    const task = entities.tasks?.['question'];
    const id = entities.blocks?.['question'];
    if (task === undefined || id === undefined)
      return { ok: false, diagnostics: 'the entities name no question' };
    const { blocks } = await board.call('operator', 'task.get', { task });
    const block = blocks.find((candidate) => candidate.id === id);
    const { messages } = await fakes.slack.outbox();
    return settledUnless([
      ...(block?.state === 'open' ? [] : [`block ${id} is ${block?.state ?? 'missing'}`]),
      ...(block === undefined || block.addressee === 'operator'
        ? []
        : [`block ${id} is addressed to ${block.addressee}`]),
      ...(messages.some((message) => message.text.includes(QUESTION))
        ? []
        : ['the fake Slack holds no question']),
    ]);
  },
};
