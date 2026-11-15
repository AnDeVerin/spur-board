import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { issueKey, openIssues, settledUnless } from './helpers.ts';
import type { Scenario, ScenarioFakes, SlackMessage } from './index.ts';

const NAMES = [1, 2, 3, 4, 5, 6].map((n) => `stand-list-${String(n)}`);
// A backtick to show as ´ and enough `&` that the escaped rows overflow the list's budget.
const FOLDER = `/stand/\`pwd\`/${'&'.repeat(200)}`;
// The list also holds the stand's own approved operator token.
const REPLY = [`Posted ${String(NAMES.length + 1)} operator tokens to the feed.`];
const LIST_HINT = /> \d+ more: `board token list`$/;
// Built at run time so no secret-shaped literal sits in the source.
const SECRET = ['xoxb', '123', 'abc'].join('-');
const blockedHint = (key: string): string => `read \`board task ${key}\``;

async function messages(fakes: ScenarioFakes): Promise<SlackMessage[]> {
  return (await fakes.slack.outbox()).messages;
}

const listMessage = (all: SlackMessage[]): SlackMessage | undefined =>
  all.find((message) => LIST_HINT.test(message.text));

const blockedMessage = (all: SlackMessage[], key: string): SlackMessage | undefined =>
  all.find((message) => message.text.includes(blockedHint(key)));

/**
 * The two feed lines with a board-written command hint: an overflowing `/board tokens` list and a
 * question blocked as a secret. Each hint reaches the fake Slack as code.
 */
export const feedCodeHints: Scenario = {
  name: 'feed-code-hints',
  summary: `An overflowing token list and a blocked-secret line in the feed, each hint in backticks.`,
  async seed(board, fakes) {
    for (const name of NAMES)
      await board.requestToken({
        name,
        folder: FOLDER,
        host: 'stand',
        // A hash of a secret nobody keeps: the scenario never uses the tokens themselves.
        hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      });
    const { responses } = await fakes.slack.command('tokens');
    if (!isDeepStrictEqual(responses, REPLY))
      throw new Error(
        `/board tokens replied ${JSON.stringify(responses)}, expected ${JSON.stringify(REPLY)}`,
      );
    await openIssues(fakes, 1);
    await board.poll();
    await board.call(
      'worker',
      'block.ask',
      { task: issueKey(1), text: `Please inspect ${SECRET}` },
      'feed-code-hints',
    );
    await board.wait('outbox-drained');
    let list: SlackMessage | undefined;
    let blocked: SlackMessage | undefined;
    await board.until('token list and blocked line posted', 10_000, async () => {
      const all = await messages(fakes);
      list = listMessage(all);
      blocked = blockedMessage(all, issueKey(1));
      return list !== undefined && blocked !== undefined;
    });
    return {
      tasks: { blocked: issueKey(1) },
      tokens: Object.fromEntries(NAMES.map((name, index) => [`list${String(index + 1)}`, name])),
      ...(list === undefined || blocked === undefined
        ? {}
        : { messages: { list: String(list.n), blocked: String(blocked.n) } }),
    };
  },
  async settled({ fakes, entities }) {
    const key = entities.tasks?.['blocked'] ?? issueKey(1);
    const all = await messages(fakes);
    const list = listMessage(all);
    const blocked = blockedMessage(all, key);
    return settledUnless([
      ...(list !== undefined && String(list.n) === entities.messages?.['list']
        ? []
        : ['the token list with `board token list` in backticks is not the one named']),
      ...(blocked !== undefined && String(blocked.n) === entities.messages?.['blocked']
        ? []
        : [`the blocked line with \`board task ${key}\` in backticks is not the one named`]),
    ]);
  },
};
