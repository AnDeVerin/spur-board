// Scenarios as code: each one seeds a named board state through the public API, the fakes and,
// where no operation exists yet, a listed direct write. `index.ts` holds the types, the registry
// and the clients a seed gets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPERATIONS,
  successEnvelopeSchema,
  type Config,
  type OperationId,
} from '@spur-board/contracts';
import type { InProcessDaemon } from '@spur-board/daemon/in-process';
import type { z } from 'zod';
import type { RouteResult } from '../control.ts';
import type { StandManifest } from '../manifest.ts';
import { columnsBasic, columnsBasicJira } from './columns-basic.ts';
import { empty } from './empty.ts';
import { questionToOperator } from './question-to-operator.ts';
import { sourceBlind, sourceBlindJira } from './source-blind.ts';
import { spurSourceSilent } from './spur-source-silent.ts';
import { tokenApproval } from './token-approval.ts';
import { workerKilledNoPr, workerKilledNoPrJira } from './worker-killed-no-pr.ts';

/** How often `until` and `wait` look again. */
const WAIT_STEP_MS = 100;
const DEFAULT_WAIT_MS = 30_000;

/** What a seed names, by group; the stand writes it into `stand.json` beside the name. */
export type ScenarioEntities = Omit<NonNullable<StandManifest['scenario']>, 'name'>;

export type Settled = { ok: true } | { ok: false; diagnostics: unknown };

type Role = 'operator' | 'worker' | 'orchestrator';
type Op<Id extends OperationId> = Extract<(typeof OPERATIONS)[number], { id: Id }>;
type Db = InProcessDaemon['store']['db'];

/** The board as a seed sees it: the public API by role, plus the stand's own poll and checks. */
export interface Board {
  /** The stand's role sessions; `worker` and `orchestrator` call with these. */
  readonly roles: StandManifest['roles'];
  /** One operation through `POST /v1/ops/<id>`; a non-2xx answer throws. */
  call<Id extends OperationId>(
    role: Role,
    id: Id,
    input: z.input<Op<Id>['input']>,
    key?: string,
  ): Promise<z.output<Op<Id>['output']>>;
  /** Restarts the adapter runner, ticks and pulses the outbox; the outcome of each source. */
  poll(): Promise<Record<string, string>>;
  /**
   * Moves the stand clock forward by `ms`, ticks and pulses the outbox once like `stand clock`;
   * the adapter runner keeps its state. A shift outside 1..MAX_SHIFT_MS throws.
   */
  shiftClock(ms: number): Promise<void>;
  check(condition: string): Promise<Settled>;
  /** Re-checks `condition` until it holds; throws once `timeoutMs` passes. */
  wait(condition: string, timeoutMs?: number): Promise<void>;
  /** The anonymous token request an operator's `board token request` sends. */
  requestToken(input: { name: string; folder: string; host: string; hash: string }): Promise<void>;
  /** A write no operation can make yet; `note` says why and lands in `scenario.direct`. */
  direct(note: string, write: (db: Db) => Promise<unknown>): Promise<void>;
  /** How often `text` occurs in the daemon log. */
  logCount(text: string): number;
  /** Re-runs `predicate` until it is true; throws `<label> not reached in <ms> ms` after `ms`. */
  until(label: string, ms: number, predicate: () => boolean | Promise<boolean>): Promise<void>;
}

export interface SlackMessage {
  n: number;
  text: string;
  actions: string[];
}

/** The stand's fakes as a seed sees them; a non-2xx answer throws. */
export interface ScenarioFakes {
  spur(verb: string, args?: Record<string, unknown>): Promise<unknown>;
  github(verb: string, args?: Record<string, unknown>): Promise<unknown>;
  jira(verb: string, args?: Record<string, unknown>): Promise<unknown>;
  slack: {
    outbox(): Promise<{ messages: SlackMessage[]; violations: unknown[] }>;
    click(message: number, button: string, text?: string): Promise<unknown>;
  };
}

interface SettledContext {
  board: Board;
  fakes: ScenarioFakes;
  entities: ScenarioEntities;
}

export interface Scenario {
  name: string;
  summary: string;
  /** Merged into the stand's config; only thresholds and adapters may change. */
  config?: { thresholds?: Partial<Config['thresholds']>; adapters?: Record<string, object> };
  seed(board: Board, fakes: ScenarioFakes, clock: { now(): number }): Promise<ScenarioEntities>;
  /** Whether the state the seed set up has arrived; `stand wait scenario` re-runs it. */
  settled(context: SettledContext): Promise<Settled>;
}

export const SCENARIOS: readonly Scenario[] = [
  empty,
  columnsBasic,
  questionToOperator,
  workerKilledNoPr,
  spurSourceSilent,
  sourceBlind,
  tokenApproval,
  columnsBasicJira,
  workerKilledNoPrJira,
  sourceBlindJira,
];

export const scenarioNames = (scenarios: readonly Scenario[] = SCENARIOS): string[] =>
  scenarios.map(({ name }) => name);

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base: unknown, extra: unknown): unknown {
  if (!isPlain(base) || !isPlain(extra)) return extra;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) result[key] = merge(base[key], value);
  return result;
}

/** The stand's config with the scenario's `thresholds` and `adapters` deep-merged in. */
export function mergeConfig(
  config: Record<string, unknown>,
  extra: NonNullable<Scenario['config']>,
): Record<string, unknown> {
  return {
    ...config,
    ...(extra.thresholds === undefined
      ? {}
      : { thresholds: merge(config['thresholds'], extra.thresholds) }),
    ...(extra.adapters === undefined
      ? {}
      : { adapters: merge(config['adapters'], extra.adapters) }),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('The stand is stopping.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function answer(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} answered ${String(response.status)}: ${text}`);
  return successEnvelopeSchema.parse(JSON.parse(text)).value;
}

/**
 * The board client of one running daemon. `signal` aborts every wait when the stand stops, so a
 * seed cannot hold shutdown. `notes` collects what `direct` wrote.
 */
export function createBoardClient(options: {
  daemonUrl: string;
  operatorToken: string;
  roles: StandManifest['roles'];
  home: string;
  db: Db;
  poll: () => Promise<RouteResult>;
  clock: (shiftMs: number) => Promise<RouteResult>;
  check: (condition: string) => Promise<Settled>;
  signal: AbortSignal;
}): { board: Board; notes: string[] } {
  const { signal } = options;
  const notes: string[] = [];
  const stopped = (): void => {
    if (signal.aborted) throw new Error('The stand is stopping.');
  };
  const board: Board = {
    roles: options.roles,
    async call(role, id, input, key) {
      stopped();
      const op = OPERATIONS.find((candidate) => candidate.id === id);
      if (op === undefined) throw new Error(`Unknown operation ${id}.`);
      const response = await fetch(`${options.daemonUrl}/v1/ops/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(role === 'operator'
            ? { authorization: `Bearer ${options.operatorToken}` }
            : { 'x-board-session': options.roles[role] }),
        },
        body: JSON.stringify({ input, ...(key === undefined ? {} : { key }) }),
        signal,
      });
      return op.output.parse(await answer(response, id)) as never;
    },
    async poll() {
      stopped();
      const result = await options.poll();
      if (result.status !== 200)
        throw new Error(`poll answered ${String(result.status)}: ${JSON.stringify(result.body)}`);
      const { outcomes } = result.body as { outcomes: { source: string; outcome: string }[] };
      return Object.fromEntries(outcomes.map(({ source, outcome }) => [source, outcome]));
    },
    async shiftClock(ms) {
      stopped();
      const result = await options.clock(ms);
      if (result.status !== 200)
        throw new Error(`clock answered ${String(result.status)}: ${JSON.stringify(result.body)}`);
    },
    check: options.check,
    async wait(condition, timeoutMs = DEFAULT_WAIT_MS) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        stopped();
        const result = await options.check(condition);
        if (result.ok) return;
        if (Date.now() >= deadline)
          throw new Error(
            `${condition} not reached in ${String(timeoutMs)} ms: ${JSON.stringify(result.diagnostics)}`,
          );
        await sleep(WAIT_STEP_MS, signal);
      }
    },
    async requestToken(input) {
      stopped();
      const response = await fetch(`${options.daemonUrl}/v1/tokens/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      });
      await answer(response, 'token request');
    },
    async direct(note, write) {
      stopped();
      await write(options.db);
      notes.push(note);
    },
    logCount(text) {
      const log = readFileSync(join(options.home, 'logs', 'daemon.log'), 'utf8');
      return log.split(text).length - 1;
    },
    async until(label, ms, predicate) {
      const deadline = Date.now() + ms;
      for (;;) {
        stopped();
        if (await predicate()) return;
        if (Date.now() >= deadline) throw new Error(`${label} not reached in ${String(ms)} ms`);
        await sleep(WAIT_STEP_MS, signal);
      }
    },
  };
  return { board, notes };
}

/** The fakes over the stand's own routes, never over HTTP: a seed runs inside the control queue. */
export function createScenarioFakes(routes: {
  fake(body: { system: string; verb: string; args: unknown }): Promise<RouteResult>;
  slackOutbox(): Promise<RouteResult>;
  slackClick(body: { message: number; button: string; text?: string }): Promise<RouteResult>;
}): ScenarioFakes {
  const ok = async (what: string, result: Promise<RouteResult>): Promise<unknown> => {
    const { status, body } = await result;
    if (status < 200 || status >= 300)
      throw new Error(`${what} answered ${String(status)}: ${JSON.stringify(body)}`);
    return body;
  };
  return {
    spur: (verb, args = {}) => ok(`fake spur ${verb}`, routes.fake({ system: 'spur', verb, args })),
    github: (verb, args = {}) =>
      ok(`fake github ${verb}`, routes.fake({ system: 'github', verb, args })),
    jira: (verb, args = {}) => ok(`fake jira ${verb}`, routes.fake({ system: 'jira', verb, args })),
    slack: {
      outbox: async () =>
        (await ok('fake slack outbox', routes.slackOutbox())) as {
          messages: SlackMessage[];
          violations: unknown[];
        },
      click: (message, button, text) =>
        ok(
          'fake slack click',
          routes.slackClick({ message, button, ...(text === undefined ? {} : { text }) }),
        ),
    },
  };
}
