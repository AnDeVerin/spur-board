import type { Config, Gateway } from '@spur-board/contracts';
import { createSender, type Store } from '@spur-board/core';
import { ConfigError } from './config.ts';
import type { Module, ModuleContext } from './lifecycle.ts';
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
  }
  return {
    token,
    ...(appToken === undefined ? {} : { appToken }),
    channels: { orchestrators, feed },
    ...(apiUrl === undefined ? {} : { apiUrl }),
    requestTimeoutMs: DELIVERY_REQUEST_TIMEOUT_MS,
  };
}

/** Own the timer and wait for the last queued sender tick before the store closes. */
export function createOutboxModule(ctx: ModuleContext<Store>, gateway: Gateway): Module {
  const spur = createSpurPort();
  const sender = createSender({
    store: ctx.store,
    gateway,
    spur: { send: (session, text) => ctx.logCall('spur.send', () => spur.send(session, text)) },
    now: () => new Date(ctx.clock.now()),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  let signal: AbortSignal | undefined;
  const schedule = (): void => {
    if (stopped || signal?.aborted) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        tick();
      },
      TICK_MS + Math.floor(Math.random() * TICK_JITTER_MS),
    );
  };
  const tick = (): void => {
    if (stopped || signal?.aborted) return;
    active = ctx
      .logCall('outbox.tick', () => sender.tick(signal))
      .catch(() => undefined)
      .finally(() => {
        schedule();
      });
  };
  return {
    async start(startSignal) {
      signal = startSignal;
      await sender.recover();
      if (signal.aborted) return;
      tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await active;
    },
  };
}
