import type { Config, ConnectionState, Gateway } from '@spur-board/contracts';
import { plainHttpAllowed } from '@spur-board/contracts';
import {
  createSender,
  expirePendingTokens,
  reconcileDueDoorbells,
  type SpurPort,
  type Store,
} from '@spur-board/core';
import { ConfigError } from './config.ts';
import type { Module, ModuleContext } from './lifecycle.ts';
import { createJob } from './scheduler.ts';
import { createSpurPort } from './spur-port.ts';

const TICK_MS = 1000;
const TICK_JITTER_MS = 100;
// Leave time to record a timed-out request before the daemon's 10-second shutdown deadline.
const DELIVERY_REQUEST_TIMEOUT_MS = 8_000;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;

export interface SlackSettings {
  token: string;
  appToken?: string;
  channels: { orchestrators: string; feed: string };
  command: string;
  apiUrl?: string;
  requestTimeoutMs: number;
}

/** An entirely absent Slack setup keeps the daemon usable without a gateway. */
export function slackSettings(
  config: Config,
  secrets: Readonly<Record<string, string>>,
): SlackSettings | null {
  const token = secrets['SLACK_BOT_TOKEN'];
  const appToken = secrets['SLACK_APP_TOKEN'];
  const apiUrl = secrets['SLACK_API_URL'];
  const { orchestrators, feed } = config.slack.channels;
  if (
    token === undefined &&
    apiUrl === undefined &&
    orchestrators === undefined &&
    feed === undefined
  )
    return null;
  if (!token) throw new ConfigError('SLACK_BOT_TOKEN is required for Slack delivery');
  if (!orchestrators) throw new ConfigError('slack.channels.orchestrators is required');
  if (!feed) throw new ConfigError('slack.channels.feed is required');
  if (!CHANNEL_ID.test(orchestrators))
    throw new ConfigError('slack.channels.orchestrators must be a Slack channel ID');
  if (!CHANNEL_ID.test(feed))
    throw new ConfigError('slack.channels.feed must be a Slack channel ID');
  if (apiUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new ConfigError('SLACK_API_URL must be an HTTP(S) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new ConfigError('SLACK_API_URL must be an HTTP(S) URL');
    if (!plainHttpAllowed(url))
      throw new ConfigError(
        'SLACK_API_URL must use https:; http: is allowed only on a loopback host (localhost, 127.0.0.0/8, ::1) because it receives the Slack bot token',
      );
  }
  return {
    token,
    command: config.slack.command,
    ...(appToken === undefined ? {} : { appToken }),
    channels: { orchestrators, feed },
    ...(apiUrl === undefined ? {} : { apiUrl }),
    requestTimeoutMs: DELIVERY_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Own the outbox, token-expiry and doorbell jobs, each logging its own failure, and wait for
 * their active runs and every queued connection update before the store closes.
 */
export function createOutboxModule(
  ctx: ModuleContext<Store>,
  gateway?: Gateway,
  options: { spur?: SpurPort; tickMs?: number; jitterMs?: number } = {},
): Module & {
  /** Reconciles due doorbells, then runs one sender tick behind any active one. */
  pulse(): Promise<void>;
  /** Records a gateway connection change; logs its own failure and ignores events after stop. */
  connection(state: ConnectionState): Promise<void>;
} {
  const spur = options.spur ?? createSpurPort({ baseUrl: ctx.config.adapters.spur.baseUrl });
  const sender = createSender({
    store: ctx.store,
    ...(gateway === undefined ? {} : { gateway }),
    config: ctx.config,
    spur: { send: (session, text) => ctx.logCall('spur.send', () => spur.send(session, text)) },
    now: () => new Date(ctx.clock.now()),
  });
  const every = {
    intervalMs: options.tickMs ?? TICK_MS,
    jitterMs: options.jitterMs ?? TICK_JITTER_MS,
  };
  const outbox = createJob({
    ...every,
    run: (signal) => ctx.logCall('outbox.tick', () => sender.tick(signal)),
    // logCall has already logged the failure.
    onError: () => undefined,
  });
  const tokens = createJob({
    ...every,
    run: () => expirePendingTokens(ctx.store, ctx.config, new Date(ctx.clock.now())),
    onError: (err) => {
      ctx.log.error({ err }, 'token expiry failed');
    },
  });
  const doorbells = createJob({
    ...every,
    run: () => reconcileDueDoorbells(ctx.store, ctx.config, new Date(ctx.clock.now())),
    onError: (err) => {
      ctx.log.error({ err }, 'doorbell reconcile failed');
    },
  });
  const jobs = [tokens, doorbells, outbox];
  let updating: Promise<void> = Promise.resolve();
  let stopped = false;
  return {
    async start(signal) {
      await sender.recover();
      if (signal.aborted) return;
      await Promise.all(jobs.map((job) => job.start(signal)));
    },
    async stop() {
      stopped = true;
      await Promise.all(jobs.map((job) => job.stop()));
      await updating;
    },
    async pulse() {
      await doorbells.trigger();
      await outbox.trigger();
    },
    connection(state) {
      if (stopped) return Promise.resolve();
      const update = sender
        .recordConnection(state, new Date(ctx.clock.now()))
        .catch((err: unknown) => {
          ctx.log.error({ err }, 'transport state update failed');
        });
      updating = Promise.all([updating, update]).then(() => undefined);
      return update;
    },
  };
}
