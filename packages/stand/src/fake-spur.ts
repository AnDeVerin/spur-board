// An in-memory Spur behind an injected `fetch`: the three routes the board calls, the failures a
// scenario can inject, and a log of every request the board should not have made.
import { parseArgs } from 'node:util';
import { err, ok, type Result } from '@spur-board/contracts';
import { z } from 'zod';
import type { RouteResult } from './control.ts';

const INSTANCE_HEADER = 'x-spur-lifecycle-instance-id';
const MAX_VIOLATIONS = 100;
const MAX_RECORDS = 500;
const MAX_BODY_TEXT = 200;
const MAX_HOLD_MS = 60_000;
const DEFAULT_5XX = 503;

const ROUTE_NAMES = ['list', 'detail', 'send'] as const;
type RouteName = (typeof ROUTE_NAMES)[number];

/** Spur's `assertSendableStatus`, plus `spawning`, which it queues before that gate. */
const SENDABLE = new Set(['running', 'stopped', 'budget_limited', 'paused', 'spawning']);
const ENDED = new Set(['errored', 'completed', 'killed']);

const text = z.string().min(1);
const route = z.enum([...ROUTE_NAMES, 'all']).default('all');
const noArgs = z.strictObject({});
const sessionArgs = z.strictObject({
  id: text,
  state: text.optional(),
  status: text.optional(),
  project: text.optional(),
  branch: text.optional(),
  retain: z.literal(true).optional(),
  /** Why Spur stopped the session, as a live Spur reports it (`stale_timeout`). */
  stopReason: text.optional(),
});
const failArgs = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('delay'),
    route,
    ms: z.int().min(1).max(MAX_HOLD_MS),
  }),
  z.strictObject({ mode: z.literal('refuse'), route }),
  z.strictObject({ mode: z.literal('hang'), route }),
  z.strictObject({
    mode: z.literal('5xx'),
    route,
    status: z.int().min(500).max(599).default(DEFAULT_5XX),
  }),
]);
const fakeCommand = z.discriminatedUnion('verb', [
  z.strictObject({ verb: z.literal('session'), args: sessionArgs }),
  z.strictObject({ verb: z.literal('restart'), args: noArgs }),
  z.strictObject({ verb: z.literal('fail'), args: failArgs }),
  z.strictObject({ verb: z.literal('clear'), args: noArgs }),
  z.strictObject({ verb: z.literal('inspect'), args: noArgs }),
]);

type SessionArgs = z.output<typeof sessionArgs>;
type FailureRule = z.output<typeof failArgs>;

interface FakeSession {
  id: string;
  project: string;
  branch: string | null;
  status: string;
  state: string;
  lastActivityAt: string | null;
  stopReason?: string;
  retainInList?: true;
}

interface Violation {
  at: string;
  method: string;
  path: string;
  reason: 'route' | 'query' | 'body';
  detail: string;
  body?: string;
}

export interface FakeSpur {
  readonly fetch: typeof fetch;
  /** Runs one verb; bad arguments answer 400. */
  control(verb: string, args: unknown): RouteResult;
  /** The first violations and how many there were in all. */
  violations(): { total: number; items: readonly Violation[] };
  /** Rejects every held request and every later one, and leaves no timer. */
  close(): void;
  /** A deep copy of the sessions, failure rules and instance generation; no request logs. */
  state(): FakeSpurState;
  /** Replaces the sessions, failure rules and instance generation with a copy of `state`. */
  restore(state: FakeSpurState): void;
}

/** What `FakeSpur.state` returns. */
export interface FakeSpurState {
  sessions: [string, FakeSession][];
  rules: [RouteName, FailureRule][];
  generation: number;
}

/** The URL of a `fetch` input. */
export function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input);
}

async function bodyText(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (init?.body !== undefined && init.body !== null) return new Response(init.body).text();
  return input instanceof Request ? input.clone().text() : '';
}

/** What Spur's body parsing and content check see in a send body. */
function readSend(body: string): { json: boolean; message?: string; exact: boolean } {
  const trimmed = body.trim();
  let parsed: unknown = {};
  try {
    if (trimmed !== '') parsed = JSON.parse(trimmed);
  } catch {
    return { json: false, exact: false };
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed : {};
  const message = 'message' in record ? record.message : undefined;
  if (typeof message !== 'string' || message.trim() === '') return { json: true, exact: false };
  return { json: true, message, exact: Object.keys(record).length === 1 };
}

function fetchFailed(): TypeError {
  return new TypeError('fetch failed');
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function pushBounded<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_RECORDS) list.shift();
}

export function createFakeSpur(options: {
  baseUrl: string;
  now: () => number;
  /** Receives one JSON line per violation, as it happens. */
  log: (line: string) => void;
  /** Sessions present from the start, `running` and `working`. */
  sessions?: readonly Pick<SessionArgs, 'id' | 'project' | 'branch'>[];
}): FakeSpur {
  const base = new URL(`${options.baseUrl.replace(/\/$/, '')}/`);
  const sessions = new Map<string, FakeSession>();
  const rules = new Map<RouteName, FailureRule>();
  const requests: { at: string; method: string; path: string; route: RouteName }[] = [];
  const sends: { at: string; session: string; message: string }[] = [];
  const violations: Violation[] = [];
  const held = new Set<() => void>();
  let violationTotal = 0;
  let generation = 1;
  let closed = false;

  const instanceId = (): string => `stand-spur-${String(generation)}`;
  const iso = (): string => new Date(options.now()).toISOString();

  function upsert(args: SessionArgs): FakeSession {
    const previous = sessions.get(args.id);
    const stopReason = args.stopReason ?? previous?.stopReason;
    const session: FakeSession = {
      id: args.id,
      project: args.project ?? previous?.project ?? 'stand-worker',
      branch: args.branch ?? previous?.branch ?? null,
      status: args.status ?? previous?.status ?? 'running',
      state: args.state ?? previous?.state ?? 'working',
      lastActivityAt: iso(),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(args.retain === true || previous?.retainInList === true
        ? { retainInList: true as const }
        : {}),
    };
    sessions.set(args.id, session);
    return session;
  }

  for (const session of options.sessions ?? []) upsert(session);

  function violate(entry: Omit<Violation, 'at' | 'body'>, body: string): void {
    const violation: Violation = {
      at: iso(),
      ...entry,
      ...(body === '' ? {} : { body: body.slice(0, MAX_BODY_TEXT) }),
    };
    violationTotal += 1;
    if (violations.length < MAX_VIOLATIONS) violations.push(violation);
    options.log(
      `${JSON.stringify({ level: 40, module: 'fake-spur', msg: 'spur contract violation', ...violation })}\n`,
    );
  }

  /** The route of a request, matched as Spur does: on the raw path, without decoding the id. */
  function match(url: URL, method: string): { name: RouteName; id: string } | undefined {
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return undefined;
    const path = url.pathname.slice(base.pathname.length);
    if (method === 'GET' && path === 'sessions') return { name: 'list', id: '' };
    const detail = /^sessions\/([^/]+)$/.exec(path)?.[1];
    if (method === 'GET' && detail !== undefined) return { name: 'detail', id: detail };
    const send = /^sessions\/([^/]+)\/send$/.exec(path)?.[1];
    if (method === 'POST' && send !== undefined) return { name: 'send', id: send };
    return undefined;
  }

  /** Waits until `ms` passes, or forever without it; abort and `close` reject. */
  function hold(signal: AbortSignal | undefined, ms?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        held.delete(onClose);
      };
      const onAbort = (): void => {
        settle();
        reject(signal?.reason as Error);
      };
      const onClose = (): void => {
        settle();
        reject(fetchFailed());
      };
      held.add(onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (ms !== undefined)
        timer = setTimeout(() => {
          settle();
          resolve();
        }, ms);
    });
  }

  function answerSend(id: string, body: string): Response {
    const { json, message } = readSend(body);
    if (!json) return errorResponse(400, 'Invalid JSON in request body');
    const session = sessions.get(id);
    if (session === undefined) return errorResponse(404, `Session not found: ${id}`);
    if (message === undefined) return errorResponse(500, 'message or attachments required');
    const { status } = session;
    if (ENDED.has(status)) return errorResponse(409, `Session has ended (${status}): ${id}`);
    if (!SENDABLE.has(status)) return errorResponse(500, `Unknown session status ${status}: ${id}`);
    pushBounded(sends, { at: iso(), session: id, message });
    return Response.json(session);
  }

  function answer(matched: { name: RouteName; id: string }, body: string): Response {
    if (matched.name === 'send') return answerSend(matched.id, body);
    if (matched.name === 'list')
      return Response.json(
        [...sessions.values()].filter(
          ({ status, retainInList }) =>
            (status !== 'completed' && status !== 'killed') || retainInList === true,
        ),
        { headers: { [INSTANCE_HEADER]: instanceId() } },
      );
    const session = sessions.get(matched.id);
    return session === undefined
      ? errorResponse(404, `Session not found: ${matched.id}`)
      : Response.json(session);
  }

  const spurFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const body = await bodyText(input, init);
    if (closed) throw fetchFailed();
    signal?.throwIfAborted();
    const path = `${url.pathname}${url.search}`;
    const matched = match(url, method);
    if (matched === undefined) {
      violate({ method, path, reason: 'route', detail: 'The fake models no such route.' }, body);
      return errorResponse(404, `Route not found: ${method} ${url.pathname}`);
    }
    if (url.search !== '')
      violate({ method, path, reason: 'query', detail: 'The board sends no query string.' }, '');
    if (matched.name !== 'send' && body !== '')
      violate({ method, path, reason: 'body', detail: 'A GET carries no body.' }, body);
    if (matched.name === 'send' && !readSend(body).exact)
      violate({ method, path, reason: 'body', detail: 'Expected exactly { message }.' }, body);
    pushBounded(requests, { at: iso(), method, path, route: matched.name });
    const rule = rules.get(matched.name);
    if (rule?.mode === 'refuse') throw fetchFailed();
    if (rule?.mode === '5xx') return errorResponse(rule.status, 'Injected failure');
    if (rule?.mode === 'hang') await hold(signal);
    if (rule?.mode === 'delay') await hold(signal, rule.ms);
    return answer(matched, body);
  };

  function currentViolations(): ReturnType<FakeSpur['violations']> {
    return { total: violationTotal, items: violations };
  }

  return {
    fetch: spurFetch,
    control(verb, args) {
      const parsed = fakeCommand.safeParse({ verb, args });
      if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
      const command = parsed.data;
      switch (command.verb) {
        case 'session':
          return { status: 200, body: { session: upsert(command.args) } };
        case 'restart':
          generation += 1;
          return { status: 200, body: { instanceId: instanceId() } };
        case 'fail':
          for (const name of command.args.route === 'all' ? ROUTE_NAMES : [command.args.route])
            rules.set(name, command.args);
          return { status: 200, body: { rules: Object.fromEntries(rules) } };
        case 'clear':
          rules.clear();
          return { status: 200, body: { rules: {} } };
        case 'inspect':
          return {
            status: 200,
            body: {
              instanceId: instanceId(),
              sessions: [...sessions.values()],
              rules: Object.fromEntries(rules),
              requests,
              sends,
              violations: currentViolations(),
            },
          };
      }
    },
    violations: currentViolations,
    state: () => structuredClone({ sessions: [...sessions], rules: [...rules], generation }),
    restore(state) {
      const copy = structuredClone(state);
      sessions.clear();
      for (const [id, session] of copy.sessions) sessions.set(id, session);
      rules.clear();
      for (const [name, rule] of copy.rules) rules.set(name, rule);
      generation = copy.generation;
    },
    close() {
      closed = true;
      for (const release of [...held]) release();
    },
  };
}

const FAKE_OPTIONS = {
  state: { type: 'string' },
  status: { type: 'string' },
  project: { type: 'string' },
  branch: { type: 'string' },
  retain: { type: 'boolean' },
  route: { type: 'string' },
  ms: { type: 'string' },
} as const;

/** A digit string as a number; anything else stays a string, which the schema then refuses. */
function integer(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Parses the arguments of `stand fake`, with the checks `control` applies to the same command. */
export function parseFakeArgs(
  rest: readonly string[],
): Result<{ system: 'spur'; verb: string; args: Record<string, unknown> }, string> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...rest], allowPositionals: true, options: FAKE_OPTIONS });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
  const [system, verb, ...operands] = parsed.positionals;
  if (system !== 'spur')
    return err(`Unknown fake system ${system ?? '(none)'}; use spur, github, jira or slack.`);
  if (verb === undefined) return err('fake spur needs a verb.');
  const operand = verb === 'session' ? 'id' : verb === 'fail' ? 'mode' : undefined;
  if (operands.length !== (operand === undefined ? 0 : 1))
    return err(
      `fake spur ${verb} takes ${operand === undefined ? 'no operand' : `one ${operand}`}.`,
    );
  const args: Record<string, unknown> = { ...parsed.values };
  if (operand !== undefined) args[operand] = operands[0];
  if (verb === 'fail') {
    const { ms, status } = parsed.values;
    if (ms !== undefined) args['ms'] = integer(ms);
    if (status !== undefined) args['status'] = integer(status);
  }
  const command = fakeCommand.safeParse({ verb, args });
  if (!command.success) return err(z.prettifyError(command.error));
  return ok({ system, verb: command.data.verb, args: command.data.args });
}
