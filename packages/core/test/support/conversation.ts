import {
  configSchema,
  conversationRefSchema,
  messageRefSchema,
  userIdSchema,
  type Config,
  type ConfigInput,
  type InboundEvent,
  type SpaceId,
} from '@spur-board/contracts';
import { openOperatorConversation } from '../../src/app/operator-conversation.ts';
import { scanTransaction } from '../../src/app/secrets.ts';
import type { Store } from '../../src/index.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { openTempStore } from './store.ts';
import { SLACK_ON } from './config.ts';

export const CONVERSATION_AT = '2026-11-03T10:00:00.000Z';

/**
 * Board `proj` (tracker `o/r`) with worker `web`, curator `cur` (`@cur`), column orchestrator
 * `qa` (`@qa`, the default addressee) and operator-role `board-pm`; board `other` (tracker `x/y`)
 * has worker `remote`. `defaultAddressee: null` drops the default, `shortNames: false` every
 * short name, `operator: false` the operator `board-pm`; `spurProjects` sets top-level entries.
 */
export function conversationConfig(
  options: {
    defaultAddressee?: string | null;
    shortNames?: boolean;
    operator?: boolean;
    spurProjects?: ConfigInput['spurProjects'];
  } = {},
): Config {
  const {
    defaultAddressee = 'qa',
    shortNames = true,
    operator = true,
    spurProjects = [],
  } = options;
  const short = (name: string) => (shortNames ? { shortName: name } : {});
  return configSchema.parse({
    projects: [
      {
        id: 'proj',
        tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
        repos: ['o/r'],
        operatorGithubLogin: 'operator',
        spurProjects: [
          { name: 'web', role: 'worker' },
          { name: 'cur', role: 'curator', ...short('cur') },
          { name: 'qa', role: 'orchestrator', ...short('qa') },
          ...(operator ? [{ name: 'board-pm', role: 'operator' as const }] : []),
        ],
        columns: [
          { id: 'todo', orchestrator: 'none' },
          { id: 'ready-for-dev', orchestrator: 'none' },
          { id: 'dev', orchestrator: 'qa' },
          { id: 'review', orchestrator: 'none' },
          { id: 'qa', orchestrator: 'none' },
          { id: 'ready-to-merge', orchestrator: 'none' },
          { id: 'done', orchestrator: 'none' },
        ],
      },
      {
        id: 'other',
        tracker: { type: 'github-issues', repo: 'x/y', milestone: 'M1' },
        repos: ['x/y'],
        operatorGithubLogin: 'operator',
        spurProjects: [{ name: 'remote', role: 'worker' }],
      },
    ],
    spurProjects,
    operator: { slack: 'operator' },
    digest: { tz: 'UTC' },
    slack: defaultAddressee === null || !shortNames ? SLACK_ON : { ...SLACK_ON, defaultAddressee },
  });
}

/** A store with `o/r#101` (id 1, active, in dev), `o/r#102` (archived) and `x/y#5` in `other`. */
export async function conversationStore(): Promise<{ store: Store; file: string }> {
  const opened = openTempStore('core-conversation-');
  await opened.store.transaction(async (trx) => {
    const task = { ...sampleRows.task, archive_reason: null, column: 'dev' as const };
    await trx
      .insertInto('task')
      .values([
        { ...task, id: 1, key: 'o/r#101', tracker_id: '101', membership: 'active' },
        {
          ...task,
          id: 2,
          key: 'o/r#102',
          tracker_id: '102',
          membership: 'archived',
          archive_reason: sampleRows.task.archive_reason,
        },
        { ...task, id: 3, project: 'other', key: 'x/y#5', tracker_id: '5', membership: 'active' },
      ])
      .execute();
  });
  return opened;
}

/** A live Spur session `id` of Spur project `spur`, waiting at its prompt so rings go out. */
export async function liveSession(store: Store, id: string, spur: string): Promise<void> {
  await store.db
    .insertInto('session_snapshot')
    .values({
      ...sampleRows.session_snapshot,
      id,
      spur_project: spur,
      ended_at: null,
      end_reason: null,
      absent_since: null,
      first_seen: CONVERSATION_AT,
      detail: JSON.stringify({
        id,
        spurProject: spur,
        branch: null,
        pr: null,
        links: {},
        lifecycle: 'running',
        health: 'waiting',
        healthSince: CONVERSATION_AT,
        lastActivityAt: null,
        endedAt: null,
        endReason: null,
      }),
    })
    .execute();
}

/** The operator's new message `n` in `space`: its own conversation and root. */
export function topLevel(
  text: string,
  n = 1,
  space: SpaceId | null = 'orchestrators',
): Extract<InboundEvent, { kind: 'message' }> {
  const ref = `top-${String(n)}`;
  return {
    kind: 'message',
    dedupeKey: ref,
    conversation: conversationRefSchema.parse(ref),
    message: messageRefSchema.parse(ref),
    rootMessage: messageRefSchema.parse(ref),
    sourceUrl: `https://example.test/${ref}`,
    author: userIdSchema.parse('operator'),
    text,
    at: CONVERSATION_AT,
    sourceSpace: space,
  };
}

/** The operator's reply `n` in the thread of top-level message `thread`. */
export function threadReply(
  text: string,
  n: number,
  thread = 1,
): Extract<InboundEvent, { kind: 'message' }> {
  const root = `top-${String(thread)}`;
  const ref = `${root}-reply-${String(n)}`;
  return {
    kind: 'message',
    dedupeKey: ref,
    conversation: conversationRefSchema.parse(root),
    message: messageRefSchema.parse(ref),
    rootMessage: messageRefSchema.parse(root),
    sourceUrl: `https://example.test/${ref}`,
    author: userIdSchema.parse('operator'),
    text,
    at: CONVERSATION_AT,
  };
}

/** Opens the conversation `text` starts as top-level message `n`, without the inbound path. */
export async function startConversation(
  store: Store,
  config: Config,
  text: string,
  n = 1,
): Promise<void> {
  const event = topLevel(text, n);
  await scanTransaction(store, config, (trx) =>
    openOperatorConversation(trx, {
      text,
      conversation: event.conversation,
      message: event.message,
      rootMessage: event.rootMessage,
      gateway: 'fake',
      at: CONVERSATION_AT,
      config,
    }),
  );
}
