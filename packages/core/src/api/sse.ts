import { PassThrough } from 'node:stream';
import { RESERVED_PROJECT, type ActorId, type Config } from '@spur-board/contracts';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';
import { CommandError } from '../app/commands.ts';
import { visibleProjects } from '../app/task-queries.ts';
import type { Tables } from '../store/schema.ts';

const POLL_MS = 300;
const HEARTBEAT_MS = 15_000;
const STATUS_MS = 30_000;
const END_GRACE_MS = 1_000;
const MAX_STREAMS = 32;
const BATCH = 500;

type StatusOutput = z.output<typeof statusOutputSchema>;
type StatusFrame = Pick<
  StatusOutput,
  'warmingUp' | 'spurUnavailable' | 'hostLoad' | 'transport' | 'sources'
>;

/** One open stream as the hub sees it; the route adapter owns the response. */
export interface EventSink {
  /** False when the client is not reading: the hub skips frames until `drain`. */
  write(chunk: string): boolean;
  /** Ends the stream; resolves when the response closed. */
  end(): Promise<void>;
  /** Destroys the response; resolves when it closed. */
  destroy(): Promise<void>;
  once(event: 'drain', listener: () => void): void;
}

interface Subscriber {
  readonly caller: ActorId;
  readonly sink: EventSink;
  readonly visible: ReadonlySet<string>;
  blocked: boolean;
  skipped: boolean;
  done: boolean;
}

export interface EventHub {
  /** `'full'` when the hub holds `MAX_STREAMS` streams or is closing. */
  subscribe(
    caller: ActorId,
    lastId: string | undefined,
    sink: EventSink,
  ): Promise<'full' | { unsubscribe(): void }>;
  /** Ends every stream; never waits on a client longer than `END_GRACE_MS`. */
  close(): Promise<void>;
}

function frame(event: string, head: number, data: object): string {
  return `event: ${event}\nid: ${String(head)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Tails the journal for open web streams: one poll every `POLL_MS` while any stream is open,
 * one `invalidate` per read batch, filtered per caller. Reads only through `db`, never inside
 * a transaction, so it sees committed rows only.
 */
export function createEventHub(options: {
  db: Kysely<Tables>;
  config: Config;
  instance: string;
  /** The full `status.get` output for the caller; the hub picks the status frame fields. */
  readStatus: (caller: ActorId) => Promise<StatusFrame>;
  onError?: ((entry: { err: unknown; step: 'poll' | 'status' }) => void) | undefined;
}): EventHub {
  const subscribers = new Set<Subscriber>();
  let pending = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let cursor = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let statusRound: Promise<void> | undefined;
  const isClosed = (): boolean => closed;
  const idle = (): boolean => closed || subscribers.size === 0;

  async function readHead(): Promise<number> {
    const row = await options.db
      .selectFrom('event')
      .select(sql<number | null>`max(id)`.as('head'))
      .executeTakeFirst();
    return row?.head ?? 0;
  }

  function send(subscriber: Subscriber, chunk: string): void {
    if (isClosed() || subscriber.done) return;
    if (subscriber.blocked) {
      subscriber.skipped = true;
      return;
    }
    if (subscriber.sink.write(chunk)) return;
    subscriber.blocked = true;
    subscriber.sink.once('drain', () => {
      subscriber.blocked = false;
      if (!subscriber.skipped) return;
      subscriber.skipped = false;
      send(subscriber, frame('reset', cursor, { head: cursor }));
    });
  }

  function deliver(rows: { id: number; project: string; key: string | null }[]): void {
    const head = rows.at(-1)?.id ?? cursor;
    for (const subscriber of subscribers) {
      const projects = new Set<string>();
      const tasks = new Set<string>();
      for (const row of rows) {
        if (!subscriber.visible.has(row.project)) continue;
        projects.add(row.project);
        if (row.key !== null) tasks.add(row.key);
      }
      if (projects.size === 0) continue;
      send(
        subscriber,
        frame('invalidate', head, { head, projects: [...projects], tasks: [...tasks] }),
      );
    }
  }

  async function poll(): Promise<void> {
    while (!idle()) {
      let rows: { id: number; project: string; key: string | null }[];
      try {
        rows = await options.db
          .selectFrom('event')
          .leftJoin('task', 'task.id', 'event.task_id')
          .select(['event.id as id', 'event.project as project', 'task.key as key'])
          .where('event.id', '>', cursor)
          .orderBy('event.id')
          .limit(BATCH)
          .execute();
      } catch (err) {
        options.onError?.({ err, step: 'poll' });
        return;
      }
      const last = rows.at(-1);
      if (last === undefined) return;
      cursor = Math.max(cursor, last.id);
      if (isClosed()) return;
      deliver(rows);
      if (rows.length < BATCH) return;
    }
  }

  function armPoll(): void {
    if (idle() || pollTimer !== undefined || polling !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      polling = poll().finally(() => {
        polling = undefined;
        armPoll();
      });
    }, POLL_MS);
  }

  function armHeartbeat(): void {
    if (idle() || heartbeatTimer !== undefined) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      for (const subscriber of subscribers) send(subscriber, ': heartbeat\n\n');
      armHeartbeat();
    }, HEARTBEAT_MS);
  }

  async function readStatuses(): Promise<void> {
    const callers = new Set([...subscribers].map((subscriber) => subscriber.caller));
    for (const caller of callers) {
      if (idle()) return;
      let status: StatusFrame;
      try {
        status = await options.readStatus(caller);
      } catch (err) {
        options.onError?.({ err, step: 'status' });
        continue;
      }
      const { warmingUp, spurUnavailable, hostLoad, transport, sources } = status;
      const chunk = `event: status\ndata: ${JSON.stringify({ warmingUp, spurUnavailable, hostLoad, transport, sources })}\n\n`;
      for (const subscriber of subscribers)
        if (subscriber.caller === caller) send(subscriber, chunk);
    }
  }

  function armStatus(): void {
    if (idle() || statusTimer !== undefined || statusRound !== undefined) return;
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      statusRound = readStatuses().finally(() => {
        statusRound = undefined;
        armStatus();
      });
    }, STATUS_MS);
  }

  function stopTimers(): void {
    clearTimeout(pollTimer);
    clearTimeout(heartbeatTimer);
    clearTimeout(statusTimer);
    pollTimer = heartbeatTimer = statusTimer = undefined;
  }

  async function shut(subscriber: Subscriber): Promise<void> {
    subscriber.done = true;
    if (subscriber.blocked) {
      await subscriber.sink.destroy();
      return;
    }
    let grace: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      subscriber.sink.end().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        grace = setTimeout(() => {
          resolve(false);
        }, END_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    if (!ended) await subscriber.sink.destroy();
  }

  return {
    async subscribe(caller, lastId, sink) {
      if (isClosed() || subscribers.size + pending >= MAX_STREAMS) return 'full';
      pending += 1;
      let head: number;
      try {
        head = await readHead();
      } finally {
        pending -= 1;
      }
      // The hub may have started closing during the read.
      if (isClosed()) return 'full';
      const subscriber: Subscriber = {
        caller,
        sink,
        visible: new Set([...visibleProjects(options.config, caller), RESERVED_PROJECT]),
        blocked: false,
        skipped: false,
        done: false,
      };
      const first = subscribers.size === 0;
      subscribers.add(subscriber);
      if (first) {
        cursor = Math.max(cursor, head);
        armPoll();
        armHeartbeat();
        armStatus();
      }
      send(subscriber, frame('hello', head, { head, instance: options.instance }));
      if (lastId !== undefined && lastId !== '' && (!/^\d+$/.test(lastId) || Number(lastId) > head))
        send(subscriber, frame('reset', head, { head }));
      return {
        unsubscribe() {
          subscriber.done = true;
          if (!subscribers.delete(subscriber)) return;
          if (subscribers.size === 0) stopTimers();
        },
      };
    },
    close() {
      closing ??= (async () => {
        closed = true;
        stopTimers();
        const open = [...subscribers];
        subscribers.clear();
        await Promise.all([...open.map(shut), polling, statusRound]);
      })();
      return closing;
    },
  };
}

/**
 * `GET /v1/events` on the web listener: an SSE stream fed by `hub`. The listener's `onRequest`
 * guard has already checked Host and fetch metadata; the route adds the Origin check.
 */
export function installEventStream(
  app: FastifyInstance,
  options: {
    hub: EventHub;
    ready: () => boolean;
    stopping?: (() => boolean) | undefined;
    origin: () => string | undefined;
    /** Logs the request at most once; called when the response closes. */
    audit: (request: FastifyRequest, reply: FastifyReply) => void;
  },
): void {
  app.get('/v1/events', { exposeHeadRoute: false }, async (request, reply) => {
    const browserOrigin = request.headers.origin;
    if (browserOrigin !== undefined && browserOrigin !== options.origin())
      throw new CommandError('forbidden', 'Use the configured web origin.');
    if (!options.ready())
      throw new CommandError(
        options.stopping?.() === true ? 'stopping' : 'starting',
        'Wait until the daemon is ready.',
      );
    const raw = reply.raw;
    // A finished stream also reaches `onResponse`; `audit` logs each request once.
    raw.once('close', () => {
      options.audit(request, reply);
    });
    const closed = new Promise<void>((resolve) => {
      if (raw.destroyed) resolve();
      else
        raw.once('close', () => {
          resolve();
        });
    });
    const pass = new PassThrough();
    // Fastify may destroy `pass` when the response closes, before the hub unsubscribes.
    const writable = (): boolean => !pass.writableEnded && !pass.destroyed;
    const sink: EventSink = {
      write: (chunk) => (writable() ? pass.write(chunk) : true),
      end() {
        if (writable()) pass.end();
        return closed;
      },
      destroy() {
        raw.destroy();
        return closed;
      },
      once(event, listener) {
        pass.once(event, listener);
      },
    };
    const lastId = request.headers['last-event-id'];
    const subscription = await options.hub.subscribe(
      'operator',
      typeof lastId === 'string' ? lastId : undefined,
      sink,
    );
    if (subscription === 'full')
      return reply
        .code(503)
        .header('retry-after', '5')
        .type('text/plain; charset=utf-8')
        .send('Too many open event streams: close a board tab or retry later.');
    if (raw.destroyed) subscription.unsubscribe();
    else
      raw.once('close', () => {
        subscription.unsubscribe();
      });
    return reply
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(pass);
  });
}
