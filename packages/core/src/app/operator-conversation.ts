// An operator's new message in the orchestrators space starts a conversation with one Spur
// project: a `needs_input` block addressed to it, whose thread is the operator's message.
import {
  parseRef,
  type AddresseeRole,
  type Config,
  type ConversationRef,
  type MessageRef,
} from '@spur-board/contracts';
import type { Trx } from './board-utils.ts';
import { insertComment, openBlock, stripShortName } from './blocks.ts';
import type { CommandContext } from './commands.ts';
import { advanceConversationCursor, insertConversation } from './conversations.ts';
import { canonicalKey } from './membership.ts';
import { enqueueConversationNotice } from './outbox.ts';
import { projectSubject, taskSubject, type BlockSubject } from './subject.ts';

/**
 * Who an operator's new message goes to: the Spur project of a leading `@<shortName>` with the
 * text after it, else `slack.defaultAddressee` with the text unchanged, else a hint that lists the
 * valid prefixes. Null when no short name is configured: the message then stays unhandled.
 */
type OperatorAddress = { spur: string; text: string } | { hint: string } | null;

function addressOperatorMessage(text: string, config: Config): OperatorAddress {
  const spurByShortName = new Map<string, string>();
  for (const project of config.projects)
    for (const spur of project.spurProjects)
      if (spur.shortName !== undefined) spurByShortName.set(spur.shortName, spur.name);
  if (spurByShortName.size === 0) return null;
  const prefix = /^@(\S+)\s*/.exec(text);
  const named = prefix?.[1] === undefined ? undefined : spurByShortName.get(prefix[1]);
  if (prefix?.[1] !== undefined && named !== undefined)
    return { spur: named, text: stripShortName(text, prefix[1]) };
  const fallback = config.slack.defaultAddressee;
  const fallbackSpur = fallback === undefined ? undefined : spurByShortName.get(fallback);
  if (fallbackSpur !== undefined) return { spur: fallbackSpur, text };
  const names = [...spurByShortName.keys()].map((name) => `@${name}`).join(', ');
  return { hint: `No addressee. Start with one of: ${names}.` };
}

/**
 * The open, non-archived task of `project` that the first word of `text` names, with trailing
 * `?.,:;` dropped; undefined when it names none.
 */
async function namedTask(trx: Trx, config: Config, project: string, text: string) {
  const word = (/^\S+/.exec(text)?.[0] ?? '').replace(/[?.,:;]+$/, '');
  if (!parseRef(word, 'task').ok) return undefined;
  let key: string;
  try {
    const canonical = canonicalKey(config, word);
    if (canonical.project.id !== project) return undefined;
    key = canonical.key;
  } catch {
    return undefined;
  }
  return trx
    .selectFrom('task')
    .selectAll()
    .where('key', '=', key)
    .where('project', '=', project)
    .where('membership', '!=', 'archived')
    .executeTakeFirst();
}

/**
 * Opens the conversation an operator's new message starts, or posts the hint in its thread.
 * Returns false, and writes nothing, when no short name is configured.
 */
export async function openOperatorConversation(
  trx: Trx,
  input: {
    text: string;
    conversation: ConversationRef;
    message: MessageRef;
    rootMessage: MessageRef;
    gateway: string;
    at: string;
    config: Config;
  },
): Promise<boolean> {
  const { config } = input;
  const address = addressOperatorMessage(input.text, config);
  if (address === null) return false;
  if ('hint' in address) {
    await enqueueConversationNotice(trx, {
      conversation: input.conversation,
      text: address.hint,
      at: new Date(input.at),
    });
    return true;
  }
  const project = config.projects.find((entry) =>
    entry.spurProjects.some((spur) => spur.name === address.spur),
  );
  if (project === undefined) return false;
  const role: AddresseeRole =
    project.spurProjects.find((spur) => spur.name === address.spur)?.role === 'curator'
      ? 'curator'
      : 'worker';
  const task = await namedTask(trx, config, project.id, address.text);
  const subject: BlockSubject = task === undefined ? projectSubject(project.id) : taskSubject(task);
  const ctx: CommandContext = { actor: 'operator', at: input.at };
  const block = await openBlock(
    trx,
    subject,
    'needs_input',
    address.text,
    ctx,
    config,
    role,
    address.spur,
  );
  await insertComment(trx, subject, block.id, address.text, ctx, role, {
    conversationRef: input.conversation,
    messageRef: input.message,
  });
  const conversation = await insertConversation(trx, {
    gateway: input.gateway,
    ref: input.conversation,
    rootMessage: input.rootMessage,
    at: input.at,
    blockId: block.id,
  });
  if (conversation !== undefined)
    await advanceConversationCursor(trx, conversation, input.message, input.at);
  return true;
}
