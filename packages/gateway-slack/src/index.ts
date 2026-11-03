import type { Gateway } from '@spur-board/contracts';
import { createApi, type ApiConfig } from './api.ts';
import { createDeliveryGateway, type SlackChannels } from './deliver.ts';

interface SlackGatewayConfig extends ApiConfig {
  channels: SlackChannels;
}

/** Create the outbound Slack gateway; inbound methods are completed by a later issue. */
export function createSlackGateway(config: SlackGatewayConfig): Gateway {
  return createDeliveryGateway(createApi(config), config.channels);
}
