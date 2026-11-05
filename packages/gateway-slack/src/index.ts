import type { Gateway } from '@spur-board/contracts';
import { apiFailure, createApi, type ApiConfig } from './api.ts';
import { createDeliveryGateway, type SlackChannels } from './deliver.ts';
import { parseInteractionRef, type BotIdentity } from './normalize.ts';
import { recoverThreads } from './recover.ts';
import { MAX_PART_TEXT, renderText, splitText } from './render.ts';
import { createSocket } from './socket.ts';

interface SlackGatewayConfig extends ApiConfig {
  channels: SlackChannels;
  appToken?: string;
  command?: string;
}

/** Create a Slack gateway. Socket Mode is opt-in until the daemon has a real inbound sink. */
export function createSlackGateway(config: SlackGatewayConfig): Gateway {
  const api = createApi(config);
  let identity: Promise<BotIdentity> | undefined;
  function botIdentity(): Promise<BotIdentity> {
    identity ??= api.auth
      .test()
      .then((result) => {
        if (typeof result.user_id !== 'string' || result.user_id.length === 0) {
          throw new Error('Slack bot identity unavailable');
        }
        return {
          userId: result.user_id,
          ...(typeof result.bot_id === 'string' ? { botId: result.bot_id } : {}),
        };
      })
      .catch(() => {
        identity = undefined;
        throw new Error('Slack bot identity unavailable');
      });
    return identity;
  }

  const delivery = createDeliveryGateway(api, config.channels);
  const socket = createSocket(api, config, botIdentity);
  return {
    ...delivery,
    ...socket,
    recover: (request) => recoverThreads(api, request, botIdentity),
    async respond(interaction, text, options) {
      const addressed = parseInteractionRef(interaction);
      const rendered = renderText(text);
      const pointer = options.cliHint === undefined ? '' : `\n\nMore: ${options.cliHint} (CLI)`;
      const body =
        rendered.length <= MAX_PART_TEXT
          ? rendered
          : `${splitText(rendered, MAX_PART_TEXT - pointer.length)?.[0] ?? ''}${pointer}`;
      if (addressed === null || body.length === 0) return 'dropped';
      try {
        const response = await api.chat.postEphemeral({
          channel: addressed.channel,
          user: addressed.user,
          text: body,
        });
        return response.ok ? 'sent' : 'dropped';
      } catch (error) {
        if (options.private) {
          const result = apiFailure(error);
          if (result.status === 'failed' && result.scope === 'message') return 'dropped';
        }
        throw new Error('Slack ephemeral response failed');
      }
    },
  };
}
