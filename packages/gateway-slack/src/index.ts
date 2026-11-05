import type { Gateway } from '@spur-board/contracts';
import { apiFailure, createApi, type ApiConfig } from './api.ts';
import { createDeliveryGateway, type SlackChannels } from './deliver.ts';
import { parseInteractionRef, type BotIdentity } from './normalize.ts';
import { recoverThreads } from './recover.ts';
import { renderResponse } from './render.ts';
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
      const rendered = renderResponse(text, options.cliHint);
      if (addressed === null || rendered.text.length === 0) return 'dropped';
      try {
        // The Web API accepts mrkdwn=false although the SDK's ephemeral type omits it.
        const payload = {
          channel: addressed.channel,
          user: addressed.user,
          text: rendered.text,
          blocks: rendered.blocks,
          mrkdwn: false,
          parse: 'none' as const,
          link_names: false,
        };
        const response = await api.chat.postEphemeral(payload);
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
