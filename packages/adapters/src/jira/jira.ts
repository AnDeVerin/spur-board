import {
  AdapterError,
  type Adapter,
  type Batch,
  type Config,
  type PollContext,
  type TicketEntityRef,
  type TicketFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';
import { parseWire } from '../runner/wire.ts';

type JiraTracker = Extract<Config['projects'][number]['tracker'], { type: 'jira' }>;
type KnownTicketRef = TicketEntityRef & { id: string };
type JsonObject = Record<string, unknown>;

export interface JiraAdapterOptions {
  id: string;
  tracker: () => JiraTracker;
  credentials: { email: string; token: string };
  intervalMs?: number;
  now: () => number;
  fetch?: typeof fetch;
  warn: (message: string) => void;
  searchMethod?: 'GET';
}

const SEARCH_PAGE_LIMIT = 20;
const MAX_GET_SEARCH_URL_LENGTH = 2_000;
const OUTSIDE_BATCH_SIZE = 50;
const FALLBACK_REQUEST_LIMIT = 100;
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const INVALID = 'Invalid Jira response';

const text = z.string().min(1);
const timestamp = text.refine((value) => !Number.isNaN(Date.parse(value)));
const statusesWire = z.array(z.object({ statuses: z.array(z.object({ name: text })) }));
const fieldWire = z.object({
  id: text,
  schema: z.object({ custom: z.string().optional() }).nullish(),
});
// Every field the adapter reads; `fields` stays loose because the sprint field id is found at runtime.
const issueWire = z.object({
  id: text,
  key: text,
  fields: z.looseObject({
    summary: text,
    status: z.object({ name: text }),
    assignee: z
      .object({ accountId: z.string().nullish(), displayName: z.string().nullish() })
      .refine((assignee) => (assignee.accountId ?? assignee.displayName ?? '').length > 0, {
        path: ['accountId'],
      })
      .nullish(),
    labels: z.array(text),
    updated: timestamp,
  }),
});
type JiraIssue = z.output<typeof issueWire>;
// An empty token marks the last page, so it stays a plain string.
const searchPageWire = z.object({
  issues: z.array(issueWire),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});
const sprintWire = z
  .array(
    z.union([z.string(), z.object({ name: z.string().optional(), state: z.string().optional() })]),
  )
  .nullish();

class JiraHttpError extends AdapterError {
  readonly status: number;

  constructor(status: number, failure: AdapterError) {
    super(failure.kind, failure.message, { retryAt: failure.retryAt });
    this.status = status;
  }
}

function keyQuery(refs: readonly { key: string }[]): string {
  const keys = refs.map((ref) => `"${ref.key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  return `key in (${keys.join(', ')})`;
}

function membershipQuery(jql: string, refs: readonly { key: string }[]): string {
  const trimmed = jql.trim();
  if (/^ORDER\s+BY\b/i.test(trimmed)) return `${keyQuery(refs)} ${trimmed}`;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && /\s/.test(char ?? '') && /^\s+ORDER\s+BY\b/i.test(jql.slice(index))) {
      return `(${jql.slice(0, index).trim()}) AND ${keyQuery(refs)} ${jql.slice(index).trim()}`;
    }
  }
  return `(${jql.trim()}) AND ${keyQuery(refs)}`;
}

function sprintName(value: z.output<typeof sprintWire>): string | null {
  const sprints = (value ?? []).map((entry) => {
    if (typeof entry !== 'string') return entry;
    const state = /(?:^|,)state=([^,\]]+)/i.exec(entry)?.[1];
    const name = /(?:^|,)name=(.*?)(?:,goal=|,startDate=|,endDate=|\]$)/i.exec(entry)?.[1];
    return { state, name };
  });
  for (const state of ['active', 'future']) {
    const selected = sprints.find(
      (sprint) => sprint.state?.toLowerCase() === state && (sprint.name?.length ?? 0) > 0,
    );
    if (selected?.name !== undefined) return selected.name;
  }
  return null;
}

function issueFacts(
  issue: JiraIssue,
  trackerId: string,
  baseUrl: string,
  sprintField: string | null,
  inFilter: boolean,
): TicketFacts {
  const { fields, key } = issue;
  const assignee = fields.assignee ?? null;
  return {
    trackerId,
    id: issue.id,
    key,
    title: fields.summary,
    status: fields.status.name,
    assignee: assignee === null ? null : (assignee.accountId ?? assignee.displayName ?? null),
    sprint:
      sprintField === null
        ? null
        : sprintName(parseWire(sprintWire, fields[sprintField], INVALID, ['fields', sprintField])),
    labels: fields.labels,
    inFilter,
    url: new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString(),
    updatedAt: new Date(fields.updated).toISOString(),
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
    if (response.status === 414 && options.searchMethod === 'GET') {
      throw new AdapterError('config', 'Jira GET search URL is too long');
    }
    if (!response.ok)
      throw new JiraHttpError(
        response.status,
        classifyHttpFailure({ status: response.status, headers: response.headers }, options.now()),
      );
    try {
      return await response.json();
    } catch {
      throw new AdapterError('transient', INVALID);
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
        if (error instanceof JiraHttpError && error.status === 404) {
          throw new AdapterError('config', `Unknown Jira project key ${key}`);
        }
        throw error;
      }
      const names = new Set(
        parseWire(statusesWire, result, INVALID).flatMap((entry) =>
          entry.statuses.map((status) => status.name),
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
    const fields = parseWire(
      z.array(fieldWire),
      await request(tracker.baseUrl, '/rest/api/3/field', signal),
      INVALID,
    );
    return fields.find((field) => field.schema?.custom === SPRINT_SCHEMA)?.id ?? null;
  }

  async function search(
    tracker: JiraTracker,
    signal: AbortSignal,
    jql: string,
    sprintField: string | null,
    beforePage?: () => void,
  ): Promise<{ issues: JiraIssue[]; complete: boolean }> {
    const issues: JiraIssue[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < SEARCH_PAGE_LIMIT; page += 1) {
      beforePage?.();
      const fields = [
        'summary',
        'status',
        'assignee',
        'labels',
        'updated',
        ...(sprintField === null ? [] : [sprintField]),
      ];
      const body = {
        jql,
        maxResults: 100,
        fields,
        ...(token === undefined ? {} : { nextPageToken: token }),
      };
      const path =
        options.searchMethod === 'GET'
          ? `/rest/api/3/search/jql?${new URLSearchParams({
              jql,
              maxResults: '100',
              fields: fields.join(','),
              ...(token === undefined ? {} : { nextPageToken: token }),
            }).toString()}`
          : '/rest/api/3/search/jql';
      if (
        options.searchMethod === 'GET' &&
        new URL(path, tracker.baseUrl).href.length > MAX_GET_SEARCH_URL_LENGTH
      ) {
        throw new AdapterError(
          'config',
          `Jira GET search URL is too long (over ${String(MAX_GET_SEARCH_URL_LENGTH)} characters)`,
        );
      }
      const result = parseWire(
        searchPageWire,
        await request(
          tracker.baseUrl,
          path,
          signal,
          options.searchMethod === 'GET' ? undefined : body,
        ),
        INVALID,
      );
      issues.push(...result.issues);
      const next = result.nextPageToken;
      if (next == null || next === '') {
        if (result.isLast === false)
          throw new AdapterError('transient', 'Jira search omitted its next page token');
        return { issues, complete: true };
      }
      token = next;
      if (seen.has(token)) throw new AdapterError('transient', 'Jira search repeated a page token');
      seen.add(token);
    }
    return { issues, complete: false };
  }

  async function fetchById(
    tracker: JiraTracker,
    ref: KnownTicketRef,
    signal: AbortSignal,
    beforeRequest: () => void,
  ): Promise<JiraIssue | null> {
    try {
      beforeRequest();
      const issue = parseWire(
        issueWire,
        await request(tracker.baseUrl, `/rest/api/3/issue/${encodeURIComponent(ref.id)}`, signal),
        INVALID,
      );
      if (issue.id !== ref.id)
        throw new AdapterError('transient', 'Jira returned a different ticket id');
      return issue;
    } catch (error) {
      if (
        error instanceof JiraHttpError &&
        (error.status === 404 || (error.status === 403 && error.kind === 'auth'))
      )
        return null;
      throw error;
    }
  }

  async function searchByRefs(
    tracker: JiraTracker,
    refs: readonly KnownTicketRef[],
    signal: AbortSignal,
    sprintField: string | null,
    query: (refs: readonly KnownTicketRef[]) => string,
    onRejectedKey: (ref: KnownTicketRef) => Promise<JiraIssue[]>,
    countFallbackRequest: () => void,
    fallback = false,
  ): Promise<JiraIssue[]> {
    const first = refs[0];
    if (first === undefined) return [];
    try {
      const result = await search(
        tracker,
        signal,
        query(refs),
        sprintField,
        fallback ? countFallbackRequest : undefined,
      );
      if (!result.complete)
        throw new AdapterError('transient', 'Jira ticket lookup reached its page limit');
      return result.issues;
    } catch (error) {
      if (!(error instanceof JiraHttpError && error.status === 400)) throw error;
      if (refs.length === 1) return onRejectedKey(first);
      const middle = Math.floor(refs.length / 2);
      const left = await searchByRefs(
        tracker,
        refs.slice(0, middle),
        signal,
        sprintField,
        query,
        onRejectedKey,
        countFallbackRequest,
        true,
      );
      const right = await searchByRefs(
        tracker,
        refs.slice(middle),
        signal,
        sprintField,
        query,
        onRejectedKey,
        countFallbackRequest,
        true,
      );
      return [...left, ...right];
    }
  }

  async function fetchPending(
    tracker: JiraTracker,
    ref: TicketEntityRef,
    signal: AbortSignal,
  ): Promise<{ status: 'ok'; issue: JiraIssue } | { status: 'not_found' | 'no_access' }> {
    try {
      const issue = parseWire(
        issueWire,
        await request(tracker.baseUrl, `/rest/api/3/issue/${encodeURIComponent(ref.key)}`, signal),
        INVALID,
      );
      if (issue.key !== ref.key)
        throw new AdapterError('transient', 'Jira returned a different ticket key');
      return { status: 'ok', issue };
    } catch (error) {
      if (error instanceof JiraHttpError && error.status === 404) return { status: 'not_found' };
      if (error instanceof JiraHttpError && error.status === 403 && error.kind === 'auth')
        return { status: 'no_access' };
      throw error;
    }
  }

  return {
    id: options.id,
    intervalMs: options.intervalMs ?? 120_000,
    async poll(ctx: PollContext): Promise<Batch> {
      let fallbackRequests = 0;
      const countFallbackRequest = () => {
        if (fallbackRequests >= FALLBACK_REQUEST_LIMIT)
          throw new AdapterError('transient', 'Jira key lookup fallback request limit reached');
        fallbackRequests += 1;
      };
      const observedAt = new Date(options.now()).toISOString();
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

      const pendingOutcomes = new Map<string, 'not_found' | 'no_access'>();
      for (const ref of ctx.observe.tickets.filter((ticket) => ticket.id === undefined)) {
        if ([...facts.values()].some((fact) => fact.key === ref.key)) continue;
        const result = await fetchPending(tracker, ref, ctx.signal);
        if (result.status === 'ok') {
          const item = issueFacts(result.issue, options.id, tracker.baseUrl, sprintField, false);
          facts.set(item.id, item);
        } else {
          pendingOutcomes.set(ref.key, result.status);
        }
      }
      const missing = ctx.observe.tickets.filter(
        (ref): ref is KnownTicketRef => ref.id !== undefined && !facts.has(ref.id),
      );
      for (let start = 0; start < missing.length; start += OUTSIDE_BATCH_SIZE) {
        const refs = missing.slice(start, start + OUTSIDE_BATCH_SIZE);
        const direct = new Map<string, JiraIssue | null>();
        if (!filtered.complete) {
          const membership = await searchByRefs(
            tracker,
            refs,
            ctx.signal,
            sprintField,
            (group) => membershipQuery(tracker.jql, group),
            async (ref) => {
              const issue = await fetchById(tracker, ref, ctx.signal, countFallbackRequest);
              direct.set(ref.id, issue);
              if (issue === null) return [];
              const current = await search(
                tracker,
                ctx.signal,
                membershipQuery(tracker.jql, [{ ...ref, key: issue.key }]),
                sprintField,
                countFallbackRequest,
              );
              if (!current.complete)
                throw new AdapterError(
                  'transient',
                  'Jira membership search reached its page limit',
                );
              return current.issues;
            },
            countFallbackRequest,
          );
          for (const issue of membership) {
            const item = issueFacts(issue, options.id, tracker.baseUrl, sprintField, true);
            facts.set(item.id, item);
          }
        }
        const outsideRefs = refs.filter((ref) => !facts.has(ref.id));
        if (outsideRefs.length === 0) continue;
        const outsideIssues: JiraIssue[] = outsideRefs.flatMap((ref) => {
          const issue = direct.get(ref.id);
          return issue == null ? [] : [issue];
        });
        const unchecked = outsideRefs.filter((ref) => !direct.has(ref.id));
        if (unchecked.length > 0)
          outsideIssues.push(
            ...(await searchByRefs(
              tracker,
              unchecked,
              ctx.signal,
              sprintField,
              keyQuery,
              async (ref) => {
                const issue = await fetchById(tracker, ref, ctx.signal, countFallbackRequest);
                return issue === null ? [] : [issue];
              },
              countFallbackRequest,
            )),
          );
        for (const issue of outsideIssues) {
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
          status:
            ref.id === undefined
              ? [...facts.values()].some((fact) => fact.key === ref.key)
                ? 'ok'
                : (pendingOutcomes.get(ref.key) ?? 'not_found')
              : facts.has(ref.id)
                ? 'ok'
                : 'not_found',
        })),
      };
    },
  };
}
