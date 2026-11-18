/** Test-only fixture server for shell QA before the production listener lands. */
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserOperations, statusOutputSchema } from '../packages/contracts/src/browser.ts';
import { renderHttpProblem } from '../packages/contracts/src/error-renderers.ts';

export const shellScenarios = [
  'loading',
  'empty',
  'healthy',
  'mixed',
  'read-error',
  'refresh-error',
  'recovered',
  'stream-drop',
] as const;
type Scenario = (typeof shellScenarios)[number];
export function shellFixture(scenario: Scenario) {
  const count =
    scenario === 'empty' || scenario === 'loading' ? 0 : scenario === 'recovered' ? 2 : 1;
  const at = '2026-01-05T09:30:00.000Z';
  return statusOutputSchema.parse({
    items: [],
    warmingUp: false,
    spurUnavailable: null,
    hostLoad: null,
    host: null,
    services: [],
    transport: [],
    sources:
      count === 0
        ? []
        : Array.from({ length: scenario === 'mixed' ? 12 : 2 }, (_, i) => ({
            source:
              scenario === 'mixed'
                ? `github:project-with-a-long-source-name-for-footer-wrapping-${String(i + 1)}`
                : `github:project-${String(i + 1)}`,
            observedAt: at,
            lastCompleteAt: at,
            blindReason: scenario === 'mixed' && i % 3 === 0 ? 'auth' : null,
            message: null,
            budget: null,
            stale: scenario === 'mixed' && i % 2 === 0,
            healthySince: scenario === 'mixed' && i % 3 === 0 ? null : at,
            warmingUp: false,
          })),
    tasks: Array.from({ length: count }, (_, i) => ({
      key: `PROJ-${String(i + 1)}`,
      project: 'web',
      column: 'dev',
      columnEnteredAt: null,
      membership: 'active',
      state: 'ticket not observed',
      prCount: 0,
      sessionCount: 0,
      openBlocks: 0,
      blocks: [],
      turn: null,
      prSummary: null,
      links: { ticket: null, prs: [], sessions: [] },
    })),
    columnGroups: [{ id: 'todo', columns: ['todo', 'triage', 'ready-for-dev'] }],
    projectBlocks: [],
    unlinkedPrs: [],
    unlinkedSessions: [],
    hiddenUnlinkedPrs: 0,
    hiddenUnlinkedSessions: 0,
    bindings: { columns: [], operators: [], defaultAddressee: null },
    daemon: { version: '0.4.0', startedAt: at, lastDispatchAt: null },
  });
}
/** The one project the shell fixture's status rows belong to. */
export function shellConfig() {
  return browserOperations['config.get'].output.parse({
    projects: [
      {
        id: 'web',
        columns: [
          { id: 'todo', executor: { kind: 'dispatcher', name: null } },
          { id: 'dev', executor: { kind: 'worker', name: null } },
          { id: 'done', executor: { kind: 'dispatcher', name: null } },
        ],
        dispatcher: { mode: 'on' },
        spurProjects: [],
        ticketBrowseBase: null,
        checksGate: 'dev',
      },
    ],
    web: { publicOrigin: null, spurUiOrigin: null },
  });
}
export function shellInbox() {
  return browserOperations['inbox.operator'].output.parse({ items: [], handled: [] });
}
/** The first status row of the fixture as task.get answers it, with why. */
export function shellTask() {
  const at = '2026-01-05T09:30:00.000Z';
  return browserOperations['task.get'].output.parse({
    task: { key: 'PROJ-1', project: 'web', column: 'dev', membership: 'active' },
    turn: null,
    links: [],
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
          conditions: [{ condition: 'pr_open', state: 'failed', reason: 'no_pr' }],
        },
      ],
      checksWaivedBy: null,
      turn: null,
      moves: [
        {
          at,
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
  });
}
/** The fixture task's history as task.history answers it, oldest first. */
export function shellHistory() {
  return browserOperations['task.history'].output.parse({
    task: { key: 'PROJ-1', project: 'web', column: 'dev', membership: 'active' },
    events: [
      { at: '2026-01-05T09:00:00.000Z', kind: 'task_added', actor: 'operator', summary: 'Added.' },
      {
        at: '2026-01-05T09:10:00.000Z',
        kind: 'turn_taken',
        actor: 'operator',
        via: 'slack',
        summary: 'Took the turn.',
      },
      {
        at: '2026-01-05T09:30:00.000Z',
        kind: 'task_moved',
        actor: 'system',
        summary: 'Moved to Dev.',
      },
    ],
  });
}
const shellReads = {
  'columns.describe': () => browserOperations['columns.describe'].output.parse({ projects: [] }),
  'status.get': shellFixture,
  'config.get': shellConfig,
  'inbox.operator': shellInbox,
  'task.get': shellTask,
  'task.history': shellHistory,
} satisfies Record<string, (scenario: Scenario) => unknown>;
type ShellRead = keyof typeof shellReads;
export function createShellQaServer(
  webRoot = resolve(import.meta.dirname, '../packages/web/dist'),
) {
  if (!existsSync(resolve(webRoot, 'index.html')))
    throw new Error('Build web assets before starting shell QA.');
  let scenario: Scenario = 'healthy';
  let head = 1;
  const streams = new Set<ServerResponse>();
  const held = new Map<ServerResponse, ShellRead>();
  const answer = (response: ServerResponse, read: ShellRead) => {
    if (scenario === 'read-error' || scenario === 'refresh-error') {
      const problem = renderHttpProblem({ code: 'unexpected', requestId: 'fixture' });
      response
        .writeHead(problem.status, { 'content-type': 'application/problem+json' })
        .end(JSON.stringify(problem.body));
    } else
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, requestId: 'fixture', value: shellReads[read](scenario) }));
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path.startsWith('/__qa/scenario/')) {
      const next = shellScenarios.find((name) => name === path.slice('/__qa/scenario/'.length));
      if (!next) {
        response.writeHead(404).end();
        return;
      }
      scenario = next;
      head++;
      for (const stream of streams) {
        if (scenario === 'stream-drop') stream.end();
        else stream.write(`event: invalidate\ndata: {"projects":["web"]}\n\n`);
      }
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && path === '/__qa/release') {
      for (const [pending, read] of held) answer(pending, read);
      held.clear();
      response.writeHead(204).end();
      return;
    }
    const read = Object.keys(shellReads).find((id) => path === `/v1/ops/${id}`) as
      ShellRead | undefined;
    if (request.method === 'POST' && read) {
      request.resume();
      if (scenario === 'loading') {
        held.set(response, read);
        response.on('close', () => held.delete(response));
      } else answer(response, read);
      return;
    }
    if (request.method === 'GET' && path === '/v1/events') {
      if (scenario === 'stream-drop') {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`event: hello\ndata: ${JSON.stringify({ head, instance: 'shell-qa' })}\n\n`);
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (request.method !== 'GET' || !/^(?:index[.]html|assets\/[A-Za-z0-9_.-]+)$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    const target = resolve(webRoot, file);
    if (!existsSync(target)) {
      response.writeHead(404).end();
      return;
    }
    const mime = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.woff2')
          ? 'font/woff2'
          : 'text/html';
    response.writeHead(200, { 'content-type': mime }).end(readFileSync(target));
  });
  server.on('close', () => {
    for (const response of [...streams, ...held.keys()]) response.destroy();
  });
  return server;
}
if (import.meta.main) {
  const index = process.argv.indexOf('--port');
  const port = Number(index < 0 ? 4780 : process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Pass --port between 1024 and 65535.');
  const server = createShellQaServer();
  server.listen(port, '127.0.0.1', () =>
    process.stdout.write(`Shell QA fixture: http://127.0.0.1:${String(port)}\n`),
  );
  const stop = () => {
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
