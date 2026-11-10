// Reads Spur's live session list and resolves linked sessions that leave it.
import {
  AdapterError,
  SESSION_HEALTH_STATES,
  SESSION_STATUSES,
  prRefSchema,
  sessionFactsSchema,
  type Adapter,
  type Batch,
  type PollContext,
  type SessionFacts,
} from '@spur-board/contracts';
import { z } from 'zod';
import { classifyHttpFailure } from '../runner/http.ts';
import { parseWire } from '../runner/wire.ts';

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
  | { kind: 'unknown_status'; value: string }
  | { kind: 'restart'; previousInstanceId: string; instanceId: string };

export interface SpurAdapterOptions {
  baseUrl: string;
  intervalMs: number;
  flipSmoothingMs: number;
  now: () => number;
  fetch?: typeof fetch;
  onNotice?: ((notice: SpurNotice) => void | Promise<void>) | undefined;
}

/** A single Spur source. State is scoped to this adapter instance, never shared across daemons. */
export function createSpurAdapter(options: SpurAdapterOptions): Adapter {
  const base = new URL(`${options.baseUrl.replace(/\/$/, '')}/`);
  const fetchImpl = options.fetch ?? fetch;
  let health = new Map<string, HealthObservation>();
  let instanceId: string | undefined;
  const unknownHealthValues = new Set<string>();
  const unknownStatusValues = new Set<string>();
  const isKnownHealth = (value: string) => SESSION_HEALTH_STATES.some((state) => state === value);
  const isKnownStatus = (value: string) => SESSION_STATUSES.some((status) => status === value);

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
      const observedAt = new Date(options.now()).toISOString();
      const { response: listResponse, body: listBody } = await request('sessions', ctx.signal);
      if (!listResponse.ok) {
        throw classifyHttpFailure(
          { status: listResponse.status, headers: listResponse.headers },
          options.now(),
        );
      }
      const listed = parseWire(z.array(sessionWire), listBody, 'Invalid Spur response');
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
            options.now(),
          );
        }
        const wire = parseWire(sessionWire, body, 'Invalid Spur response');
        if (wire.id !== ref.id) {
          throw new AdapterError('transient', 'Unresolved Spur session detail');
        }
        detail.set(ref.id, wire);
      }
      if (ctx.signal.aborted) throw new Error('Spur poll aborted');
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
      for (const wire of listed) {
        const state = smooth(wire, observedAt, previous.get(wire.id));
        next.set(wire.id, state);
        items.push({ kind: 'session', facts: facts(wire, observedAt, state, null) });
      }
      for (const wire of detail.values()) {
        if (wire === null) continue;
        const state = smooth(wire, observedAt, previous.get(wire.id));
        const endReason =
          wire.status === 'completed' ? 'complete' : wire.status === 'killed' ? 'kill' : null;
        if (endReason === null) next.set(wire.id, state);
        items.push({
          kind: 'session',
          facts: facts(wire, observedAt, state, endReason),
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
