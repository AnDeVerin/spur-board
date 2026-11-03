import type { Config, Gateway } from '@spur-board/contracts';
import { createSender, type Store } from '@spur-board/core';
import { ConfigError } from './config.ts';
import type { Module, ModuleContext } from './lifecycle.ts';
import { createSpurPort } from './spur-port.ts';

const TICK_MS = 1000;

export interface SlackSettings {
  token: string;
  channels: { orchestrators: string; feed: string };
  apiUrl?: string;
}

/** An entirely absent Slack setup keeps the daemon usable without a gateway. */
export function slackSettings(
  config: Config,
  secrets: Readonly<Record<string, string>>,
): SlackSettings | null {
  const token = secrets['SLACK_BOT_TOKEN'];
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
  return { token, channels: { orchestrators, feed }, ...(apiUrl === undefined ? {} : { apiUrl }) };
}

/** Own the timer and wait for the last queued sender tick before the store closes. */
export function createOutboxModule(ctx: ModuleContext<Store>, gateway: Gateway): Module {
  const sender = createSender({
    store: ctx.store,
    gateway,
    spur: createSpurPort(),
    now: () => new Date(ctx.clock.now()),
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  let signal: AbortSignal | undefined;
  const tick = (): void => {
    if (stopped || signal?.aborted) return;
    active = sender.tick().catch((err: unknown) => {
      ctx.log.error({ err }, 'outbox tick failed');
    });
  };
  return {
    async start(startSignal) {
      signal = startSignal;
      await sender.recover();
      if (signal.aborted) return;
      tick();
      timer = setInterval(tick, TICK_MS);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await active;
    },
  };
}
