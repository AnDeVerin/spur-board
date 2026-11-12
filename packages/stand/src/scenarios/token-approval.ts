import { createHash, randomBytes } from 'node:crypto';
import { settledUnless } from './helpers.ts';
import type { ScenarioFakes, Scenario, SlackMessage } from './index.ts';

const NAME = 'stand-tester';
const APPROVE = /^token:\d+:approve$/;

async function approvalMessage(fakes: ScenarioFakes): Promise<SlackMessage | undefined> {
  const { messages } = await fakes.slack.outbox();
  return messages.find(
    (message) =>
      message.text.includes(`token ${NAME} `) &&
      message.actions.some((action) => APPROVE.test(action)),
  );
}

/** A pending operator token request whose approval message waits in Slack; it stops before the click. */
export const tokenApproval: Scenario = {
  name: 'token-approval',
  summary: `Token ${NAME} pending, its approval message posted to the fake Slack.`,
  async seed(board, fakes) {
    await board.requestToken({
      name: NAME,
      folder: '/stand/tester',
      host: 'stand',
      // A hash of a secret nobody keeps: the scenario never uses the token itself.
      hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    });
    await board.wait('outbox-drained');
    let message: SlackMessage | undefined;
    await board.until('approval message posted', 10_000, async () => {
      message = await approvalMessage(fakes);
      return message !== undefined;
    });
    return {
      tokens: { tester: NAME },
      ...(message === undefined ? {} : { messages: { approval: String(message.n) } }),
    };
  },
  async settled({ board, fakes, entities }) {
    const name = entities.tokens?.['tester'] ?? NAME;
    const { tokens } = await board.call('operator', 'token.list', {});
    const token = tokens.find((candidate) => candidate.name === name);
    const message = await approvalMessage(fakes);
    return settledUnless([
      ...(token?.status === 'pending' ? [] : [`token ${name} is ${token?.status ?? 'missing'}`]),
      ...(message !== undefined && String(message.n) === entities.messages?.['approval']
        ? []
        : ['the approval message is not the one named']),
    ]);
  },
};
