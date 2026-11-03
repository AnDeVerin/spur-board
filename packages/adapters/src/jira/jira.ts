import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type PollContext,
  type TicketEntityRef,
  type TicketFacts,
} from '@spur-board/contracts';
import { classifyHttpFailure } from '../runner/http.ts';

type JiraTracker = Extract<Config['projects'][number]['tracker'], { type: 'jira' }>;
type JsonObject = Record<string, unknown>;

export interface JiraAdapterOptions {
  id: string;
  tracker: () => JiraTracker;
  credentials: { email: string; token: string };
  intervalMs?: number;
  fetch?: typeof fetch;
  warn: (message: string) => void;
}

const SEARCH_PAGE_LIMIT = 20;
const OUTSIDE_BATCH_SIZE = 50;
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';

function object(value: unknown): JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  throw new AdapterError('transient', 'Invalid Jira response');
}

function string(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AdapterError('transient', 'Invalid Jira response');
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new AdapterError('transient', 'Invalid Jira response');
}

function keyQuery(refs: readonly TicketEntityRef[]): string {
  const keys = refs.map((ref) => `"${ref.key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  return `key in (${keys.join(', ')})`;
}

function sprintName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sprints = value.map((entry) => {
    if (typeof entry === 'string') {
      const state = /(?:^|,)state=([^,\]]+)/i.exec(entry)?.[1]?.toLowerCase();
      const name = /(?:^|,)name=(.*?)(?:,goal=|,startDate=|,endDate=|\]$)/i.exec(entry)?.[1];
      return { state, name };
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const sprint = entry as JsonObject;
      return { state: sprint['state'], name: sprint['name'] };
    }
    return { state: undefined, name: undefined };
  });
  for (const state of ['active', 'future']) {
    const selected = sprints.find(
      (sprint) =>
        typeof sprint.state === 'string' &&
        sprint.state.toLowerCase() === state &&
        typeof sprint.name === 'string' &&
        sprint.name.length > 0,
    );
    if (typeof selected?.name === 'string') return selected.name;
  }
  return null;
}

function issueFacts(
  value: unknown,
  trackerId: string,
  baseUrl: string,
  sprintField: string | null,
  inFilter: boolean,
): TicketFacts {
  const issue = object(value);
  const fields = object(issue['fields']);
  const status = object(fields['status']);
  const assignee = fields['assignee'] == null ? null : object(fields['assignee']);
  const key = string(issue['key']);
  const updated = string(fields['updated']);
  const updatedAt = new Date(updated);
  if (Number.isNaN(updatedAt.getTime()))
    throw new AdapterError('transient', 'Invalid Jira response');
  return {
    trackerId,
    id: string(issue['id']),
    key,
    title: string(fields['summary']),
    status: string(status['name']),
    assignee: assignee === null ? null : string(assignee['accountId'] ?? assignee['displayName']),
    sprint: sprintField === null ? null : sprintName(fields[sprintField]),
    labels: array(fields['labels']).map(string),
    inFilter,
    url: new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** Creates one Jira source. Credentials and transport come from the eventual runtime caller. */
export function createJiraAdapter(options: JiraAdapterOptions): Adapter {
  if (!options.credentials.email || !options.credentials.token) {
    throw new AdapterError('config', 'Jira credentials are required');
  }
  const transport = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.credentials.email}:${options.credentials.token}`).toString('base64')}`;

  async function request(
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    body?: JsonObject,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(new URL(path, baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch {
      if (signal.aborted) throw new AdapterError('transient', 'Jira poll aborted');
      throw new AdapterError('transient', 'Jira request failed');
    }
    if (!response.ok)
      throw classifyHttpFailure({ status: response.status, headers: response.headers }, Date.now());
    try {
      return await response.json();
    } catch {
      throw new AdapterError('transient', 'Invalid Jira response');
    }
  }

  async function validate(tracker: JiraTracker, signal: AbortSignal): Promise<void> {
    if (tracker.projectKeys.length === 0) {
      throw new AdapterError('config', 'Jira project key is required');
    }
    for (const key of tracker.projectKeys) {
      let result: unknown;
      try {
        result = await request(
          tracker.baseUrl,
          `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
          signal,
        );
      } catch (error) {
        if (
          error instanceof AdapterError &&
          error.kind === 'transient' &&
          error.message === 'HTTP 404'
        ) {
          throw new AdapterError('config', `Unknown Jira project key ${key}`);
        }
        throw error;
      }
      const names = new Set(
        array(result).flatMap((entry) =>
          array(object(entry)['statuses']).map((status) => string(object(status)['name'])),
        ),
      );
      for (const name of [...tracker.doneStatuses, ...tracker.readyStatuses]) {
        if (!names.has(name))
          throw new AdapterError('config', `Unknown Jira status ${name} in project ${key}`);
      }
    }
  }

  async function findSprintField(
    tracker: JiraTracker,
    signal: AbortSignal,
  ): Promise<string | null> {
    const fields = array(await request(tracker.baseUrl, '/rest/api/3/field', signal));
    for (const field of fields) {
      const entry = object(field);
      const schema = entry['schema'];
      if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
        if ((schema as JsonObject)['custom'] === SPRINT_SCHEMA) return string(entry['id']);
      }
    }
    return null;
  }

  async function search(
    tracker: JiraTracker,
    signal: AbortSignal,
    jql: string,
    sprintField: string | null,
  ): Promise<{ issues: unknown[]; complete: boolean }> {
    const issues: unknown[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < SEARCH_PAGE_LIMIT; page += 1) {
      const result = object(
        await request(tracker.baseUrl, '/rest/api/3/search/jql', signal, {
          jql,
          maxResults: 100,
          fields: [
            'summary',
            'status',
            'assignee',
            'labels',
            'updated',
            ...(sprintField === null ? [] : [sprintField]),
          ],
          ...(token === undefined ? {} : { nextPageToken: token }),
        }),
      );
      issues.push(...array(result['issues']));
      const next = result['nextPageToken'];
      if (next == null || next === '') {
        if (result['isLast'] === false)
          throw new AdapterError('transient', 'Jira search omitted its next page token');
        return { issues, complete: true };
      }
      token = string(next);
      if (seen.has(token)) throw new AdapterError('transient', 'Jira search repeated a page token');
      seen.add(token);
    }
    return { issues, complete: false };
  }

  return {
    id: options.id,
    intervalMs: options.intervalMs ?? 120_000,
    async poll(ctx: PollContext): Promise<Batch> {
      const observedAt = new Date().toISOString();
      const tracker = options.tracker();
      await validate(tracker, ctx.signal);
      const sprintField = await findSprintField(tracker, ctx.signal);
      const filtered = await search(tracker, ctx.signal, tracker.jql, sprintField);
      const facts = new Map<string, TicketFacts>();
      for (const issue of filtered.issues) {
        const item = issueFacts(issue, options.id, tracker.baseUrl, sprintField, true);
        facts.set(item.id, item);
      }
      if (!filtered.complete)
        options.warn(`Jira filter reached ${String(SEARCH_PAGE_LIMIT)} pages`);

      const missing = ctx.observe.tickets.filter((ref) => !facts.has(ref.id));
      for (let start = 0; start < missing.length; start += OUTSIDE_BATCH_SIZE) {
        const refs = missing.slice(start, start + OUTSIDE_BATCH_SIZE);
        if (!filtered.complete) {
          const membership = await search(
            tracker,
            ctx.signal,
            `(${tracker.jql}) AND ${keyQuery(refs)}`,
            sprintField,
          );
          if (!membership.complete)
            throw new AdapterError('transient', 'Jira membership search reached its page limit');
          for (const issue of membership.issues) {
            const item = issueFacts(issue, options.id, tracker.baseUrl, sprintField, true);
            facts.set(item.id, item);
          }
        }
        const outsideRefs = refs.filter((ref) => !facts.has(ref.id));
        if (outsideRefs.length === 0) continue;
        const outside = await search(tracker, ctx.signal, keyQuery(outsideRefs), sprintField);
        if (!outside.complete)
          throw new AdapterError('transient', 'Jira outside-ticket search reached its page limit');
        for (const issue of outside.issues) {
          const item = issueFacts(issue, options.id, tracker.baseUrl, sprintField, false);
          if (!facts.has(item.id)) facts.set(item.id, item);
        }
      }
      if (ctx.signal.aborted) throw new AdapterError('transient', 'Jira poll aborted');
      return {
        source: options.id,
        observedAt,
        complete: filtered.complete,
        items: [...facts.values()].map((item) => ({ kind: 'ticket', facts: item })),
        entities: ctx.observe.tickets.map((ref) => ({
          ref,
          status: facts.has(ref.id) ? 'ok' : 'not_found',
        })),
      };
    },
  };
}
