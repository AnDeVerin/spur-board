import { browserOperations } from '@spur-board/contracts/browser';

/** Board screen fixtures: config, `status.get` rows and a fake daemon with its event stream. */
type OpId = 'config.get' | 'status.get' | 'inbox.operator' | 'task.get' | 'task.history';
type Route = (input: Record<string, unknown>) => Promise<Response>;

export const envelope = (value: unknown) => Response.json({ ok: true, requestId: 'r1', value });
export const failure = () => Promise.resolve(Response.json({ broken: true }, { status: 500 }));
export const never = () => new Promise<Response>(() => undefined);
/** A daemon problem answer with its stable code. */
export const problem = (code: string, status = 404) =>
  Promise.resolve(
    Response.json(
      {
        type: `https://spur-board.dev/docs/errors.md#${code}`,
        title: code,
        status,
        code,
        requestId: 'r1',
        message: code,
        hint: 'hint',
        docs: `docs/errors.md#${code}`,
        context: {},
        recovery: { action: 'Check', sideEffects: 'none', maxRetries: 0, retryTiming: 'Never' },
      },
      { status, headers: { 'content-type': 'application/problem+json' } },
    ),
  );
export function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const column = (id: string, kind = 'dispatcher', name: string | null = null) => ({
  id,
  executor: { kind, name },
});
const project = (id: string, mode: 'on' | 'shadow', columns: ReturnType<typeof column>[]) => ({
  id,
  columns,
  dispatcher: { mode },
  spurProjects: [],
  ticketBrowseBase: null as string | null,
});
export const config = {
  projects: [
    project('a', 'on', [
      column('todo'),
      column('dev', 'worker', 'stand-worker'),
      column('review'),
      column('done'),
    ]),
    project('b', 'shadow', [column('todo'), column('done')]),
  ],
  web: { publicOrigin: null, spurUiOrigin: null },
};
const ticket = (key: string, title: string) => ({
  trackerId: 'gh',
  id: key,
  key,
  title,
  status: 'Open',
  assignee: null,
  sprint: null,
  labels: [],
  inFilter: true,
  url: 'https://example.test/ticket',
  updatedAt: '2026-11-15T14:00:00.000Z',
});
export const row = (key: string, columnId: string, extra: Record<string, unknown> = {}) => ({
  key,
  project: 'a',
  column: columnId,
  membership: 'active',
  state: 'open',
  prCount: 0,
  sessionCount: 0,
  openBlocks: 0,
  blocks: [],
  turn: null,
  prSummary: null,
  links: { ticket: null, prs: [], sessions: [] },
  ticket: ticket(key, `Title ${key}`),
  ...extra,
});
/** An open `status.get` turn: the worker's untaken Dev turn T3 unless `extra` says otherwise. */
export const turn = (extra: Record<string, unknown> = {}) => ({
  id: 'T3',
  task: 'ex/repo#7',
  column: 'dev',
  addressee: 'worker',
  reason: 'dev: no_pr',
  head: null,
  at: '2026-11-15T14:00:00.000Z',
  taken: null,
  addressedTo: null,
  stalledSince: null,
  ...extra,
});
/** A `prSummary` entry: PR 1, green, mergeable, no threads or reviews, unless `extra` says otherwise. */
export const prSummary = (extra: Record<string, unknown> = {}) => ({
  repo: 'ex/repo',
  number: 1,
  checks: { pass: 3, fail: 0, pending: 0 },
  mergeable: 'mergeable',
  threads: { unresolved: 0, total: 0 },
  reviewsOnHead: { approved: [], changesRequested: [] },
  draft: false,
  factAt: '2026-11-15T14:00:00.000Z',
  unconfirmed: false,
  ...extra,
});
/** The `links.prs` entry of PR `number` in `ex/repo`. */
export const prLink = (number: number) => ({
  repo: 'ex/repo',
  number,
  url: `https://github.com/ex/repo/pull/${String(number)}`,
});
export const DONE = [20, 21, 22, 23, 24, 25, 26].map((n) => `ex/repo#${String(n)}`);
// Done first and an unmatched row: configured groups come first, then the unknown disclosure.
export const ROWS = [
  ...DONE.map((key) =>
    row(
      key,
      'done',
      key.endsWith('#21') ? { links: { ticket: null, prs: [], sessions: [{ id: 'sess-9' }] } } : {},
    ),
  ),
  row('ex/repo#99', 'qa'),
  row('ex/repo#7', 'dev', {
    ticket: ticket('ex/repo#7', 'Fix login'),
    blocks: [{ id: 'B12', addressee: 'operator', session: null }],
  }),
  row('ABC-3', 'dev', { ticket: null }),
];
export const source = (name: string, extra: Record<string, unknown> = {}) => ({
  source: name,
  observedAt: null,
  lastCompleteAt: null,
  blindReason: null,
  message: null,
  budget: null,
  stale: false,
  healthySince: null,
  warmingUp: false,
  ...extra,
});
/** The fixtures typed as the screen reads them. */
export const parsed = () => ({
  columns: browserOperations['config.get'].output.parse(config).projects[0]?.columns ?? [],
  rows: browserOperations['status.get'].output.parse(status()).tasks,
});
/** One `services[]` row; `since` is set only for a healthy one, as core writes it. */
export const service = (
  name: string,
  state: 'healthy' | 'degraded' | 'failing',
  extra: Record<string, unknown> = {},
) => ({
  service: name,
  state,
  since: state === 'healthy' ? '2026-11-15T09:00:00.000Z' : null,
  lastGoodAt: null,
  reason: state === 'healthy' ? null : `${name} is ${state}`,
  ...extra,
});
/** A `status.get` answer; `extra` replaces top-level fields such as services, transport or host. */
export const status = (
  tasks: unknown[] = ROWS,
  sources: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({
  items: [],
  warmingUp: false,
  spurUnavailable: null,
  hostLoad: null,
  host: null,
  services: [],
  transport: [],
  sources,
  tasks,
  projectBlocks: [],
  unlinkedPrs: [],
  unlinkedSessions: [],
  hiddenUnlinkedPrs: 0,
  hiddenUnlinkedSessions: 0,
  bindings: { columns: [], operators: [], defaultAddressee: null },
  daemon: { version: '0.4.0', startedAt: '2026-01-05T08:00:00.000Z', lastDispatchAt: null },
  ...extra,
});
export const inbox = (count: number) => ({
  items: Array.from({ length: count }, (_, i) => ({
    id: `B${String(i + 1)}`,
    project: 'a',
    kind: 'block',
    severity: 'attention',
    text: 'Pick one',
    at: '2026-11-15T14:00:00.000Z',
    task: null,
  })),
  handled: [],
});

/**
 * `task.get` with why for `ex/repo#7` in Dev of project `a`: a PR and a session link, Dev's
 * `checks_green` failed, an open worker turn not taken yet and one move into Dev.
 */
export const taskGet = (extra: Record<string, unknown> = {}) => ({
  task: { key: 'ex/repo#7', project: 'a', column: 'dev', membership: 'active' },
  turn: {
    id: 'T4',
    column: 'dev',
    addressee: 'worker',
    at: '2026-11-15T13:00:00.000Z',
    taken: null,
    handed: [],
    closed: null,
  },
  links: [
    { kind: 'pr', ref: 'ex/repo#7', role: null, state: 'open' },
    { kind: 'session', ref: 's1', role: 'worker' },
  ],
  blocks: [],
  comments: [],
  why: {
    column: 'dev',
    dispatcher: 'on',
    holds: [],
    gates: [
      {
        column: 'dev',
        enabled: true,
        ok: false,
        blockedIn: 'dev',
        conditions: [
          { condition: 'pr_open', state: 'met', reason: null },
          { condition: 'checks_green', state: 'failed', reason: 'checks_red' },
        ],
      },
    ],
    checksWaivedBy: null,
    turn: null,
    moves: [
      {
        at: '2026-11-15T12:00:00.000Z',
        kind: 'task_moved',
        actor: 'system',
        from: 'todo',
        to: 'dev',
        reason: 'gate_passed',
        gate: [],
        text: null,
      },
    ],
  },
  ...extra,
});

/** A journal event of `task.history`; `via` only when given. */
export const historyEvent = (
  at: string,
  kind: string,
  actor: string,
  summary: string,
  via?: string,
) => ({
  at,
  kind,
  actor,
  ...(via === undefined ? {} : { via }),
  summary,
});
/**
 * `task.history` of `ex/repo#7`, oldest first: added at `T`, a worker turn opened, taken by
 * session web-7 and closed, an operator comment from the web, a block answered from Slack, and two
 * events with one timestamp.
 */
export const taskHistory = (
  events: unknown[] = [
    historyEvent('2026-11-15T14:40:00.000Z', 'task_added', 'operator', 'Added to Dev.'),
    historyEvent(
      '2026-11-15T14:41:00.000Z',
      'turn_opened',
      'system',
      'Opened a worker turn in Dev.',
    ),
    historyEvent('2026-11-15T14:42:00.000Z', 'turn_taken', 'agent:web/web-7', 'Took the turn.'),
    historyEvent('2026-11-15T14:45:00.000Z', 'turn_closed', 'agent:web/web-7', 'Closed the turn.'),
    historyEvent('2026-11-15T14:50:00.000Z', 'comment_added', 'operator', 'Commented.', 'web'),
    historyEvent(
      '2026-11-15T14:55:00.000Z',
      'block_unblocked',
      'operator',
      'Answered B12.',
      'slack',
    ),
    historyEvent('2026-11-15T15:00:00.000Z', 'task_moved', 'system', 'Moved to Review.'),
    historyEvent('2026-11-15T15:00:00.000Z', 'flag_raised', 'system', 'Raised a flag.'),
  ],
) => ({ task: taskGet().task, events });

/** Fake daemon: the five reads by route and an event stream the test writes to. */
export function daemon() {
  const routes: Record<OpId, Route> = {
    'config.get': () => Promise.resolve(envelope(config)),
    'status.get': () => Promise.resolve(envelope(status())),
    'inbox.operator': () => Promise.resolve(envelope(inbox(2))),
    'task.get': () => Promise.resolve(envelope(taskGet())),
    'task.history': () => Promise.resolve(envelope(taskHistory())),
  };
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamFails = false;
  const fetcher: typeof fetch = (url, init) => {
    const path = url instanceof Request ? url.url : url.toString();
    if (path === '/v1/events') {
      if (streamFails) return Promise.resolve(new Response(null, { status: 502 }));
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              stream = value;
            },
          }),
        ),
      );
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      input: Record<string, unknown>;
    };
    return routes[path.replace('/v1/ops/', '') as OpId](body.input);
  };
  return {
    fetcher,
    routes,
    send(value: string) {
      stream?.enqueue(new TextEncoder().encode(value));
    },
    endStream() {
      stream?.close();
    },
    failStream() {
      streamFails = true;
    },
  };
}
export type Daemon = ReturnType<typeof daemon>;
export const hello = 'event: hello\ndata: {"head":1,"instance":"one"}\n\n';

// Status bar and services panel fixtures.
export const T = '2026-11-15T14:40:00.000Z';
export const T_TEXT = '14:40 15/11/26';
export const HEALTHY = [
  service('daemon', 'healthy'),
  service('slack', 'healthy'),
  service('github', 'healthy'),
  service('spur', 'healthy'),
];
export const SLACK_UP = { gateway: 'slack', state: 'up', since: null, reason: null, spaces: [] };
export const polled = (name: string, extra: Record<string, unknown> = {}) =>
  source(name, { observedAt: T, lastCompleteAt: T, healthySince: T, ...extra });
export const PR = 'github:a:ex/repo';
export const ISSUES = 'github-issues:a:ex/repo';
const SPUR_BLIND = polled('spur', {
  blindReason: 'stale',
  message: 'Spur has not answered',
  stale: true,
  healthySince: null,
});
export const SPUR_DOWN_LINE = 'Spur is unavailable: no answer for 40 minutes';
/** Spur blind stale, with its services row failing and the Spur availability line set. */
export const spurBlind = () =>
  status(undefined, [polled(PR), SPUR_BLIND], {
    services: [...HEALTHY.filter((row) => row.service !== 'spur'), service('spur', 'failing')],
    transport: [SLACK_UP],
    spurUnavailable: SPUR_DOWN_LINE,
  });
export const healthy = () =>
  status(undefined, [polled(PR), polled(ISSUES), polled('spur')], {
    services: HEALTHY,
    transport: [SLACK_UP],
  });
