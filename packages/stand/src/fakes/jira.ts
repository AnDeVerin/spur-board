// A fake of Jira Cloud REST v3, driven by `stand fake jira issue ...`.
import type { Config } from '@spur-board/contracts';
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { FakeViolation, type FakeModule, type FakeRequest } from './fetch.ts';

type JiraTracker = Extract<Config['projects'][number]['tracker'], { type: 'jira' }>;

const API = '/rest/api/3/';
const PAGE_SIZE = 100;
const FIRST_ID = 10_001;
const SPRINT_FIELD = 'customfield_10020';
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
/** The fake's workflow; a new ticket starts at the first status. */
const STATUSES = ['To Do', 'Ready for Dev', 'In Progress', 'In Review', 'Done'] as const;
// The fields the adapter asks for, written out here on purpose, as the JQL forms are.
const FIELDS = ['summary', 'status', 'assignee', 'labels', 'updated', SPRINT_FIELD];
const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const PROJECT_JQL = /^project = ([A-Z][A-Z0-9_]*)$/;
const KEY_IN = /^key in \(("[^"\\]+"(?:, "[^"\\]+")*)\)$/;
const PAGE_TOKEN = /^stand-page-([1-9]\d*)$/;
const UNKNOWN = 'if the adapter changed on purpose, update packages/stand/src/fakes/jira.ts.';

interface Ticket {
  id: string;
  key: string;
  project: string;
  title: string;
  status: string;
  updatedAt: number;
}

const issueControlSchema = z.strictObject({
  key: z.string().regex(KEY, 'Expected a Jira key such as STAND-1.'),
  title: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

const searchSchema = z.strictObject({
  jql: z.string(),
  maxResults: z.literal(PAGE_SIZE),
  fields: z.array(z.string()),
  nextPageToken: z.string().optional(),
});

const projectOf = (key: string): string => key.slice(0, key.lastIndexOf('-'));

/** Jira's timestamp form, `2026-01-02T00:00:00.000+0000`. */
const jiraTime = (ms: number): string => new Date(ms).toISOString().replace('Z', '+0000');

function checkHeaders(request: FakeRequest, method: 'GET' | 'POST'): void {
  if (request.method !== method)
    throw new FakeViolation(
      `Jira takes ${method} on ${request.url.pathname}, got ${request.method}.`,
    );
  if (request.headers.get('accept') !== 'application/json')
    throw new FakeViolation('Expected header accept: application/json.');
  if (!/^Basic \S+$/.test(request.headers.get('authorization') ?? ''))
    throw new FakeViolation('Expected a Basic authorization header.');
  if (method === 'POST' && request.headers.get('content-type') !== 'application/json')
    throw new FakeViolation('Expected header content-type: application/json.');
  if (method === 'GET' && request.body !== '')
    throw new FakeViolation(`GET ${request.url.pathname} takes no body.`);
}

/** The keys of a `key in ("A-1", "B-2")` clause, or undefined when `text` is not one. */
function keysOf(text: string): string[] | undefined {
  const list = KEY_IN.exec(text)?.[1];
  if (list === undefined) return undefined;
  const keys = list.split(', ').map((quoted) => quoted.slice(1, -1));
  return keys.every((key) => KEY.test(key)) ? keys : undefined;
}

/** Tickets of the tracker's projects, with the verb that creates and changes them. */
export function createJiraFake(options: { now: () => number; tracker: JiraTracker }): FakeModule {
  const { now, tracker } = options;
  const origin = new URL(tracker.baseUrl).origin;
  const filterProject = PROJECT_JQL.exec(tracker.jql)?.[1];
  if (filterProject === undefined || !tracker.projectKeys.includes(filterProject))
    throw new Error(
      `The Jira fake takes jql "project = <KEY>" with KEY in projectKeys, got "${tracker.jql}".`,
    );
  const membershipPrefix = `(${tracker.jql.trim()}) AND `;
  const tickets = new Map<string, Ticket>();
  let nextId = FIRST_ID;

  function issueView(ticket: Ticket) {
    return {
      id: ticket.id,
      key: ticket.key,
      self: `${origin}${API}issue/${ticket.id}`,
      fields: {
        summary: ticket.title,
        status: { name: ticket.status },
        assignee: null,
        labels: [],
        updated: jiraTime(ticket.updatedAt),
        [SPRINT_FIELD]: null,
      },
    };
  }

  /** Which tickets a JQL selects, and the keys it names; anything but the three forms is a violation. */
  function select(jql: string): { named: string[]; matches: (ticket: Ticket) => boolean } {
    if (jql === tracker.jql)
      return { named: [], matches: (ticket) => ticket.project === filterProject };
    const membership = jql.startsWith(membershipPrefix);
    const named = keysOf(membership ? jql.slice(membershipPrefix.length) : jql);
    if (named === undefined)
      throw new FakeViolation(`Unknown JQL ${JSON.stringify(jql)}: ${UNKNOWN}`);
    const wanted = new Set(named);
    return {
      named,
      matches: (ticket) =>
        wanted.has(ticket.key) && (!membership || ticket.project === filterProject),
    };
  }

  function search(request: FakeRequest): () => { status: number; body: unknown } {
    let json: unknown;
    try {
      json = JSON.parse(request.body);
    } catch {
      throw new FakeViolation('The Jira search body is not JSON.');
    }
    const parsed = searchSchema.safeParse(json);
    if (!parsed.success)
      throw new FakeViolation(`Unknown Jira search body: ${z.prettifyError(parsed.error)}`);
    const { jql, fields, nextPageToken } = parsed.data;
    if (fields.length !== FIELDS.length || FIELDS.some((field) => !fields.includes(field)))
      throw new FakeViolation(
        `Expected the fields ${FIELDS.join(', ')}, got ${fields.join(', ')}.`,
      );
    let offset = 0;
    if (nextPageToken !== undefined) {
      const match = PAGE_TOKEN.exec(nextPageToken)?.[1];
      if (match === undefined || Number(match) % PAGE_SIZE !== 0)
        throw new FakeViolation(`Unknown page token ${nextPageToken}.`);
      offset = Number(match);
    }
    const { named, matches } = select(jql);
    return () => {
      const missing = named.filter((key) => !tickets.has(key));
      if (missing.length > 0)
        return {
          status: 400,
          body: {
            errorMessages: missing.map(
              (key) => `An issue with key '${key}' does not exist for field 'key'.`,
            ),
            warningMessages: [],
          },
        };
      const all = [...tickets.values()].filter(matches).sort((a, b) => Number(b.id) - Number(a.id));
      const page = all.slice(offset, offset + PAGE_SIZE);
      const last = offset + PAGE_SIZE >= all.length;
      return {
        status: 200,
        body: {
          issues: page.map(issueView),
          ...(last
            ? { isLast: true }
            : { nextPageToken: `stand-page-${String(offset + PAGE_SIZE)}`, isLast: false }),
        },
      };
    };
  }

  function detail(idOrKey: string): () => { status: number; body: unknown } {
    const byId = /^[1-9]\d*$/.test(idOrKey);
    if (!byId && !KEY.test(idOrKey))
      throw new FakeViolation(`Unknown Jira issue reference ${idOrKey}: ${UNKNOWN}`);
    return () => {
      const ticket = byId
        ? [...tickets.values()].find((candidate) => candidate.id === idOrKey)
        : tickets.get(idOrKey);
      return ticket === undefined
        ? {
            status: 404,
            body: {
              errorMessages: ['Issue does not exist or you do not have permission to see it.'],
              errors: {},
            },
          }
        : { status: 200, body: issueView(ticket) };
    };
  }

  function route(request: FakeRequest): () => { status: number; body: unknown } {
    const { url } = request;
    if (url.search !== '')
      throw new FakeViolation(`Jira takes no query string on ${url.pathname}: ${UNKNOWN}`);
    let segments: string[] = [];
    if (url.pathname.startsWith(API)) {
      try {
        segments = url.pathname.slice(API.length).split('/').map(decodeURIComponent);
      } catch {
        throw new FakeViolation(`Malformed path ${url.pathname}.`);
      }
    }
    const [root, id, kind, ...rest] = segments;
    if (root === 'project' && kind === 'statuses' && rest.length === 0 && id !== undefined) {
      checkHeaders(request, 'GET');
      if (!tracker.projectKeys.includes(id))
        throw new FakeViolation(`Unknown Jira project ${id}: ${UNKNOWN}`);
      return () => ({
        status: 200,
        body: [
          {
            id: '10000',
            name: 'Task',
            subtask: false,
            statuses: STATUSES.map((name, index) => ({ id: String(index + 1), name })),
          },
        ],
      });
    }
    if (root === 'field' && id === undefined) {
      checkHeaders(request, 'GET');
      return () => ({
        status: 200,
        body: [
          { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
          { id: 'status', name: 'Status', custom: false, schema: { type: 'status' } },
          { id: 'assignee', name: 'Assignee', custom: false, schema: { type: 'user' } },
          { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array' } },
          { id: 'updated', name: 'Updated', custom: false, schema: { type: 'datetime' } },
          {
            id: SPRINT_FIELD,
            name: 'Sprint',
            custom: true,
            schema: { type: 'array', custom: SPRINT_SCHEMA, customId: 10020 },
          },
        ],
      });
    }
    if (root === 'search' && id === 'jql' && kind === undefined) {
      checkHeaders(request, 'POST');
      return search(request);
    }
    if (root === 'issue' && id !== undefined && kind === undefined) {
      checkHeaders(request, 'GET');
      return detail(id);
    }
    throw new FakeViolation(`Unknown Jira path ${request.method} ${url.pathname}: ${UNKNOWN}`);
  }

  function control(verb: string, args: unknown): RouteResult | undefined {
    if (verb !== 'issue') return undefined;
    const parsed = issueControlSchema.safeParse(args);
    if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
    const { key, title, status } = parsed.data;
    const project = projectOf(key);
    if (!tracker.projectKeys.includes(project))
      return {
        status: 400,
        body: { error: `Unknown Jira project ${project}.`, projects: tracker.projectKeys },
      };
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
      return { status: 400, body: { error: `Unknown status ${status}.`, statuses: STATUSES } };
    let ticket = tickets.get(key);
    if (ticket === undefined) {
      ticket = {
        id: String(nextId),
        key,
        project,
        title: title ?? `Stand ticket ${key}`,
        status: status ?? STATUSES[0],
        updatedAt: now(),
      };
      nextId += 1;
      tickets.set(key, ticket);
    } else {
      if (title === undefined && status === undefined)
        return { status: 409, body: { error: `Ticket ${key} exists; pass --title or --status.` } };
      if (title !== undefined) ticket.title = title;
      if (status !== undefined) ticket.status = status;
      // Strictly forward, so two verbs in one millisecond still differ.
      ticket.updatedAt = Math.max(now(), ticket.updatedAt + 1);
    }
    return {
      status: 200,
      body: {
        ticket: key,
        id: ticket.id,
        status: ticket.status,
        updatedAt: new Date(ticket.updatedAt).toISOString(),
      },
    };
  }

  return {
    system: 'jira',
    claims: (url) => url.origin === origin,
    prepare: route,
    control,
    reset() {
      tickets.clear();
      nextId = FIRST_ID;
    },
    state: () => structuredClone({ tickets, nextId }),
    restore(state) {
      const copy = structuredClone(state as { tickets: Map<string, Ticket>; nextId: number });
      tickets.clear();
      for (const [key, ticket] of copy.tickets) tickets.set(key, ticket);
      nextId = copy.nextId;
    },
  };
}
