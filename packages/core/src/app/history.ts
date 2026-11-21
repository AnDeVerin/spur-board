import {
  EVENT_KINDS,
  eventPayloadSchemas,
  prFactsSchema,
  sessionFactsSchema,
  ticketFactsSchema,
  VIAS,
  type EventKind,
} from '@spur-board/contracts';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import { VERDICT } from '../domain/gates.ts';
import type { EventTable } from '../store/schema.ts';
import { eventActor } from './board-utils.ts';
import { END_WORDS } from './status.ts';
import { turnSummary } from './task-turns.ts';

/** The text of a row whose payload does not parse, or of a kind without a payload summary. */
const EVENT_SUMMARIES = {
  head_moved: 'Pull request head moved',
  pr_facts_changed: 'Pull request facts changed',
  checks_changed: 'Checks changed',
  review_submitted: 'Review submitted',
  mergeable_changed: 'Mergeability changed',
  pr_state_changed: 'Pull request state changed',
  ticket_status_changed: 'Ticket status changed',
  ticket_facts_changed: 'Ticket facts changed',
  session_state_changed: 'Session state changed',
  session_facts_changed: 'Session facts changed',
  spur_unknown_state: 'Unknown session state observed',
  link_added: 'Link added',
  link_removed: 'Link removed',
  task_added: 'Task added',
  task_archived: 'Task archived',
  task_submitted: 'Turn submitted',
  task_moved: 'Task moved',
  task_shadow_moved: 'Shadow move',
  task_corrected: 'Column corrected by the operator',
  task_manually_moved: 'Task manually moved by the operator',
  task_mirror_moved: 'Task moved by the GitHub Project mirror',
  task_reordered: 'Task reordered',
  external_round: 'External change-request round',
  dispatcher_mode_changed: 'Dispatcher mode changed',
  turn_opened: 'Turn opened',
  turn_taken: 'Turn taken',
  turn_closed: 'Turn closed',
  turn_wait_started: 'Turn wait started',
  turn_wait_ended: 'Turn wait ended',
  block_opened: 'Block opened',
  block_escalated: 'Block escalated',
  block_unblocked: 'Block unblocked',
  comment_added: 'Comment added',
  comment_edited: 'Comment edited',
  comment_deleted: 'Comment deleted',
  comment_acked: 'Comment acknowledged',
  doorbell_rung: 'Doorbell rung',
  doorbell_read: 'Doorbell read',
  doorbell_undelivered: 'Doorbell delivery exhausted',
  inbound_failed: 'Inbound message failed',
  inbound_skipped: 'Inbound message skipped',
  from_you_raised: 'Operator item raised',
  from_you_cleared: 'Operator item cleared',
  flag_raised: 'Flag raised',
  flag_cleared: 'Flag cleared',
  operation_denied: 'Operation denied',
  token_requested: 'Token requested',
  token_approved: 'Token approved',
  token_denied: 'Token denied',
  token_expired: 'Token expired',
  token_revoked: 'Token revoked',
} satisfies Record<EventKind, string>;

/** How many changes a facts row names before `+N more`. */
const NAMED_CHANGES = 3;

type FactKind = 'pr' | 'session' | 'ticket';

/**
 * Fields a facts row never names, per kind: heartbeats (`updatedAt`, `lastActivityAt`), and
 * fields an own event row already says (`head_moved`, `checks_changed`, `ticket_status_changed`
 * and the rest), or that only time one (`healthSince`).
 */
const UNNAMED: Record<FactKind, ReadonlySet<string>> = {
  pr: new Set([
    'updatedAt',
    'headSha',
    'checks',
    'requiredChecks',
    'state',
    'mergeable',
    'reviews',
    'mergedAt',
    'closedAt',
  ]),
  session: new Set(['lastActivityAt', 'healthSince']),
  ticket: new Set(['updatedAt', 'status']),
};

const FIELDS: Record<FactKind, readonly string[]> = {
  pr: prFactsSchema.keyof().options,
  session: sessionFactsSchema.keyof().options,
  ticket: ticketFactsSchema.keyof().options,
};

const checksSchema = z.tuple([prFactsSchema.shape.checks, prFactsSchema.shape.requiredChecks]);

type Facts = Readonly<Record<string, unknown>>;
type Payload<K extends EventKind> = z.output<(typeof eventPayloadSchemas)[K]>;

/** One parsed facts payload: which entity it is about and how its rows start. */
interface Entity {
  kind: FactKind;
  key: string;
  prefix: string;
  facts: Facts;
}

function payloadOf<K extends EventKind>(kind: K, payloadText: string) {
  const payload = eventPayloadSchemas[kind].safeParse(parsedJson(payloadText));
  return payload.success ? (payload.data as Payload<K>) : null;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** ` +N more` for the items past the first `NAMED_CHANGES` of `count`. */
const more = (count: number) =>
  count > NAMED_CHANGES ? ` +${String(count - NAMED_CHANGES)} more` : '';
const ref = (repo: string, pr: number) => `${repo}#${String(pr)}`;
const from = (value: string | null, to: string) =>
  value === null || value === to ? to : `${value} → ${to}`;
const label = (field: string) => field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
const shown = (value: unknown) =>
  value === null || value === undefined
    ? 'none'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
const endWords = (reason: unknown) => {
  const value = sessionFactsSchema.shape.endReason.safeParse(reason);
  return value.success && value.data !== null ? END_WORDS[value.data] : null;
};

function prEntity(facts: z.output<typeof prFactsSchema>): Entity {
  return {
    kind: 'pr',
    key: `pr:${facts.repo.toLowerCase()}#${String(facts.number)}`,
    prefix: `PR ${ref(facts.repo, facts.number)}`,
    facts,
  };
}

function sessionEntity(facts: z.output<typeof sessionFactsSchema>): Entity {
  return { kind: 'session', key: `session:${facts.id}`, prefix: `Session ${facts.id}`, facts };
}

/** The entity a facts row or a link with facts carries, or null for any other row. */
function factsEntity(kind: EventKind, payloadText: string): Entity | null {
  if (kind === 'pr_facts_changed') {
    const payload = payloadOf(kind, payloadText);
    return payload === null ? null : prEntity(payload.facts);
  }
  if (kind === 'session_facts_changed') {
    const payload = payloadOf(kind, payloadText);
    return payload === null ? null : sessionEntity(payload.facts);
  }
  if (kind === 'ticket_facts_changed') {
    const payload = payloadOf(kind, payloadText);
    if (payload === null) return null;
    const { facts } = payload;
    return {
      kind: 'ticket',
      key: `ticket:${facts.trackerId}:${facts.id}`,
      prefix: `Ticket ${facts.key}`,
      facts,
    };
  }
  if (kind === 'link_added') {
    const payload = payloadOf(kind, payloadText);
    if (payload?.entity === 'pr' && payload.facts !== undefined) return prEntity(payload.facts);
    if (payload?.entity === 'session' && payload.facts !== undefined)
      return sessionEntity(payload.facts);
  }
  return null;
}

/** One changed field in the words of a history row. */
function changeText(field: string, before: unknown, after: unknown): string {
  const name = label(field);
  switch (field) {
    case 'draft':
      return after === true ? 'ready → draft' : 'draft → ready';
    case 'feedbackComplete':
      return after === true ? 'feedback complete' : 'feedback incomplete';
    case 'inFilter':
      return after === true ? 'in filter' : 'out of filter';
    case 'endReason': {
      const words = endWords(after);
      return words === null ? 'end cleared' : `ended (${words})`;
    }
    case 'reviewThreads': {
      const unresolved = (value: unknown) => {
        const threads = prFactsSchema.shape.reviewThreads.safeParse(value);
        return threads.success ? threads.data.filter((thread) => !thread.resolved).length : 0;
      };
      const [a, b] = [unresolved(before), unresolved(after)];
      return a === b ? 'threads changed' : `unresolved threads ${String(a)} → ${String(b)}`;
    }
    case 'pr': {
      const pr = (value: unknown) => {
        const linked = sessionFactsSchema.shape.pr.safeParse(value);
        return linked.success && linked.data !== null
          ? ref(linked.data.repo, linked.data.number)
          : 'none';
      };
      return `PR ${pr(before)} → ${pr(after)}`;
    }
    case 'title':
    case 'url':
      return `${name} changed`;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const length = (value: unknown) => (Array.isArray(value) ? String(value.length) : 'none');
    return length(before) === length(after)
      ? `${name} changed`
      : `${name} ${length(before)} → ${length(after)}`;
  }
  const object = (value: unknown) => typeof value === 'object' && value !== null;
  if (object(before) || object(after)) return `${name} changed`;
  return `${name} ${shown(before)} → ${shown(after)}`;
}

/**
 * The summary of a facts row against the entity's previous facts on this task, or null when it
 * changes nothing a row names.
 */
function factsSummary(entity: Entity, previous: Facts | undefined): string | null {
  if (previous === undefined) return `${entity.prefix}: first observed`;
  const unnamed = UNNAMED[entity.kind];
  const changed = FIELDS[entity.kind].filter(
    (field) =>
      !unnamed.has(field) &&
      JSON.stringify(previous[field]) !== JSON.stringify(entity.facts[field]),
  );
  const named = changed.includes('endReason')
    ? changed.filter((field) => field !== 'endedAt')
    : changed;
  if (named.length === 0) return null;
  const texts = named
    .slice(0, NAMED_CHANGES)
    .map((field) => changeText(field, previous[field], entity.facts[field]));
  return `${entity.prefix}: ${texts.join(', ')}${more(named.length)}`;
}

/**
 * `Checks on <ref>:` with the failed names, or the green and pending counts. A cancelled check the
 * row names as `waiting` counts as pending; a clause names the cancels this poll confirmed, then
 * the ones still waiting.
 */
function checksSummary(payload: Payload<'checks_changed'>) {
  const lists = checksSchema.safeParse(parsedJson(payload.to));
  if (!lists.success) return null;
  const [checks, requiredChecks] = lists.data;
  const list =
    requiredChecks.length > 0
      ? requiredChecks
      : checks.filter((check) => check.state !== 'skipped');
  const head = `Checks on ${ref(payload.repo, payload.pr)}`;
  if (list.length === 0) return `${head}: none`;
  const waiting = new Set(payload.waiting);
  const isWaiting = (check: (typeof list)[number]) =>
    check.state === 'cancelled' && waiting.has(check.name);
  const clause = (names: readonly string[] | undefined, text: string) => {
    const counted = [...new Set(names)].filter((name) =>
      list.some((check) => check.state === 'cancelled' && check.name === name),
    );
    return counted.length === 0
      ? ''
      : `; ${counted.slice(0, NAMED_CHANGES).join(', ')}${more(counted.length)} cancelled, ${text}`;
  };
  const clauses =
    clause(payload.confirmed, 'now counts as red') +
    clause(payload.waiting, 'waiting for a new run');
  const failed = list
    .filter((check) => VERDICT[check.state] === 'red' && !isWaiting(check))
    .map(({ name }) => name);
  if (failed.length > 0)
    return `${head}: ${String(failed.length)} failed: ${failed.slice(0, NAMED_CHANGES).join(', ')}${more(failed.length)}${clauses}`;
  const green = list.filter((check) => VERDICT[check.state] === 'green').length;
  const pending = list.length - green;
  return `${head}: ${String(green)}/${String(list.length)} green${pending > 0 ? `, ${String(pending)} pending` : ''}${clauses}`;
}

const gates = (gate: readonly string[] | undefined) =>
  gate === undefined || gate.length === 0 ? '' : ` (${gate.join(', ')})`;

const optional = (prefix: string, value: string | undefined) =>
  value === undefined ? '' : `${prefix}${value}`;

/** Summaries built from a row's payload; null falls back to the fixed text. */
const SUMMARIES: { [K in EventKind]?: (payload: Payload<K>) => string | null } = {
  task_manually_moved: (p) => `Manually moved ${p.from} → ${p.to}: ${p.reason}`,
  task_mirror_moved: (p) =>
    `Mirror moved ${p.from} → ${p.to}${p.shadow === true ? ' (shadow mode)' : ''}: ${p.source}`,
  session_state_changed: (p) =>
    `Session ${p.session}: ${from(p.from, p.to)}${optional(', ended (', p.endReason === undefined ? undefined : `${END_WORDS[p.endReason]})`)}`,
  checks_changed: checksSummary,
  head_moved: (p) => `New head ${p.to.slice(0, 7)} on ${ref(p.repo, p.pr)}`,
  mergeable_changed: (p) => `Mergeable on ${ref(p.repo, p.pr)}: ${from(p.from, p.to)}`,
  pr_state_changed: (p) => `PR ${ref(p.repo, p.pr)}: ${from(p.from, p.to)}`,
  ticket_status_changed: (p) => `Ticket status: ${from(p.from, p.to)}`,
  review_submitted: (p) => `Review by ${p.reviewer} on ${ref(p.repo, p.pr)}: ${p.state}`,
  external_round: (p) =>
    `External change request by ${p.reviewer} on ${ref(p.repo, p.pr)} at ${p.head.slice(0, 7)}: a course-check round`,
  task_moved: (p) => `Moved ${p.from} → ${p.to}${optional(': ', p.reason)}${gates(p.gate)}`,
  task_shadow_moved: (p) =>
    `Would move ${p.from} → ${p.to} (shadow mode): ${p.reason}${gates(p.gate)}${p.courseCheck === true ? ', with a course check' : ''}`,
  block_opened: (p) => `Block ${p.block} opened: ${p.type} for ${p.addressee}`,
  block_escalated: (p) =>
    `Block ${p.block} escalated from ${p.from} to ${p.to}${optional(': ', p.reason)}`,
  block_unblocked: (p) => `Block ${p.block} unblocked: ${p.outcome}${optional(', ', p.reason)}`,
  comment_added: (p) =>
    `Comment ${p.comment} for ${p.addressee}${optional(', forwarded from ', p.forwardedFrom)}`,
  comment_edited: (p) =>
    `Comment ${p.comment} edited, revision ${String(p.revision)}${p.clarification ? ', clarification' : ''}`,
  turn_wait_started: (p) => `Turn ${p.turn} waits until ${p.until}: ${p.reason}`,
  turn_wait_ended: (p) => `Turn ${p.turn} wait ended: ${p.outcome}`,
  comment_deleted: (p) => `Comment ${p.comment} deleted`,
  comment_acked: (p) => `Comment ${p.comment} acknowledged`,
  doorbell_rung: (p) =>
    `Doorbell rung: ${p.doorbell} for ${p.addressee}, attempt ${String(p.attempt)}`,
  doorbell_read: (p) => `Doorbell read: ${p.doorbell}`,
  doorbell_undelivered: (p) => `Doorbell delivery exhausted: ${p.doorbell}, ${p.reason}`,
  link_added: (p) => linkSummary('Link added', p),
  link_removed: (p) => linkSummary('Link removed', p),
  // A submit whose head the board's newest poll confirmed, that waits for one, or that a merge at
  // another head superseded.
  task_submitted: (p) => {
    if (p.supersededByMerge !== undefined)
      return `Submit of ${p.sha.slice(0, 7)} superseded: PR merged at ${p.supersededByMerge.slice(0, 7)}`;
    const confirmation =
      p.pending === true
        ? ', pending confirmation'
        : p.confirmedByPoll === true
          ? ' on the head of the last poll'
          : '';
    return `Turn submitted${confirmation}: ${p.sha}, basis ${p.basis ?? 'tested'}${optional(', from ', p.from)}${optional(', tested origin ', p.testedOrigin)}${optional(' — ', p.reason)}`;
  },
};

function linkSummary(verb: string, p: Payload<'link_added'> | Payload<'link_removed'>) {
  const target =
    p.entity === 'pr' ? ref(p.repo, p.pr) : p.entity === 'session' ? p.session : p.ticket;
  return `${verb}: ${p.entity} ${target}${optional(' — ', p.reason)}`;
}

function summaryOf<K extends EventKind>(
  kind: K,
): ((payload: Payload<K>) => string | null) | undefined {
  return SUMMARIES[kind];
}

/** The summary built from a row's payload, or null to fall back to the fixed text. */
function payloadSummary(kind: EventKind, payloadText: string): string | null {
  const summarize = summaryOf(kind);
  if (summarize === undefined) return turnSummary(kind, payloadText);
  const payload = payloadOf(kind, payloadText);
  return payload === null ? null : summarize(payload);
}

/**
 * The rows `task.history` shows for a task's events, read in journal order: each with a summary of
 * what changed, facts rows diffed against the entity's previous facts on the task. A facts row with
 * nothing to name is left out but still moves the baseline. Rows come back by time, then journal
 * order.
 */
export function historyEvents(rows: readonly Selectable<EventTable>[]) {
  const previous = new Map<string, Facts>();
  const events = rows.flatMap((row) => {
    const kind = EVENT_KINDS.find((candidate) => candidate === row.kind);
    // A manual reorder changes only the column order, which History does not show.
    if (kind === undefined || kind === 'task_reordered') return [];
    const entity = factsEntity(kind, row.payload);
    let summary: string | null;
    if (entity !== null && kind !== 'link_added') {
      const text = factsSummary(entity, previous.get(entity.key));
      previous.set(entity.key, entity.facts);
      if (text === null) return [];
      summary = text;
    } else {
      if (entity !== null) previous.set(entity.key, entity.facts);
      summary = payloadSummary(kind, row.payload);
    }
    const via = VIAS.find((value) => value === row.via);
    return [
      {
        id: row.id,
        time: Date.parse(row.at),
        event: {
          at: row.at,
          kind,
          actor: eventActor(row),
          ...(via === undefined ? {} : { via }),
          summary: (summary ?? EVENT_SUMMARIES[kind]).replace(/\s+/g, ' ').trim(),
        },
      },
    ];
  });
  return events
    .sort((left, right) => left.time - right.time || left.id - right.id)
    .map(({ event }) => event);
}
