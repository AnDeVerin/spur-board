// Reads Spur's live session list and resolves linked sessions that leave it.
import {
  AdapterError,
  SESSION_HEALTH_STATES,
  prRefSchema,
  sessionFactsSchema,
  type Adapter,
  type Batch,
  type PollContext,
  type SessionFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';

const REQUEST_TIMEOUT_MS = 5_000;
const sessionWire = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  branch: z.string().nullable().optional(),
  status: z.string().min(1),
  state: z.string().min(1),
  lastActivityAt: z.iso.datetime().nullable().optional(),
  slots: z
    .object({
      links: z.array(z.object({ label: z.string().min(1), url: z.url() })).optional(),
    })
    .optional(),
});
type SessionWire = z.output<typeof sessionWire>;

interface HealthObservation {
  stable: string;
  since: string;
  candidate?: { value: string; since: string };
}

export type SpurNotice =
  | { kind: 'unknown_state'; value: string }
  | { kind: 'restart'; previousInstanceId: string; instanceId: string };

export interface SpurAdapterOptions {
  baseUrl: string;
  intervalMs: number;
  flipSmoothingMs: number;
  fetch?: typeof fetch;
  onNotice?: ((notice: SpurNotice) => void) | undefined;
}

/** A single Spur source. State is scoped to this adapter instance, never shared across daemons. */
export function createSpurAdapter(options: SpurAdapterOptions): Adapter {
  const base = new URL(`${options.baseUrl.replace(/\/$/, '')}/`);
  const fetchImpl = options.fetch ?? fetch;
  let health = new Map<string, HealthObservation>();
  let instanceId: string | undefined;
  const unknownValues = new Set<string>();
  const isKnownHealth = (value: string) => SESSION_HEALTH_STATES.some((state) => state === value);

  async function request(
    path: string,
    signal: AbortSignal,
  ): Promise<{ response: Response; body?: unknown }> {
    if (signal.aborted) throw new Error('Spur poll aborted');
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
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(new URL(path, base), { signal: controller.signal });
      if (!response.ok) return { response };
      try {
        return { response, body: await response.json() };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new AdapterError('transient', 'Invalid Spur response JSON', { cause: error });
      }
    } catch (error) {
      if (callerAborted()) throw new Error('Spur poll aborted', { cause: error });
      if (didTimeOut())
        throw new AdapterError('transient', 'Spur request timed out', { cause: error });
      if (error instanceof AdapterError) throw error;
      throw new AdapterError('transient', 'Spur request failed', { cause: error });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function smooth(
    wire: SessionWire,
    observedAt: string,
    next: Map<string, HealthObservation>,
  ): HealthObservation {
    const previous = next.get(wire.id);
    // An unfamiliar state must suppress health flags immediately, even during smoothing.
    if (!isKnownHealth(wire.state)) {
      const unknown = {
        stable: wire.state,
        since: previous?.stable === wire.state ? previous.since : observedAt,
      };
      next.set(wire.id, unknown);
      return unknown;
    }
    if (previous === undefined) {
      const first = { stable: wire.state, since: observedAt };
      next.set(wire.id, first);
      return first;
    }
    if (wire.state === previous.stable) {
      const stable = { stable: previous.stable, since: previous.since };
      next.set(wire.id, stable);
      return stable;
    }
    const candidate =
      previous.candidate?.value === wire.state
        ? previous.candidate
        : { value: wire.state, since: observedAt };
    if (Date.parse(observedAt) - Date.parse(candidate.since) >= options.flipSmoothingMs) {
      const promoted = { stable: wire.state, since: candidate.since };
      next.set(wire.id, promoted);
      return promoted;
    }
    const pending = { ...previous, candidate };
    next.set(wire.id, pending);
    return pending;
  }

  function facts(
    wire: SessionWire,
    observedAt: string,
    next: Map<string, HealthObservation>,
    endReason: 'complete' | 'kill' | null,
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
    const state = smooth(wire, observedAt, next);
    return sessionFactsSchema.parse({
      id: wire.id,
      spurProject: wire.project,
      branch: wire.branch ?? null,
      pr,
      links,
      lifecycle: wire.status,
      health: state.stable,
      healthSince: state.since,
      lastActivityAt: wire.lastActivityAt ?? null,
      endedAt: endReason === null ? null : observedAt,
      endReason,
    });
  }

  return {
    id: 'spur',
    intervalMs: options.intervalMs,
    async poll(ctx: PollContext): Promise<Batch> {
      const observedAt = new Date().toISOString();
      const { response: listResponse, body: listBody } = await request('sessions', ctx.signal);
      if (!listResponse.ok) {
        throw classifyHttpFailure(
          { status: listResponse.status, headers: listResponse.headers },
          Date.now(),
        );
      }
      const listed = z.array(sessionWire).parse(listBody);
      const byId = new Map(listed.map((wire) => [wire.id, wire]));
      const detail = new Map<string, SessionWire | null>();
      for (const ref of ctx.observe.sessions) {
        if (byId.has(ref.id)) continue;
        const { response, body } = await request(
          `sessions/${encodeURIComponent(ref.id)}`,
          ctx.signal,
        );
        if (response.status === 404) {
          detail.set(ref.id, null);
          continue;
        }
        if (!response.ok) {
          throw classifyHttpFailure(
            { status: response.status, headers: response.headers },
            Date.now(),
          );
        }
        const wire = sessionWire.parse(body);
        if (wire.id !== ref.id || (wire.status !== 'completed' && wire.status !== 'killed')) {
          throw new AdapterError('transient', 'Unresolved Spur session detail');
        }
        detail.set(ref.id, wire);
      }
      if (ctx.signal.aborted) throw new Error('Spur poll aborted');
      const next = new Map(health);
      const items: Batch['items'] = [];
      for (const wire of listed) {
        items.push({ kind: 'session', facts: facts(wire, observedAt, next, null) });
      }
      for (const wire of detail.values()) {
        if (wire === null) continue;
        items.push({
          kind: 'session',
          facts: facts(wire, observedAt, next, wire.status === 'completed' ? 'complete' : 'kill'),
        });
      }
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
      };
      health = next;
      const newInstanceId = listResponse.headers.get('x-spur-lifecycle-instance-id') ?? undefined;
      if (instanceId !== undefined && newInstanceId !== undefined && newInstanceId !== instanceId) {
        options.onNotice?.({
          kind: 'restart',
          previousInstanceId: instanceId,
          instanceId: newInstanceId,
        });
      }
      instanceId = newInstanceId;
      for (const wire of [...listed, ...detail.values()]) {
        if (wire === null || isKnownHealth(wire.state) || unknownValues.has(wire.state)) {
          continue;
        }
        unknownValues.add(wire.state);
        options.onNotice?.({ kind: 'unknown_state', value: wire.state });
      }
      return batch;
    },
  };
}
