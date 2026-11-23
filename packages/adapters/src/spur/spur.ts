// Reads Spur's live session list and resolves linked sessions that leave it.
import {
  AdapterError,
  apiBaseUrl,
  SESSION_HEALTH_STATES,
  SESSION_STATUSES,
  parseRingMarker,
  prRefSchema,
  sessionFactsSchema,
  sessionTransitionSchema,
  sourceCursorSchema,
  type Adapter,
  type Batch,
  type PollContext,
  type SessionFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';
import { parseWire } from '../runner/wire.ts';

/** The timeout of `GET sessions` and `GET sessions/<id>`. */
const REQUEST_TIMEOUT_MS = 5_000;
/** The timeout of one `GET sessions/transitions` page: Spur refreshes every session on each one. */
const TRANSITIONS_TIMEOUT_MS = 15_000;
/** The longest wait between two failed Spur polls, so Spur load episodes blind the board briefly. */
export const SPUR_MAX_BACKOFF_MS = 60_000;

/** Where a Spur request was when it failed: the path without its query, its page and its time. */
interface SpurRequestPlace {
  path: string;
  /** The 1-based transitions page; only on `sessions/transitions`. */
  page?: number | undefined;
  durationMs: number;
}

/**
 * A failed Spur request with its place. It never carries `code`: the runner would report it as a
 * source failure.
 */
class SpurRequestError extends AdapterError {
  readonly path: string;
  declare readonly page?: number;
  readonly durationMs: number;

  constructor(
    kind: AdapterError['kind'],
    base: string,
    place: SpurRequestPlace,
    options: { retryAt?: Date | undefined; cause?: unknown } = {},
  ) {
    super(kind, `${base} on ${describePlace(place)} after ${String(place.durationMs)} ms`, options);
    this.path = place.path;
    if (place.page !== undefined) this.page = place.page;
    this.durationMs = place.durationMs;
  }
}

function describePlace(place: { path: string; page?: number | undefined }): string {
  return place.page === undefined ? place.path : `${place.path} page ${String(place.page)}`;
}
const sessionWire = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  branch: z.string().nullable().optional(),
  status: z.string().min(1),
  state: z.string().min(1),
  rateLimitResetAt: z.iso.datetime().optional(),
  lastActivityAt: z.iso.datetime().nullable().optional(),
  slots: z
    .object({
      links: z.array(z.object({ label: z.string().min(1), url: z.url() })).optional(),
    })
    .optional(),
  queuedMessages: z.object({ messages: z.array(z.string()) }).optional(),
});
const transitionWire = z.object({
  cursor: z.string().min(1),
  sessionId: z.string().min(1),
  project: z.string().min(1),
  at: z.iso.datetime(),
  links: z.array(z.object({ label: z.string().min(1), url: z.url() })),
  kind: z.enum(['status', 'state']),
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
  rateLimitResetAt: z.iso.datetime().optional(),
});
const transitionsWire = z.object({
  entries: z.array(transitionWire).max(1000),
  nextCursor: sourceCursorSchema,
  hasMore: z.boolean(),
});
const foreignCursorWire = z.object({ error: z.literal('Invalid or foreign transitions cursor') });
type SessionWire = z.output<typeof sessionWire>;

interface HealthObservation {
  stable: string;
  since: string;
  candidate?: { value: string; since: string };
}

export type SpurNotice =
  | { kind: 'unknown_state'; value: string }
  | { kind: 'unknown_status'; value: string }
  | { kind: 'restart'; previousInstanceId: string; instanceId: string };

export interface SpurAdapterOptions {
  baseUrl: string;
  intervalMs: number;
  flipSmoothingMs: number;
  now: () => number;
  fetch?: typeof fetch;
  /** Receives a note about a successful request that took more than half its timeout. */
  warn?: ((message: string) => void) | undefined;
  onNotice?: ((notice: SpurNotice) => void | Promise<void>) | undefined;
}

/** The board rings a session's queue still holds, sorted and deduped; other queued text is dropped. */
function queuedBoardRings(wire: SessionWire): { notification: number; ring: number }[] {
  const rings = new Map<string, { notification: number; ring: number }>();
  for (const message of wire.queuedMessages?.messages ?? []) {
    const parsed = parseRingMarker(message);
    if (parsed) rings.set(`${String(parsed.notification)}-${String(parsed.ring)}`, parsed);
  }
  return [...rings.values()].sort((a, b) => a.notification - b.notification || a.ring - b.ring);
}

/** A single Spur source. State is scoped to this adapter instance, never shared across daemons. */
export function createSpurAdapter(options: SpurAdapterOptions): Adapter {
  const base = apiBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  let health = new Map<string, HealthObservation>();
  let instanceId: string | undefined;
  const unknownHealthValues = new Set<string>();
  const unknownStatusValues = new Set<string>();
  const isKnownHealth = (value: string) => SESSION_HEALTH_STATES.some((state) => state === value);
  const isKnownStatus = (value: string) => SESSION_STATUSES.some((status) => status === value);

  interface SpurResponse {
    response: Response;
    body?: unknown;
    place: SpurRequestPlace;
  }

  /** The HTTP-status failure of a finished request, with its place. */
  function httpFailure({ response, place }: SpurResponse): SpurRequestError {
    const failure = classifyHttpFailure(
      { status: response.status, headers: response.headers },
      options.now(),
    );
    return new SpurRequestError(failure.kind, failure.message, place, {
      retryAt: failure.retryAt,
      cause: failure,
    });
  }

  /**
   * Any error raised while handling a finished request's response, as a failure of that request.
   * An `AdapterError` keeps its kind, retry time and message. A zod error names only its first
   * path and carries no cause, so no wire value reaches the log, as in `parseWire`.
   */
  function atPlace({ place }: SpurResponse, error: unknown): SpurRequestError {
    if (error instanceof SpurRequestError) return error;
    if (error instanceof AdapterError)
      return new SpurRequestError(error.kind, error.message, place, {
        retryAt: error.retryAt,
        cause: error,
      });
    if (error instanceof z.ZodError) {
      const path = (error.issues[0]?.path ?? []).map(String).join('.');
      return new SpurRequestError(
        'transient',
        `Invalid Spur response at ${path || '(root)'}`,
        place,
      );
    }
    return new SpurRequestError('transient', 'Invalid Spur response', place, { cause: error });
  }

  async function request(
    path: string,
    signal: AbortSignal,
    timeoutMs: number,
    page?: number,
  ): Promise<SpurResponse> {
    if (signal.aborted) throw new Error('Spur poll aborted');
    const started = options.now();
    const placeName = path.split('?')[0] ?? path;
    const place = (): SpurRequestPlace => ({
      path: placeName,
      ...(page === undefined ? {} : { page }),
      durationMs: options.now() - started,
    });
    const controller = new AbortController();
    let timedOut = false;
    const callerAborted = () => signal.aborted;
    const didTimeOut = () => timedOut;
    const onAbort = () => {
      controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, base), { signal: controller.signal });
      if (!response.ok && response.status !== 410 && response.status !== 400)
        return { response, place: place() };
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new SpurRequestError('transient', 'Invalid Spur response JSON', place(), {
          cause: error,
        });
      }
      const done = place();
      if (response.ok && done.durationMs > timeoutMs / 2)
        options.warn?.(
          `Slow Spur request: ${describePlace(done)} took ${String(done.durationMs)} ms of a ${String(timeoutMs)} ms timeout`,
        );
      return { response, body, place: done };
    } catch (error) {
      if (callerAborted()) throw new Error('Spur poll aborted', { cause: error });
      if (didTimeOut())
        throw new SpurRequestError('transient', 'Spur request timed out', place(), {
          cause: error,
        });
      if (error instanceof AdapterError) throw error;
      throw new SpurRequestError('transient', 'Spur request failed', place(), { cause: error });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function smooth(
    wire: SessionWire,
    observedAt: string,
    previous: HealthObservation | undefined,
  ): HealthObservation {
    // An unfamiliar state must suppress health flags immediately, even during smoothing.
    if (!isKnownHealth(wire.state)) {
      return {
        stable: wire.state,
        since: previous?.stable === wire.state ? previous.since : observedAt,
      };
    }
    if (previous === undefined) {
      return { stable: wire.state, since: observedAt };
    }
    if (wire.state === previous.stable) {
      return { stable: previous.stable, since: previous.since };
    }
    const candidate =
      previous.candidate?.value === wire.state
        ? previous.candidate
        : { value: wire.state, since: observedAt };
    if (Date.parse(observedAt) - Date.parse(candidate.since) >= options.flipSmoothingMs) {
      return { stable: wire.state, since: candidate.since };
    }
    return { ...previous, candidate };
  }

  function facts(
    wire: SessionWire,
    observedAt: string,
    state: HealthObservation,
    endReason: 'complete' | 'kill' | null,
    at: readonly (string | number)[],
  ): SessionFacts {
    const links = Object.fromEntries(
      (wire.slots?.links ?? []).map(({ label, url }) => [label, url]),
    );
    const prUrl = links['pr'];
    let pr: SessionFacts['pr'] = null;
    if (prUrl !== undefined) {
      const url = new URL(prUrl);
      const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.hostname === 'github.com' && match?.[1] && match[2] && match[3]) {
        const parsed = prRefSchema.safeParse({
          repo: `${match[1]}/${match[2]}`,
          number: Number(match[3]),
        });
        if (parsed.success) pr = parsed.data;
      }
    }
    const queuedRings = queuedBoardRings(wire);
    return parseWire(
      sessionFactsSchema,
      {
        id: wire.id,
        spurProject: wire.project,
        branch: wire.branch ?? null,
        pr,
        links,
        lifecycle: wire.status,
        health: state.stable,
        healthSince: state.since,
        ...(wire.state === 'rate_limited' &&
        state.stable === 'rate_limited' &&
        wire.rateLimitResetAt !== undefined
          ? { rateLimitResetAt: wire.rateLimitResetAt }
          : {}),
        lastActivityAt: wire.lastActivityAt ?? null,
        endedAt: endReason === null ? null : observedAt,
        endReason,
        ...(queuedRings.length > 0 ? { queuedRings } : {}),
      },
      'Invalid Spur session',
      at,
    );
  }

  return {
    id: 'spur',
    intervalMs: options.intervalMs,
    async poll(ctx: PollContext): Promise<Batch> {
      const observedAt = new Date(options.now()).toISOString();
      let cursor = ctx.cursor;
      const sessionTransitions: NonNullable<Batch['sessionTransitions']> = [];
      const positions = new Set<string>();
      for (let page = 0; page < 4; page++) {
        const query = new URLSearchParams({ limit: '1000', kinds: 'status,state' });
        if (cursor !== undefined) query.set('since', cursor);
        const transitions = await request(
          `sessions/transitions?${query.toString()}`,
          ctx.signal,
          TRANSITIONS_TIMEOUT_MS,
          page + 1,
        );
        const { response, body } = transitions;
        try {
          if (
            page === 0 &&
            cursor !== undefined &&
            response.status === 400 &&
            foreignCursorWire.safeParse(body).success
          ) {
            // A replacement stream cannot use the stored position. Bootstrap once; this failed
            // request consumes one of the four slots, and only a validated batch replaces it.
            cursor = undefined;
            continue;
          }
          if (response.status === 410) {
            cursor = parseWire(
              z.object({ latestCursor: sourceCursorSchema }),
              body,
              'Invalid Spur expired cursor',
            ).latestCursor;
            sessionTransitions.length = 0;
            break;
          }
          if (!response.ok) throw httpFailure(transitions);
          const feed = parseWire(transitionsWire, body, 'Invalid Spur transitions');
          for (const [index, entry] of feed.entries.entries()) {
            if (positions.has(entry.cursor) || entry.cursor === cursor)
              throw new AdapterError('transient', 'Repeated Spur transition position');
            positions.add(entry.cursor);
            sessionTransitions.push(
              parseWire(
                sessionTransitionSchema,
                {
                  position: entry.cursor,
                  session: entry.sessionId,
                  spurProject: entry.project,
                  at: entry.at,
                  links: Object.fromEntries(entry.links.map(({ label, url }) => [label, url])),
                  dimension: entry.kind === 'status' ? 'lifecycle' : 'health',
                  from: entry.from,
                  to: entry.to,
                  ...(entry.rateLimitResetAt === undefined
                    ? {}
                    : { rateLimitResetAt: entry.rateLimitResetAt }),
                },
                'Invalid Spur transition',
                ['entries', index],
              ),
            );
          }
          if (feed.hasMore && (feed.nextCursor === cursor || feed.entries.length === 0))
            throw new AdapterError('transient', 'Spur transitions made no progress');
          cursor = feed.nextCursor;
          if (!feed.hasMore) break;
        } catch (error) {
          throw atPlace(transitions, error);
        }
      }
      const list = await request('sessions', ctx.signal, REQUEST_TIMEOUT_MS);
      const { response: listResponse } = list;
      if (!listResponse.ok) throw httpFailure(list);
      const newInstanceId = listResponse.headers.get('x-spur-lifecycle-instance-id') ?? undefined;
      const restartNotice: SpurNotice | undefined =
        instanceId !== undefined && newInstanceId !== undefined && newInstanceId !== instanceId
          ? { kind: 'restart', previousInstanceId: instanceId, instanceId: newInstanceId }
          : undefined;
      const previous = restartNotice
        ? new Map(
            [...health].map(([id, observation]) => [
              id,
              { stable: observation.stable, since: observation.since },
            ]),
          )
        : health;
      const next = new Map<string, HealthObservation>();
      const items: Batch['items'] = [];
      let listed: SessionWire[];
      try {
        listed = parseWire(z.array(sessionWire), list.body, 'Invalid Spur response');
        for (const [index, wire] of listed.entries()) {
          if (next.has(wire.id))
            throw new AdapterError('transient', `Duplicate Spur session ${wire.id}`);
          const state = smooth(wire, observedAt, previous.get(wire.id));
          next.set(wire.id, state);
          items.push({ kind: 'session', facts: facts(wire, observedAt, state, null, [index]) });
        }
      } catch (error) {
        throw atPlace(list, error);
      }
      const byId = new Map(listed.map((wire) => [wire.id, wire]));
      const detail = new Map<string, SessionWire | null>();
      for (const ref of ctx.observe.sessions) {
        if (byId.has(ref.id) || detail.has(ref.id)) continue;
        const read = await request(
          `sessions/${encodeURIComponent(ref.id)}`,
          ctx.signal,
          REQUEST_TIMEOUT_MS,
        );
        const { response } = read;
        if (response.status === 404) {
          detail.set(ref.id, null);
          continue;
        }
        if (!response.ok) throw httpFailure(read);
        try {
          const wire = parseWire(sessionWire, read.body, 'Invalid Spur response');
          if (wire.id !== ref.id)
            throw new AdapterError('transient', 'Unresolved Spur session detail');
          const state = smooth(wire, observedAt, previous.get(wire.id));
          const endReason =
            wire.status === 'completed' ? 'complete' : wire.status === 'killed' ? 'kill' : null;
          if (endReason === null) next.set(wire.id, state);
          items.push({ kind: 'session', facts: facts(wire, observedAt, state, endReason, []) });
          detail.set(ref.id, wire);
        } catch (error) {
          throw atPlace(read, error);
        }
      }
      if (ctx.signal.aborted) throw new Error('Spur poll aborted');
      const entities: Batch['entities'] = ctx.observe.sessions.map((ref) => ({
        ref,
        status: byId.has(ref.id) || detail.get(ref.id) !== null ? 'ok' : 'not_found',
      }));
      const batch: Batch = {
        source: 'spur',
        observedAt,
        complete: true,
        items,
        entities,
        sessionTransitions,
        ...(cursor === undefined ? {} : { cursor }),
      };
      if (restartNotice) await options.onNotice?.(restartNotice);
      for (const wire of [...listed, ...detail.values()]) {
        if (wire === null) continue;
        if (!isKnownHealth(wire.state) && !unknownHealthValues.has(wire.state)) {
          await options.onNotice?.({ kind: 'unknown_state', value: wire.state });
          unknownHealthValues.add(wire.state);
        }
        if (!isKnownStatus(wire.status) && !unknownStatusValues.has(wire.status)) {
          await options.onNotice?.({ kind: 'unknown_status', value: wire.status });
          unknownStatusValues.add(wire.status);
        }
      }
      health = next;
      instanceId = newInstanceId;
      return batch;
    },
  };
}
