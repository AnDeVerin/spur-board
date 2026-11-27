import {
  RESERVED_PROJECT,
  SPUR_REQUEST_TIMEOUT,
  type Config,
  type Via,
} from '@spur-board/contracts';
import { z } from 'zod';
import {
  BLOCK_KEY,
  DEFAULT_BRANCH_KEY,
  EXTERNAL_QUIET_ACTION,
  EXTERNAL_QUIET_KEY,
  isItemKind,
  ITEM_POLICY,
  itemBlockRef,
  itemSeverity,
  NO_SESSION_KEY,
  OPERATOR_BLOCK_KEY,
  SOURCE_KEY,
  type ItemKind,
} from '../domain/fromYou.ts';
import type { Row } from '../store/schema.ts';
import { authorize, isOperator, projectTarget } from './authorize.ts';
import type { Trx } from './board-utils.ts';
import { answeredVia, answeredViaColumn } from './blocks.ts';
import { itemSubjects } from './items.ts';
import { TASKLESS_ITEM_URL } from './item-raise.ts';
import {
  noSessionFields,
  noSessionText,
  waitingTurns,
  type NoSession,
} from './operator-inbox-no-session.ts';
import { deliveredRefSchema } from './outbox.ts';
import type { Query } from './queries.ts';

/** How far back `handled` reaches, and how many entries it keeps. */
const HANDLED_WINDOW_MS = 24 * 60 * 60 * 1000;
const HANDLED_MAX = 20;

type Item = Row<'operator_item'>;
type Owner = Pick<Row<'task'>, 'key' | 'project' | 'membership'>;
type SourceState = Pick<
  Row<'source_state'>,
  'source' | 'blind_reason' | 'blind_message' | 'failure_code'
>;
/** The task columns each read joins in, null when the row has no task. */
interface Joined {
  task_key: string | null;
  task_project: string | null;
  task_membership: Row<'task'>['membership'] | null;
}

interface Entry {
  id: string;
  project: string;
  kind: 'block' | ItemKind;
  severity: 'attention' | 'failure';
  text: string;
  action?: string;
  url?: string;
  at: string;
  task: string | null;
  column?: Row<'turn'>['column'];
  answeredVia?: Via | null;
  noSession?: NoSession;
  handledAt?: string;
}

/** The block an item refers to, as the batched read selects it. */
type Referenced = Pick<
  Row<'block'>,
  'id' | 'addressee_role' | 'project' | 'addressee_spur_project'
> &
  Joined;

/**
 * What the item names: the block it refers to, the task it is about and, for an ended holder of
 * an operator turn, that turn's `T<n>`.
 */
interface ActionContext {
  block: Referenced | undefined;
  task: Owner | null;
  operatorTurn?: string | undefined;
}

/** `B<n>` of the block an item refers to, else "its block". */
function blockName(item: Item): string {
  const ref = itemBlockRef(item);
  return ref === undefined ? 'its block' : `B${String(ref)}`;
}

const HEALTH_KEY = 'health:';
const WORKER_ENDED = 'start a new worker for the task, or archive the task';
const OBSERVATION_FALLBACK = 'check the task, then close the item';

/** The action of a `board_observation` item, chosen by its key prefix. */
function observationAction(item: Item): string {
  const key = item.item_key;
  if (key.startsWith('pr-outcome:'))
    return 'check the pull request, then close the item or archive the task';
  if (key.startsWith('lookup:'))
    return 'check the ticket in the tracker, then close the item or archive the task';
  if (key.startsWith(DEFAULT_BRANCH_KEY)) return 'open the failing run; fix or revert';
  if (key.startsWith(EXTERNAL_QUIET_KEY)) return EXTERNAL_QUIET_ACTION;
  if (key.startsWith(OPERATOR_BLOCK_KEY)) return `answer ${blockName(item)}`;
  if (key.startsWith(BLOCK_KEY))
    return `answer ${blockName(item)} if it is a question, or close it with a reason`;
  if (key.startsWith('filter:'))
    return 'return the ticket to the tracker filter, or finish or unlink the linked work';
  if (key.startsWith(HEALTH_KEY)) {
    // `health:<taskId>:<session>:<flag>`; the session id may itself hold `:`.
    const rest = key.slice(HEALTH_KEY.length);
    const first = rest.indexOf(':');
    const last = rest.lastIndexOf(':');
    const session = first < 0 || first === last ? '' : rest.slice(first + 1, last);
    if (session === '') return OBSERVATION_FALLBACK;
    return rest.slice(last + 1) === 'worker_vanished'
      ? WORKER_ENDED
      : `check session ${session} in Spur`;
  }
  return OBSERVATION_FALLBACK;
}

/**
 * What the operator does about an item, the end of its text. A failure says what to check; a
 * `source:` item gets its action from `sourceText`.
 */
const ACTIONS: Record<Exclude<ItemKind, 'turn'>, (item: Item, at: ActionContext) => string> = {
  transport_health: (item) =>
    `check the ${capitalized(item.item_key.slice('transport:'.length))} app tokens`,
  post_failed: () => 'check the chat gateway, then retry the item',
  inbound_failure: () => 'check the daemon log, then retry the item',
  inbound_gap: () => 'check the conversation for missed messages',
  answer_undelivered: () => 'check the asking session, then retry the item',
  worker_not_reading: () => 'check the worker session, then retry the item',
  token_request: () => 'approve or deny it in Slack within 15 minutes of the request',
  post_blocked: () => 'close the item once you have read it',
  answer_author_unavailable: (_item, { task }) =>
    task === null
      ? 'pass the answer to the asking session yourself, then close the item'
      : 'comment on the task so a live session reads the answer, then close the item',
  board_observation: observationAction,
  // A replacement worker cannot take an operator turn; the operator retakes it.
  worker_ended: (_item, { operatorTurn }) =>
    operatorTurn === undefined
      ? WORKER_ENDED
      : `retake ${operatorTurn} with board inbox ack ${operatorTurn} from the operator token or another operator session`,
  anomaly: (item) => `wait for the answer to ${blockName(item)}, or answer it yourself`,
  course_check: (item) => `wait for the answer to ${blockName(item)}, or answer it yourself`,
  cycle_limit: (item) => `answer or close ${blockName(item)} to reset the cycle count`,
  conversation_waiting: (item, { block }) =>
    `start a session in ${block?.addressee_spur_project ?? 'its Spur project'}, or close ${blockName(item)} with a reason`,
};

const PROBLEMS: Partial<Record<string, string>> = {
  auth: 'auth failed',
  config: 'config rejected',
  stale: 'unreachable',
};

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function serviceOf(source: string): string | undefined {
  if (source === 'spur') return 'Spur';
  if (
    source.startsWith('github:') ||
    source.startsWith('github-issues:') ||
    source.startsWith('github-project:')
  )
    return 'GitHub';
  return source.startsWith('jira:') ? 'Jira' : undefined;
}

const externalUrlSchema = z.url({ protocol: /^https?$/ });

/** Only structured destinations count; the task-less feed placeholder is never navigation. */
function meaningfulUrl(value: string): string | undefined {
  if (!externalUrlSchema.safeParse(value).success) return undefined;
  const url = new URL(value);
  if (url.origin === TASKLESS_ITEM_URL && url.pathname === '/') return undefined;
  return url.href;
}

function deliveredUrl(value: string | null): string | undefined {
  if (value === null) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  const ref = deliveredRefSchema.safeParse(decoded);
  return ref.success ? meaningfulUrl(ref.data.permalink) : undefined;
}

function deliveryId(item: Item): number | undefined {
  if (item.kind !== 'post_failed' || !/^delivery:[1-9]\d*$/.test(item.item_key)) return undefined;
  const id = Number(item.item_key.slice('delivery:'.length));
  return Number.isSafeInteger(id) ? id : undefined;
}

/** One batched join, including only the immediate parent of each failed delivery. */
async function deliveryUrls(trx: Trx, items: readonly Item[]) {
  const ids = items.flatMap((item) => deliveryId(item) ?? []);
  if (ids.length === 0) return new Map<number, string | undefined>();
  const rows = await trx
    .selectFrom('outbox')
    .leftJoin('outbox as parent', 'parent.id', 'outbox.parent_outbox_id')
    .select(['outbox.id', 'outbox.external_ref', 'parent.external_ref as parent_ref'])
    .where('outbox.id', 'in', ids)
    .execute();
  return new Map(
    rows.map((row) => [row.id, deliveredUrl(row.external_ref) ?? deliveredUrl(row.parent_ref)]),
  );
}

function itemUrl(item: Item, deliveries: Map<number, string | undefined>): string | undefined {
  if (item.item_key.startsWith(SOURCE_KEY)) {
    const service = serviceOf(item.item_key.slice(SOURCE_KEY.length));
    if (service === 'GitHub')
      return 'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api';
    if (service === 'Jira')
      return 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro';
    return undefined;
  }
  const id = deliveryId(item);
  return id === undefined ? meaningfulUrl(item.url) : deliveries.get(id);
}

/**
 * The text of a source item: built from the source's state while it is open and blind; a cleared
 * or unknown one keeps its stored text, which names the failure it had.
 */
function sourceText(
  item: Item,
  state: SourceState | undefined,
): { condition: string; action: string } {
  const source = item.item_key.slice(SOURCE_KEY.length);
  const stored = { condition: item.text, action: `check the ${source} source` };
  const reason = state?.blind_reason ?? null;
  const service = serviceOf(source);
  if (item.cleared_at !== null || reason === null || service === undefined) return stored;
  const problem = PROBLEMS[reason];
  const thing =
    reason === 'auth'
      ? `the ${service} token`
      : reason === 'config'
        ? `the ${source} settings in the board config`
        : reason === 'stale' && source === 'spur'
          ? state?.failure_code === SPUR_REQUEST_TIMEOUT
            ? 'tracked session count and host load'
            : 'the Spur daemon'
          : undefined;
  if (problem === undefined || thing === undefined) return stored;
  const message = state?.blind_message ?? null;
  return {
    condition: `${service} ${problem}${message === null ? '' : ` (${message})`}`,
    action: `check ${thing}`,
  };
}

const ENDED_TURN_KEY = 'ended-turn:';

/** The turn id an `ended-turn:<turnId>:<session>` key names. */
const endedTurnId = (key: string) => Number(key.slice(ENDED_TURN_KEY.length).split(':')[0]);

/** Turn ids of the operator turns that `ended-turn:` items name: one batched read. */
async function endedOperatorTurns(trx: Trx, items: readonly Item[]): Promise<Set<number>> {
  const ids = items.flatMap((item) =>
    item.item_key.startsWith(ENDED_TURN_KEY) ? [endedTurnId(item.item_key)] : [],
  );
  if (ids.length === 0) return new Set();
  const rows = await trx
    .selectFrom('turn')
    .select('id')
    .where('id', 'in', ids)
    .where('role', '=', 'operator')
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** Newest first by `at`, ties by id as text. */
function newestFirst(at: (entry: Entry) => string) {
  return (left: Entry, right: Entry) =>
    at(right).localeCompare(at(left)) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function owner(row: Joined): Owner | null {
  return row.task_key === null || row.task_project === null || row.task_membership === null
    ? null
    : { key: row.task_key, project: row.task_project, membership: row.task_membership };
}

const taskColumns = [
  'task.key as task_key',
  'task.project as task_project',
  'task.membership as task_membership',
] as const;

/**
 * The operator's inbox across every project the caller is operator of: open operator items,
 * blocks addressed to the operator and operator turns, and what of them was handled in the last
 * day. A block or turn is listed once, without the items that mirror it.
 */
export function createOperatorInbox(deps: {
  config: Config;
  clock: { now(): number };
}): Query<'inbox.operator'> {
  const { config, clock } = deps;
  const configured = new Set(config.projects.map((project) => project.id));
  /** A project-level block's project, or `_board` once the project has left the config. */
  const blockProject = (project: string | null) =>
    project !== null && configured.has(project) ? project : RESERVED_PROJECT;
  return {
    id: 'inbox.operator',
    resolveTargets(_trx, _input, actor) {
      return Promise.resolve(
        config.projects
          .filter((project) => isOperator(actor, config, project.id))
          .map((project) => projectTarget(project.id)),
      );
    },
    async run(trx, _input, actor) {
      const since = new Date(clock.now() - HANDLED_WINDOW_MS).toISOString();
      const boardScope =
        authorize([{ grant: 'operator' }], actor, { config, target: { kind: 'missing' } })
          .status === 'allowed';
      const operatorProjects = new Set(
        config.projects
          .filter((project) => isOperator(actor, config, project.id))
          .map((project) => project.id),
      );
      const visible = (entry: Entry) =>
        entry.project === RESERVED_PROJECT ? boardScope : operatorProjects.has(entry.project);
      const [openItems, clearedItems, openBlocks, closedBlocks, openTurns, closedTurns] =
        await Promise.all([
          itemRows(trx).where('operator_item.cleared_at', 'is', null).execute(),
          itemRows(trx)
            .where('operator_item.cleared_at', '>=', since)
            .orderBy('operator_item.cleared_at')
            .orderBy('operator_item.id')
            .execute(),
          blockRows(trx).where('block.state', '=', 'open').execute(),
          blockRows(trx)
            .select(answeredViaColumn)
            .where('block.state', '=', 'unblocked')
            .where('block.unblocked_at', '>=', since)
            .execute(),
          turnRows(trx).where('turn.closed_at', 'is', null).execute(),
          turnRows(trx).where('turn.closed_at', '>=', since).execute(),
        ]);
      // One row per key: an open one wins, else the last cleared one (rows come oldest first).
      const openKeys = new Set(openItems.map((item) => item.item_key));
      const lastCleared = new Map<string, (typeof clearedItems)[number]>();
      for (const item of clearedItems) {
        if (openKeys.has(item.item_key)) continue;
        lastCleared.set(item.item_key, item);
      }
      const items = [...openItems, ...lastCleared.values()];
      const blockIds = [...new Set(items.flatMap((item) => itemBlockRef(item) ?? []))];
      const sourceIds = items.flatMap((item) =>
        item.item_key.startsWith(SOURCE_KEY) ? [item.item_key.slice(SOURCE_KEY.length)] : [],
      );
      const [referenced, subjects, sources, deliveries, waiting, operatorTurns] = await Promise.all(
        [
          blockIds.length === 0
            ? Promise.resolve([])
            : trx
                .selectFrom('block')
                .leftJoin('task', 'task.id', 'block.task_id')
                .select([
                  'block.id',
                  'block.addressee_role',
                  'block.project',
                  'block.addressee_spur_project',
                  ...taskColumns,
                ])
                .where('block.id', 'in', blockIds)
                .execute(),
          itemSubjects(trx, items, config),
          sourceIds.length === 0
            ? Promise.resolve([])
            : trx
                .selectFrom('source_state')
                .select(['source', 'blind_reason', 'blind_message', 'failure_code'])
                .where('source', 'in', sourceIds)
                .execute(),
          deliveryUrls(trx, items),
          waitingTurns(trx, openItems),
          endedOperatorTurns(trx, items),
        ],
      );
      const blockById = new Map(referenced.map((block) => [block.id, block]));
      const sourceById = new Map(sources.map((state) => [state.source, state]));

      const operatorTurnOf = (item: Item) => {
        if (!item.item_key.startsWith(ENDED_TURN_KEY)) return undefined;
        const id = endedTurnId(item.item_key);
        return operatorTurns.has(id) ? `T${String(id)}` : undefined;
      };
      const itemEntry = (item: Item & Joined): Entry | undefined => {
        const kind = item.kind;
        if (!isItemKind(kind) || kind === 'turn') return undefined;
        const ref = itemBlockRef(item);
        const block = ref === undefined ? undefined : blockById.get(ref);
        // The operator block itself is listed; its ledger and board items are not.
        if (
          block?.addressee_role === 'operator' &&
          (ITEM_POLICY[kind].block ||
            item.item_key.startsWith(OPERATOR_BLOCK_KEY) ||
            item.item_key.startsWith(BLOCK_KEY))
        )
          return undefined;
        const subject = subjects.get(item.id);
        const task = subject?.task ?? null;
        if (task?.membership === 'archived') return undefined;
        const noSession = kind === 'board_observation' && item.item_key.startsWith(NO_SESSION_KEY);
        const { condition, action } = item.item_key.startsWith(SOURCE_KEY)
          ? sourceText(item, sourceById.get(item.item_key.slice(SOURCE_KEY.length)))
          : noSession
            ? noSessionText(item, config, waiting, clock.now())
            : {
                condition: item.text,
                action: ACTIONS[kind](item, { block, task, operatorTurn: operatorTurnOf(item) }),
              };
        const url = itemUrl(item, deliveries);
        const fields = noSession ? noSessionFields(item, task?.key, config, waiting) : undefined;
        return {
          id: `I${String(item.id)}`,
          project: subject?.project ?? RESERVED_PROJECT,
          kind,
          severity: itemSeverity(kind, item.item_key),
          text: `${condition}: ${action}`,
          action,
          at: item.raised_at,
          task: task?.key ?? null,
          ...(url === undefined ? {} : { url }),
          ...(fields === undefined ? {} : { noSession: fields }),
          ...(item.cleared_at === null ? {} : { handledAt: item.cleared_at }),
        };
      };
      const blockEntry = (block: Row<'block'> & Joined, via: Via | null): Entry | undefined => {
        const task = owner(block);
        if (task?.membership === 'archived') return undefined;
        return {
          id: `B${String(block.id)}`,
          project: task?.project ?? blockProject(block.project),
          kind: 'block',
          severity: 'attention',
          text: block.reason,
          at: block.created_at,
          task: task?.key ?? null,
          answeredVia: via,
          ...(block.unblocked_at === null || block.state === 'open'
            ? {}
            : { handledAt: block.unblocked_at }),
        };
      };
      const turnEntry = (turn: Row<'turn'> & Joined): Entry | undefined => {
        const task = owner(turn);
        if (task === null || task.membership === 'archived') return undefined;
        return {
          id: `T${String(turn.id)}`,
          project: task.project,
          kind: 'turn',
          severity: 'attention',
          text: `Your turn T${String(turn.id)}: ${turn.reason}`,
          at: turn.created_at,
          task: task.key,
          column: turn.column,
          ...(turn.closed_at === null ? {} : { handledAt: turn.closed_at }),
        };
      };
      const listed = (entries: (Entry | undefined)[]) =>
        entries.filter((entry): entry is Entry => entry !== undefined && visible(entry));
      const open = listed([
        ...openItems.map(itemEntry),
        ...openBlocks.map((block) => blockEntry(block, null)),
        ...openTurns.map(turnEntry),
      ]).sort(newestFirst((entry) => entry.at));
      const handled = listed([
        ...[...lastCleared.values()].map(itemEntry),
        ...closedBlocks.map(({ answered_via, ...block }) =>
          blockEntry(block, answeredVia(answered_via)),
        ),
        ...closedTurns.map(turnEntry),
      ])
        .sort(newestFirst((entry) => entry.handledAt ?? entry.at))
        .slice(0, HANDLED_MAX);
      return {
        items: open,
        handled: handled.map(({ handledAt, ...entry }) => ({
          ...entry,
          handledAt: handledAt ?? entry.at,
        })),
      };
    },
  };
}

function itemRows(trx: Trx) {
  return trx
    .selectFrom('operator_item')
    .leftJoin('task', 'task.id', 'operator_item.task_id')
    .selectAll('operator_item')
    .select(taskColumns);
}

function blockRows(trx: Trx) {
  return trx
    .selectFrom('block')
    .leftJoin('task', 'task.id', 'block.task_id')
    .selectAll('block')
    .select(taskColumns)
    .where('block.addressee_role', '=', 'operator');
}

function turnRows(trx: Trx) {
  return trx
    .selectFrom('turn')
    .innerJoin('task', 'task.id', 'turn.task_id')
    .selectAll('turn')
    .select(taskColumns)
    .where('turn.role', '=', 'operator');
}
