// The curator scenarios: the stand project gets `stand-curator` as its curator, so a worker
// question on a column without an orchestrator goes to the curator before the operator.
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Board, Scenario, ScenarioEntities, ScenarioFakes, Settled } from './index.ts';

const QUESTION = 'Which version should the client target?';
const NOTE = 'The API owner decides this; I cannot.';
const CURATOR_WAIT_MS = 20_000;

const curatorConfig: NonNullable<Scenario['config']> = {
  stand: {
    spurProjects: [
      { name: 'stand-worker', role: 'worker' },
      { name: 'stand-qa', role: 'worker' },
      { name: 'stand-curator', role: 'curator' },
    ],
  },
};

/**
 * Opens issue 1 and asks the question on it as the worker. Worker and curator wait, so rings go
 * out; `killed` ends the curator session first, so no live curator is left.
 */
async function askAsWorker(
  board: Board,
  fakes: ScenarioFakes,
  key: string,
  curator: { killed: boolean },
): Promise<ScenarioEntities> {
  await openIssues(fakes, 1);
  await fakes.spur('session', { id: board.roles.worker, state: 'waiting' });
  await fakes.spur('session', {
    id: board.roles.curator,
    state: 'waiting',
    ...(curator.killed ? { status: 'killed' } : {}),
  });
  await board.poll();
  const { block } = await board.call(
    'worker',
    'block.ask',
    { task: issueKey(1), text: QUESTION },
    key,
  );
  return {
    tasks: { question: issueKey(1) },
    blocks: { question: block.id },
    sessions: { asker: board.roles.worker, curator: board.roles.curator },
  };
}

/** The open question block the entities name, checked against `addressee`. */
async function openBlockTo(
  board: Board,
  entities: ScenarioEntities,
  addressee: 'curator' | 'operator',
): Promise<string[]> {
  const task = entities.tasks?.['question'];
  const id = entities.blocks?.['question'];
  if (task === undefined || id === undefined) return ['the entities name no question'];
  const { blocks } = await board.call('operator', 'task.get', { task });
  const block = blocks.find((candidate) => candidate.id === id);
  return [
    ...(block?.state === 'open' ? [] : [`block ${id} is ${block?.state ?? 'missing'}`]),
    ...(block === undefined || block.addressee === addressee
      ? []
      : [`block ${id} is addressed to ${block.addressee}`]),
  ];
}

/** Whether the fake Slack holds the question, posted once the block reached the operator. */
async function questionPosted(fakes: ScenarioFakes): Promise<string[]> {
  const { messages } = await fakes.slack.outbox();
  return messages.some((message) => message.text.includes(QUESTION))
    ? []
    : ['the fake Slack holds no question'];
}

/** The worker asks; the curator is rung once and has not answered. */
export const questionToCurator: Scenario = {
  name: 'question-to-curator',
  summary: 'A worker question on issue 1, open, addressed to the curator and rung once.',
  config: curatorConfig,
  async seed(board, fakes) {
    const entities = await askAsWorker(board, fakes, 'question-to-curator', { killed: false });
    const marker = `block ${entities.blocks?.['question'] ?? ''}:`;
    await board.until('the first ring to the curator', CURATOR_WAIT_MS, async () => {
      const { sends } = (await fakes.spur('inspect')) as {
        sends: { session: string; message: string }[];
      };
      return sends.some(
        ({ session, message }) => session === board.roles.curator && message.includes(marker),
      );
    });
    await board.wait('outbox-drained');
    return entities;
  },
  async settled({ board, entities }): Promise<Settled> {
    return settledUnless(await openBlockTo(board, entities, 'curator'));
  },
};

/** The curator escalates the question to the operator with a note. */
export const curatorEscalation: Scenario = {
  name: 'curator-escalation',
  summary: 'A worker question the curator escalated to the operator with a note, open in Slack.',
  config: curatorConfig,
  async seed(board, fakes) {
    const entities = await askAsWorker(board, fakes, 'curator-escalation', { killed: false });
    const block = entities.blocks?.['question'] ?? '';
    await board.call('curator', 'block.escalate', { block, note: NOTE }, 'curator-escalation');
    await board.wait('outbox-drained');
    return entities;
  },
  async settled({ board, fakes, entities }) {
    const { messages } = await fakes.slack.outbox();
    return settledUnless([
      ...(await openBlockTo(board, entities, 'operator')),
      ...(await questionPosted(fakes)),
      ...(messages.some((message) => message.text.includes(NOTE))
        ? []
        : ['the fake Slack holds no note']),
    ]);
  },
};

/** No live curator session: the board passes the question on to the operator itself. */
export const curatorAbsent: Scenario = {
  name: 'curator-absent',
  summary: 'A worker question with the curator session killed, moved to the operator by the board.',
  config: curatorConfig,
  async seed(board, fakes) {
    const entities = await askAsWorker(board, fakes, 'curator-absent', { killed: true });
    const task = issueKey(1);
    const id = entities.blocks?.['question'] ?? '';
    await board.until('the question at the operator', CURATOR_WAIT_MS, async () => {
      const { blocks } = await board.call('operator', 'task.get', { task });
      return blocks.some((block) => block.id === id && block.addressee === 'operator');
    });
    await board.wait('outbox-drained');
    return entities;
  },
  async settled({ board, fakes, entities }) {
    return settledUnless([
      ...(await openBlockTo(board, entities, 'operator')),
      ...(await questionPosted(fakes)),
    ]);
  },
};
