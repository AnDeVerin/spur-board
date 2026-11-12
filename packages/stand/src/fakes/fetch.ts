// The seam between the stand's pollers and its fake external systems: one in-process `fetch`.
import { z } from 'zod';
import type { RouteResult } from '../control.ts';
import { requestUrl } from '../fake-spur.ts';

const MAX_VIOLATIONS = 100;
const MAX_LOGGED_BODY = 4_096;

/** A request as a fake reads it, whatever form the caller passed to `fetch`. */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  signal: AbortSignal | undefined;
}

interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A request the fake does not know. It lands in the violation log and answers 400. */
export class FakeViolation extends Error {}

/** One external API. Several modules may share a `system`, and with it the failure plan. */
export interface FakeModule {
  readonly system: string;
  claims(url: URL): boolean;
  /** The strict check: throws `FakeViolation`, else returns what answers the request later. */
  prepare(request: FakeRequest): () => FakeAnswer;
  /** Runs one verb of this system; undefined when the verb is not this module's. */
  control(verb: string, args: unknown): RouteResult | undefined;
  reset(): void;
  /** A deep copy of the module's state; a later change never alters it. */
  state(): unknown;
  /** Replaces the module's state with a copy of what `state` returned. */
  restore(state: unknown): void;
}

/** What `createFakes().state()` returns: the failure plan and each module's state, in order. */
export interface FakesState {
  failures: [string, Failure][];
  modules: unknown[];
}

interface Violation {
  system: string;
  method: string;
  url: string;
  reason: string;
  body: string;
}

const failSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('delay'), ms: z.int().nonnegative() }),
  z.strictObject({ mode: z.literal('refuse') }),
  z.strictObject({ mode: z.literal('hang') }),
  z.strictObject({ mode: z.literal('auth') }),
  z.strictObject({ mode: z.literal('rate-limit'), seconds: z.int().nonnegative() }),
  z.strictObject({
    mode: z.literal('server-error'),
    status: z.int().min(500).max(599).default(500),
  }),
  z.strictObject({ mode: z.literal('clear') }),
]);
type Failure = Exclude<z.output<typeof failSchema>, { mode: 'clear' }>;

async function readRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  url: URL,
): Promise<FakeRequest> {
  const source = input instanceof Request ? input : undefined;
  const given = init?.body ?? undefined;
  const body =
    given !== undefined
      ? await new Response(given).text()
      : source === undefined
        ? ''
        : await source.clone().text();
  return {
    method: (init?.method ?? source?.method ?? 'GET').toUpperCase(),
    url,
    headers: new Headers(init?.headers ?? source?.headers),
    body,
    signal: init?.signal ?? source?.signal,
  };
}

function respond({ status, body, headers }: FakeAnswer): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * The stand's fake systems behind one `fetch`. A claimed request goes, in order, through the
 * release latch, the module's strict check, the system's failure plan and the module's answer. A
 * request no module claims goes to the wrapped fetch untouched.
 */
export function createFakes(options: {
  now: () => number;
  modules: readonly ((now: () => number) => FakeModule)[];
}) {
  const modules = options.modules.map((build) => build(options.now));
  const failures = new Map<string, Failure>();
  const held = new Set<(reason: Error) => void>();
  let violations: Violation[] = [];
  let dropped = 0;
  let released = false;
  // A function, so a check after an await reads the flag anew.
  const isReleased = (): boolean => released;

  function record(module: FakeModule, request: FakeRequest, reason: string): Response {
    if (violations.length < MAX_VIOLATIONS)
      violations.push({
        system: module.system,
        method: request.method,
        url: request.url.href,
        reason,
        body: request.body.slice(0, MAX_LOGGED_BODY),
      });
    else dropped += 1;
    return respond({ status: 400, body: { message: `Stand fake violation: ${reason}` } });
  }

  /** Stays pending for `ms`, or until abort or release when `ms` is undefined. */
  function hold(signal: AbortSignal | undefined, ms?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason as Error);
      };
      const onRelease = (reason: Error): void => {
        cleanup();
        reject(reason);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        held.delete(onRelease);
      };
      held.add(onRelease);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (ms !== undefined)
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
    });
  }

  /** Applies the plan: a `Response` replaces the answer, undefined lets the answer through. */
  async function applyFailure(
    failure: Failure | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response | undefined> {
    switch (failure?.mode) {
      case undefined:
        return undefined;
      case 'delay':
        await hold(signal, failure.ms);
        return undefined;
      case 'hang':
        await hold(signal);
        return undefined;
      case 'refuse':
        throw new TypeError('fetch failed: the stand fake refused the connection');
      case 'auth':
        return respond({ status: 401, body: { message: 'Bad credentials' } });
      case 'rate-limit':
        return respond({
          status: 429,
          body: { message: 'Stand fake rate limit' },
          headers: { 'retry-after': String(failure.seconds) },
        });
      case 'server-error':
        return respond({ status: failure.status, body: { message: 'Stand fake server error' } });
    }
  }

  return {
    /** A `fetch` that answers claimed requests from the fakes and passes the rest to `fallback`. */
    wrap(fallback: typeof fetch): typeof fetch {
      return async (input, init) => {
        const url = requestUrl(input);
        const module = modules.find((candidate) => candidate.claims(url));
        if (module === undefined) return fallback(input, init);
        const request = await readRequest(input, init, url);
        if (isReleased()) throw new Error('The stand is stopping.');
        request.signal?.throwIfAborted();
        try {
          const answer = module.prepare(request);
          const failed = await applyFailure(failures.get(module.system), request.signal);
          return failed ?? respond(answer());
        } catch (err) {
          if (err instanceof FakeViolation) return record(module, request, err.message);
          throw err;
        }
      };
    },

    /** Handles one `/fake` body; synchronous, so it answers while a poll hangs. */
    control(body: { system: string; verb: string; args: unknown }): RouteResult {
      const { system, verb, args } = body;
      const owners = modules.filter((module) => module.system === system);
      if (owners.length === 0)
        return {
          status: 400,
          body: { error: 'Unknown system.', systems: [...new Set(modules.map((m) => m.system))] },
        };
      if (verb === 'fail') {
        const parsed = failSchema.safeParse(args);
        if (!parsed.success) return { status: 400, body: { error: z.prettifyError(parsed.error) } };
        const failure = parsed.data;
        if (failure.mode === 'clear') failures.delete(system);
        else failures.set(system, failure);
        return { status: 200, body: { system, failure: failure.mode } };
      }
      for (const module of owners) {
        const result = module.control(verb, args);
        if (result !== undefined) return result;
      }
      return { status: 400, body: { error: 'Unknown verb.' } };
    },

    /** The kept entries, and how many violations there were in all. */
    violations(): { total: number; items: readonly Violation[] } {
      return { total: violations.length + dropped, items: violations };
    },

    /** Back to a fresh start: no failures, no violations, no module state. Keeps the latch. */
    reset(): void {
      failures.clear();
      violations = [];
      dropped = 0;
      for (const module of modules) module.reset();
    },

    /** The failure plan and every module's state; violations are not part of it. */
    state(): FakesState {
      return {
        failures: structuredClone([...failures]),
        modules: modules.map((module) => module.state()),
      };
    },

    /** Replaces the failure plan and every module's state with a copy of `state`. */
    restore(state: FakesState): void {
      failures.clear();
      for (const [system, failure] of structuredClone(state.failures))
        failures.set(system, failure);
      modules.forEach((module, index) => {
        module.restore(state.modules[index]);
      });
    },

    /**
     * Rejects every held or delayed request and, from now on, every claimed request at once. It
     * never clears: a poll queued behind the release must not hang again and hold shutdown.
     */
    release(): void {
      released = true;
      const reason = new Error('The stand is stopping.');
      for (const reject of [...held]) reject(reason);
    },
  };
}

export type Fakes = ReturnType<typeof createFakes>;
